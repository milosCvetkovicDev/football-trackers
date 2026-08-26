/**
 * Self-contained, hardware-free end-to-end test.
 *
 * Spawns a real, AUTHENTICATED mosquitto broker + the real server, then drives the
 * full secured path and asserts it:
 *   - MQTT publish (authed as the player) -> validate -> enrich (serverTs/session/player)
 *     -> WS fan-out (to an AUTHENTICATED coach socket) -> bun:sqlite persist
 *   - the fix<2 drop rule
 *   - the Minimum Safe Increment (board review 2026-06-14):
 *       * WS /live requires a valid session cookie (a no-cookie socket gets nothing; Phase 2 — the
 *         coach authenticates with a named login over HTTP, then the cookie rides the WS upgrade)
 *       * server rejects body/topic id mismatch (dropped{reason="id_mismatch"})
 *       * per-device MQTT ACL stops spoofing    (player "01" cannot publish to player "02")
 *
 *   bun run test/e2e.ts      (or: bun run test:e2e)
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up child processes.
 */

import { Database } from 'bun:sqlite';
import mqtt from 'mqtt';
import { existsSync, rmSync } from 'node:fs';

const PORT = 3101;
const METRICS_PORT = 9465;
const MQTT_URL = 'mqtt://127.0.0.1:1883';
const DB_PATH = '/tmp/ft-e2e.db';
const SESSION = 'test';
const TOPIC_01 = `football-trackers/session/${SESSION}/player/01/telemetry`;
const TOPIC_02 = `football-trackers/session/${SESSION}/player/02/telemetry`;

// Broker auth material for this run (per-device MQTT accounts + ACLs — unchanged from before).
const INGEST_PW = 'ingest-pw';
const PLAYER01_PW = 'player01-pw';

// Coach auth material (Phase 2): a named login → HttpOnly session cookie that rides the /live upgrade.
// The bundled shared LIVE_TOKEN is gone; the coach is provisioned via auth-user.ts and assigned to SESSION.
const ORIGIN = 'http://localhost:5173';
const COACH = 'coach-e2e';
const COACH_PW = 'coach-e2e-pw';
const ACCOUNTS_FILE = '/tmp/ft-e2e-accounts.json';
// With AUTH_COOKIE_SECURE=false the cookie name is 'ft_session' (no __Host- prefix). See server/src/auth.ts.
const COOKIE_NAME = 'ft_session';

const PW_FILE = '/tmp/ft-e2e-passwd';
const ACL_FILE = '/tmp/ft-e2e-acl';
const CONF_FILE = '/tmp/ft-e2e-mosquitto.conf';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// Fresh DB + broker auth files + accounts file each run.
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, PW_FILE, ACL_FILE, ACCOUNTS_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => {
  try { c.kill(); } catch { /* already gone */ }
});

let pub: mqtt.MqttClient | undefined;
let ws: WebSocket | undefined;
let unauth: WebSocket | undefined;

try {
  // --- 1. broker auth material: an 'ingest' account + a player "01" account ---------
  const passwdBin = Bun.which('mosquitto_passwd') ?? 'mosquitto_passwd';
  const accounts: ReadonlyArray<readonly [string, string, boolean]> = [
    ['ingest', INGEST_PW, true],   // -c creates the file
    ['01', PLAYER01_PW, false],    // append
  ];
  for (const [user, pw, create] of accounts) {
    const args = create ? ['-b', '-c', PW_FILE, user, pw] : ['-b', PW_FILE, user, pw];
    const code = await Bun.spawn([passwdBin, ...args], { stdout: 'ignore', stderr: 'ignore' }).exited;
    assert(code === 0, `mosquitto_passwd failed for "${user}" (exit ${code})`);
  }
  // username == PLAYER_ID, so the %u pattern scopes each device to its own topic.
  await Bun.write(
    ACL_FILE,
    'user ingest\n' +
    'topic read football-trackers/#\n\n' +
    'pattern write football-trackers/session/+/player/%u/telemetry\n' +
    'pattern write football-trackers/session/+/player/%u/status\n',
  );
  await Bun.write(
    CONF_FILE,
    'listener 1883 127.0.0.1\n' +
    'message_size_limit 1024\n' +   // the shipped broker bound; the server enforces its own copy too
    'allow_anonymous false\n' +
    `password_file ${PW_FILE}\n` +
    `acl_file ${ACL_FILE}\n`,
  );
  const mosquittoBin = Bun.which('mosquitto') ?? 'mosquitto';
  const broker = Bun.spawn([mosquittoBin, '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' });
  children.push(broker);

  // --- 1b. provision the coach account via the CLI (password piped to stdin; assigned to SESSION) ----
  const addCoach = Bun.spawn(
    ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION],
    {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );
  addCoach.stdin.write(`${COACH_PW}\n`);
  await addCoach.stdin.end();
  assert((await addCoach.exited) === 0, 'auth-user.ts add (coach) failed');

  // --- 2. server (the real artifact) — authenticates to the broker, gates /live on the cookie --------
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      MQTT_USERNAME: 'ingest', MQTT_PASSWORD: INGEST_PW,
      // Phase 2 auth: named accounts + non-Secure cookie (localhost) + strict Origin allow-list.
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE,
      AUTH_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: ORIGIN,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.push(server);

  // --- 3. wait until server is up AND subscribed (proves ingest authed to the broker) -
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/health`);
      const body = (await res.json()) as { ok: boolean; mqtt: boolean };
      if (body.ok && body.mqtt) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  assert(ready, 'server did not become ready (HTTP up + MQTT subscribed as ingest) in 10s');

  // --- 4. publisher authenticates as player "01" -----------------------------------
  pub = mqtt.connect(MQTT_URL, { username: '01', password: PLAYER01_PW });
  await new Promise<void>((res, rej) => {
    pub!.on('connect', () => res());
    pub!.on('error', rej);
    setTimeout(() => rej(new Error('publisher MQTT connect timeout')), 8000);
  });

  // --- 5. WS auth (Phase 2): the coach logs in over HTTP to mint the session cookie ---
  const okLogin = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(okLogin.status === 200, `coach login should be 200, got ${okLogin.status}`);
  const cookieLine = okLogin.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
  assert(cookieLine !== undefined, `login must Set-Cookie ${COOKIE_NAME}=`);
  const cookie = cookieLine!.split(';')[0].trim(); // verbatim "name=value" to replay on the upgrade

  // a NO-COOKIE coach socket must receive nothing (still sends Origin → reaches the auth gate: reason="auth")
  unauth = new WebSocket(`ws://127.0.0.1:${PORT}/live?sessionId=${SESSION}`, {
    headers: { origin: ORIGIN },
  } as unknown as string[]);
  const unauthMsgs: unknown[] = [];
  unauth.onmessage = (ev) => { if (typeof ev.data === 'string') unauthMsgs.push(JSON.parse(ev.data)); };
  unauth.onerror = () => { /* expected: server closes it */ };
  await sleep(400); // let the server reject it

  // authorized coach socket: the session cookie + Origin ride the upgrade (cookie auto-attached in a browser)
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/live?sessionId=${SESSION}`, {
    headers: { cookie, origin: ORIGIN },
  } as unknown as string[]);
  const received: any[] = [];
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') received.push(JSON.parse(ev.data)); };
  await new Promise<void>((res, rej) => {
    ws!.onopen = () => res();
    ws!.onerror = () => rej(new Error('authorized WS connection error'));
    setTimeout(() => rej(new Error('WS open timeout')), 5000);
  });
  await sleep(300); // let the server-side open() subscribe to the room

  // --- 6. GOOD packet (authed, own topic) -> fan-out + persist -----------------------
  const good = {
    id: 'trk-01', pl: '01', ts: 1,
    lat: 44.8125, lon: 20.4612, spd: 3.2, hdg: 90,
    fix: 3, sats: 11, pdop: 1.2,
    // §0.1 guard: a stray name injected into the MQTT body must be STRIPPED by ingest's explicit
    // construction — it must never ride the WS fan-out into the client store (asserted below).
    displayName: 'Alex M.', name: 'Alex M.',
  };
  pub.publish(TOPIC_01, JSON.stringify(good), { qos: 0 });

  // NB every socket opens with a Phase-5 `hello` envelope (the server's clock — audit C-1), so select
  // the telemetry frame by EVENT rather than by position. Asserting on `received[0]` would pin the
  // frame ORDER, which is not part of the contract; the envelope kind is.
  for (let i = 0; i < 50 && !received.some((m) => m.event === 'telemetry'); i++) await sleep(100);
  const telemetryFrames = received.filter((m) => m.event === 'telemetry');
  assert(telemetryFrames.length === 1, `expected 1 telemetry envelope, got ${telemetryFrames.length} of ${received.length} frames`);

  // Count TELEMETRY frames, not all frames: the socket also carries the Phase-5 `hello` clock envelope.
  const telemetryCount = () => received.filter((m) => m.event === 'telemetry').length;
  const msg = telemetryFrames[0];
  assert(msg.event === 'telemetry', `envelope event was "${msg.event}"`);
  const d = msg.data;
  assert(d.sessionId === SESSION, `sessionId enriched wrong: ${d.sessionId}`);
  assert(d.playerId === '01', `playerId enriched wrong: ${d.playerId}`);
  assert(typeof d.serverTs === 'number' && d.serverTs > 0, 'serverTs missing/invalid');
  assert(d.lat === 44.8125 && d.lon === 20.4612, 'lat/lon corrupted in transit');
  assert(d.id === 'trk-01' && d.fix === 3, 'raw fields not preserved');
  // §0.1: the injected name fields must be GONE from the fan-out (ingest builds Telemetry from explicit fields).
  assert(!('displayName' in d) && !('name' in d), 'telemetry fan-out must not carry an injected name field (§0.1)');

  // the no-cookie socket must NOT have received the fan-out
  assert(unauthMsgs.length === 0, `no-cookie WS should get nothing, got ${unauthMsgs.length}`);

  // --- 7. id_mismatch: body pl "02" on player/01 topic -> dropped, not fanned out ----
  pub.publish(TOPIC_01, JSON.stringify({ ...good, pl: '02' }), { qos: 0 });
  await sleep(700);
  assert(telemetryCount() === 1, `id_mismatch packet should be dropped; got ${telemetryCount()} telemetry frames`);

  // --- 8. fix<2 -> dropped (no fan-out, no row) -------------------------------------
  pub.publish(TOPIC_01, JSON.stringify({ ...good, fix: 1 }), { qos: 0 });
  await sleep(700);
  assert(telemetryCount() === 1, `fix<2 packet should be dropped; got ${telemetryCount()} telemetry frames`);

  // --- 9. ACL anti-spoof: player "01" creds cannot publish to player "02"'s topic ----
  pub.publish(TOPIC_02, JSON.stringify({ ...good, pl: '02' }), { qos: 0 }); // broker denies
  await sleep(700);
  assert(telemetryCount() === 1, `ACL should block player-01 publishing to player-02; got ${telemetryCount()} telemetry frames`);

  // --- 9b. out-of-range coordinates -> dropped (no fan-out, no row) ------------------
  pub.publish(TOPIC_01, JSON.stringify({ ...good, lat: 999 }), { qos: 0 });
  await sleep(700);
  assert(telemetryCount() === 1, `out-of-range packet should be dropped; got ${telemetryCount()} telemetry frames`);

  // --- 10. persistence: exactly one row (only the good packet) ----------------------
  await sleep(200);
  const db = new Database(DB_PATH, { readonly: true });
  const { n } = db.query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number };
  assert(n === 1, `expected exactly 1 persisted row, got ${n}`);
  const row = db.query('SELECT * FROM telemetry').get() as any;
  assert(row.session_id === SESSION && row.player_id === '01', 'persisted session/player wrong');
  assert(row.fix === 3 && row.device_id === 'trk-01', 'persisted raw fields wrong');
  assert(typeof row.server_ts === 'number' && row.server_ts > 0, 'persisted server_ts wrong');
  db.close();

  // --- 11. observability: /metrics reflects exactly what happened -------------------
  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  const num = (re: RegExp): number | undefined => {
    const m = metricsText.match(re);
    return m ? Number(m[1]) : undefined;
  };
  // player 01 received id_mismatch + fix<2 + out_of_range = 3 under its own label; the GOOD packet was the
  // stream's FIRST, and `received` fires before validation, so it counted under `_other` — the admitting
  // packet itself is the one-packet accounting blur that keeps unvalidated traffic from reserving label
  // slots (see metrics.ts capLabelPeek). player 02 never reached the server (ACL).
  assert(num(/ft_telemetry_received_total\{[^}]*player="01"[^}]*\}\s+(\d+)/) === 3,
    'metrics: received_total{player="01"} should be 3 (the first/admitting packet counts under _other)');
  assert((num(/ft_telemetry_received_total\{[^}]*player="_other"[^}]*\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: the admitting packet is counted under player="_other"');
  assert(!/ft_telemetry_received_total\{[^}]*player="02"[^}]*\}/.test(metricsText),
    'metrics: player "02" must never have been received (ACL should have blocked it)');
  assert(num(/ft_telemetry_published_total\{[^}]*\}\s+(\d+)/) === 1,
    'metrics: published_total should be 1');
  assert(num(/ft_telemetry_dropped_total\{reason="no_fix"\}\s+(\d+)/) === 1,
    'metrics: dropped_total{no_fix} should be 1');
  assert(num(/ft_telemetry_dropped_total\{reason="id_mismatch"\}\s+(\d+)/) === 1,
    'metrics: dropped_total{id_mismatch} should be 1');
  assert(num(/ft_telemetry_dropped_total\{reason="out_of_range"\}\s+(\d+)/) === 1,
    'metrics: dropped_total{out_of_range} should be 1');
  // the no-cookie coach socket sent an Origin, so it cleared the origin gate and was rejected at AuthN.
  assert((num(/ft_ws_rejected_total\{reason="auth"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ws_rejected_total{auth} should be >= 1');
  assert(num(/ft_mqtt_connected\s+(\d+)/) === 1, 'metrics: mqtt_connected should be 1');
  assert(metricsText.includes('ft_ingest_duration_seconds_bucket'),
    'metrics: ingest latency histogram missing');
  assert(metricsText.includes('ft_build_info{'), 'metrics: build_info missing');
  // retention is wired into the live process: the data-minimisation gauge must be
  // present and small (the one persisted row was just stamped, ~0 s old).
  const oldestAge = num(/ft_oldest_raw_fix_age_seconds\s+([\d.]+)/);
  assert(oldestAge !== undefined && oldestAge >= 0 && oldestAge < 3600,
    `metrics: ft_oldest_raw_fix_age_seconds should be present and fresh, got ${oldestAge}`);
  // the purge counter is seeded present-at-0 at boot (the fresh row is not yet expired),
  // and the boot sweep stamps the liveness gauge — both must be exposed.
  assert(num(/^ft_retention_rows_purged_total\s+(\d+)/m) === 0,
    'metrics: ft_retention_rows_purged_total should be present-at-0 (nothing expired yet)');
  assert((num(/ft_retention_last_run_timestamp_seconds\s+([\d.]+)/) ?? 0) > 0,
    'metrics: ft_retention_last_run_timestamp_seconds should be stamped by the boot sweep');

  // /metrics must NOT be reachable on the public port (loopback-only, separate listener).
  const pubStatus = await fetch(`http://127.0.0.1:${PORT}/metrics`).then((r) => r.status).catch(() => 0);
  assert(pubStatus !== 200, `/metrics must not be served on the public port; got status ${pubStatus}`);

  // ═══ Phase 3 — boundary correctness (audit S-1, S-2, S-4, S-5) ═══════════════════════════════════
  const scrape = async (): Promise<string> => (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  /** Every sample line of an exposition must end in a finite decimal — never NaN/undefined/Infinity/text. */
  const assertWellFormed = (text: string, label: string): void => {
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const m = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})?\s+(\S+)$/.exec(line);
      assert(m !== null, `${label}: malformed exposition line: ${JSON.stringify(line)}`);
      assert(/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(m[2]), `${label}: non-numeric sample value in: ${JSON.stringify(line)}`);
    }
    assert(!/undefined|NaN|Infinity/.test(text.replace(/le="\+Inf"/g, '')), `${label}: exposition contains undefined/NaN/Infinity`);
  };

  // --- 12. (S-1) a device cannot inject into /metrics through a non-numeric wire field ----------------
  const rowsBefore = (new Database(DB_PATH, { readonly: true }).query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number }).n;
  const framesBefore = received.length;
  for (const bad of [
    { ...good, fix: '3\nft_injected_metric 999' },          // the audit's live injection
    { ...good, sats: '11' },                                  // numeric-looking string
    { ...good, pdop: null },                                  // missing/invalid optional field
    { ...good, hdg: 'NaN' },
    { ...good, lat: '44.8' },
    { ...good, ts: { $gt: 0 } },
  ]) pub.publish(TOPIC_01, JSON.stringify(bad), { qos: 0 });
  await sleep(600);
  assert(received.length === framesBefore, `(S-1) no non-numeric packet may reach the WS room; got ${received.length - framesBefore} extra frames`);
  const rowsAfter = (new Database(DB_PATH, { readonly: true }).query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number }).n;
  assert(rowsAfter === rowsBefore, `(S-1) no non-numeric packet may be persisted; rows ${rowsBefore} -> ${rowsAfter}`);
  // An oversized frame is bounded by the SERVER as well as the broker (a host-run broker may lack the limit).
  pub.publish(TOPIC_01, JSON.stringify({ ...good, pad: 'x'.repeat(4000) }), { qos: 0 });
  await sleep(300);
  let text = await scrape();
  assert(!/ft_injected_metric/.test(text), '(S-1) the injected metric line must not appear in /metrics');
  assertWellFormed(text, '(S-1)');
  assert((num(/ft_telemetry_dropped_total\{reason="bad_payload"\}\s+(\d+)/) ?? 0) >= 0, 'sanity');
  const badPayload = Number((text.match(/ft_telemetry_dropped_total\{reason="bad_payload"\}\s+(\d+)/) ?? [])[1] ?? 0);
  assert(badPayload >= 6, `(S-1) all six malformed packets must be counted as bad_payload, got ${badPayload}`);

  // --- 13. (S-2) a status frame from a skewed firmware (fields missing) must not poison the scrape -----
  const STATUS_01 = `football-trackers/session/${SESSION}/player/01/status`;
  const statusFramesBefore = received.filter((m) => m.event === 'status').length;
  pub.publish(STATUS_01, JSON.stringify({ id: 'trk-01', pl: '01', ts: 1, up: 12 }), { qos: 0 }); // no batt/pct/rssi/…
  pub.publish(STATUS_01, JSON.stringify({ id: 'trk-01', pl: '01', ts: 2, up: '12' }), { qos: 0 }); // up not a number → drop
  await sleep(600);
  text = await scrape();
  assertWellFormed(text, '(S-2)');
  assert(/ft_device_uptime_seconds\{[^}]*player="01"[^}]*\}\s+12$/m.test(text), '(S-2) the numeric field that WAS present is exported');
  assert(/ft_device_battery_percent\{[^}]*player="01"[^}]*\}\s+-1$/m.test(text), '(S-2) a missing battery percent is exported as the unmetered sentinel -1, not undefined');
  const statusFrames = received.filter((m) => m.event === 'status');
  assert(statusFrames.length === statusFramesBefore + 1, `(S-2) the skewed-but-valid status frame reaches coaches once, the invalid one never; got +${statusFrames.length - statusFramesBefore}`);
  const h = statusFrames[statusFrames.length - 1].data as Record<string, unknown>;
  for (const k of ['battPct', 'battVolts', 'rssi', 'fix', 'sats', 'backlogBytes', 'serverTs']) {
    assert(typeof h[k] === 'number' && Number.isFinite(h[k] as number), `(S-2) health envelope field ${k} must be a finite number, got ${JSON.stringify(h[k])}`);
  }

  // --- 14. (S-5) label cardinality is bounded: 500 novel session ids must not become 500 series --------
  // The ACL leaves the session segment as `+`, so one device can publish under any session id.
  for (let i = 0; i < 500; i++) {
    pub.publish(`football-trackers/session/junk-${i}/player/01/telemetry`, JSON.stringify({ ...good, fix: 0 }), { qos: 0 });
  }
  await sleep(1500);
  text = await scrape();
  const sessionLabels = new Set<string>();
  for (const m of text.matchAll(/^ft_telemetry_received_total\{[^}]*session="([^"]*)"[^}]*\}/gm)) sessionLabels.add(m[1]);
  assert(sessionLabels.size <= 33, `(S-5) 500 novel sessions must collapse into a bounded label set (≤ 33 incl. the overflow bucket), got ${sessionLabels.size}`);
  assert(sessionLabels.has(SESSION), '(S-5) the real session keeps its own label');
  // Admission is a privilege: the junk frames above had no fix, so they never validated — NONE of them may
  // reserve a label slot (32 junk publishes used to evict the real session into `_other` for the process
  // lifetime). Everything unadmitted reads `_other`.
  for (const l of sessionLabels) assert(l === SESSION || l === '_other',
    `(S-5) an unvalidated junk session must never claim its own label slot, found session="${l}"`);
  // …and a session that DOES produce a valid frame admits itself (bounded by the cap).
  pub.publish(`football-trackers/session/late-real/player/01/telemetry`, JSON.stringify(good), { qos: 0 });
  await sleep(400);
  text = await scrape();
  assert(/ft_fix_type\{[^}]*session="late-real"[^}]*\}/.test(text), '(S-5) a validated new session gets its own label');
  assert(/ft_fix_type\{[^}]*session="test"[^}]*\}\s+3$/m.test(text), '(S-5) the real session was not evicted by the flood');
  assertWellFormed(text, '(S-5)');

  // ═══ Phase 4 — field resilience, the server half (audit F-1/F-2 + the rate-cap raise) ═══════════════
  // These run BEFORE §15/§16 (they need the broker alive and the table present).
  // --- P4a. (F-1) crash-safe replay: a re-sent (player, device, seq) row is deduped, never double-counted
  const P4S = 'p4';
  const p4 = (sq: number, gts: number, lat = 44.8130): string => JSON.stringify({
    id: 'trk-01', pl: '01', ts: 1, lat, lon: 20.4615, spd: 2.0, hdg: 45, fix: 3, sats: 10, pdop: 1.1, sq, gts,
  });
  const p4db = () => new Database(DB_PATH, { readonly: true });
  const nowMs = Date.now();
  // A 60 s outage's backlog, replayed: 20 fixes whose gts SPANS the outage (audit F-2: they used to collapse
  // into ~1 s of arrival time, fabricating a teleport + a burst of "high-intensity efforts").
  for (let i = 0; i < 20; i++) pub.publish(`football-trackers/session/${P4S}/player/01/telemetry`, p4(100 + i, nowMs - 60_000 + i * 3_000), { qos: 0 });
  // The crash-mid-flush re-send: the same first 10 seqs again (the NVS cursor checkpoints every N records).
  for (let i = 0; i < 10; i++) pub.publish(`football-trackers/session/${P4S}/player/01/telemetry`, p4(100 + i, nowMs - 60_000 + i * 3_000), { qos: 0 });
  await sleep(1200);
  {
    const rows = p4db().query('SELECT server_ts AS t, seq FROM telemetry WHERE session_id = ? ORDER BY seq').all(P4S) as { t: number; seq: number }[];
    assert(rows.length === 20, `(F-1) 30 publishes with 10 duplicate seqs must persist exactly 20 rows, got ${rows.length}`);
    const seqs = new Set(rows.map((r) => r.seq));
    assert(seqs.size === 20, `(F-1) every (player, seq) must be unique, got ${seqs.size} distinct of ${rows.length}`);
    const spanMs = rows[rows.length - 1].t - rows[0].t;
    assert(spanMs > 50_000 && spanMs < 70_000,
      `(F-2) replayed rows must SPAN the outage (~57 s of gts spread), not collapse into arrival time — got ${Math.round(spanMs / 1000)} s`);
    assert(rows[0].t < nowMs - 50_000, `(F-2) the oldest replayed row keeps its GPS time, got ${rows[0].t} vs now ${nowMs}`);
  }
  // The dedupe key is (player, DEVICE, seq): a REPLACEMENT tracker (fresh NVS, same player, new MAC)
  // starts its sequence over — its fixes must NOT be swallowed by the dead device's retained rows.
  pub.publish(`football-trackers/session/${P4S}/player/01/telemetry`, JSON.stringify({
    id: 'trk-01-NEW', pl: '01', ts: 1, lat: 44.8130, lon: 20.4615, spd: 2.0, hdg: 45, fix: 3, sats: 10, pdop: 1.1, sq: 100, gts: nowMs - 1000,
  }), { qos: 0 });
  await sleep(400);
  {
    const n = (p4db().query('SELECT COUNT(*) AS n FROM telemetry WHERE session_id = ? AND seq = 100').get(P4S) as { n: number }).n;
    assert(n === 2, `(F-1) the same (player, seq) from a DIFFERENT device must persist (replacement tracker), got ${n} rows for seq 100`);
  }
  text = await scrape();
  const dupDropped = Number((text.match(/ft_telemetry_dropped_total\{reason="duplicate"\}\s+(\d+)/) ?? [])[1] ?? 0);
  assert(dupDropped === 10, `(F-1) the 10 same-device re-sent records must be counted as dropped{duplicate}, got ${dupDropped}`);
  const replayed = Number((text.match(/ft_telemetry_replayed_total\s+(\d+)/) ?? [])[1] ?? 0);
  assert(replayed >= 19, `(F-2) fixes stamped >5 s before arrival must count as replayed, got ${replayed}`);
  assertWellFormed(text, '(P4)');

  // --- P4b. the ingest rate CAP (not just the burst) sustains a paced backlog flush + live traffic —
  // they must land together: the firmware paces its flush at ~30 msg/s with live 10 Hz on top (~40/s
  // sustained), and the old cap of 15/s would have silently dropped the replay. A burst-sized test
  // passes on burst tokens alone (checker finding), so this runs LONGER than the burst window:
  // 270 packets at ~45/s ≈ 6 s. At cap 50 all are admitted; at the old cap 15 the bucket dries up
  // after ~2.6 s and ~½ would drop.
  {
    for (let i = 0; i < 270; i++) {
      pub.publish(`football-trackers/session/${P4S}/player/01/telemetry`, p4(300 + i, nowMs - 30_000 + i * 100), { qos: 0 });
      await sleep(21);
    }
    await sleep(1000);
    const n = (p4db().query('SELECT COUNT(*) AS n FROM telemetry WHERE session_id = ? AND seq >= 300').get(P4S) as { n: number }).n;
    assert(n === 270, `(P4) a ~45/s sustained replay+live load must be fully accepted (cap 50/s) — a cap regression to 15/s drops ~half; got ${n}/270`);
  }

  // --- 15. (S-4) /health tells the truth: 200 + ok while subscribed, 503 + mqtt:false within 5 s of broker loss
  const healthy = await fetch(`http://127.0.0.1:${METRICS_PORT}/health`);
  const hb = (await healthy.json()) as { ok: boolean; mqtt: boolean; db: boolean };
  assert(healthy.status === 200 && hb.ok && hb.mqtt && hb.db === true, `(S-4) healthy: expected 200 {ok,mqtt,db:true}, got ${healthy.status} ${JSON.stringify(hb)}`);
  broker.kill();
  let flipped = false;
  const tKill = Date.now();
  while (Date.now() - tKill < 5_000) {
    const r = await fetch(`http://127.0.0.1:${METRICS_PORT}/health`);
    const b = (await r.json()) as { ok: boolean; mqtt: boolean };
    if (b.mqtt === false) {
      assert(r.status === 503 && b.ok === false, `(S-4) once mqtt is down /health must be 503 {ok:false}, got ${r.status} ${JSON.stringify(b)}`);
      flipped = true;
      break;
    }
    await sleep(100);
  }
  assert(flipped, '(S-4) /health must flip to mqtt:false within 5 s of the broker dying (it used to latch true forever)');
  text = await scrape();
  assert(/^ft_mqtt_connected\s+0$/m.test(text), '(S-4) ft_mqtt_connected must read 0 after broker loss');

  // --- 16. (S-4) the db half is not vacuous: a dropped table must flip db:false (a SELECT 1 cannot fail) ---
  {
    const wrecker = new Database(DB_PATH);
    wrecker.exec('PRAGMA busy_timeout = 5000; DROP TABLE telemetry;');
    wrecker.close();
    const r = await fetch(`http://127.0.0.1:${METRICS_PORT}/health`);
    const b = (await r.json()) as { ok: boolean; db: boolean };
    assert(r.status === 503 && b.ok === false && b.db === false,
      `(S-4) with the telemetry table dropped /health must say db:false, got ${r.status} ${JSON.stringify(b)}`);
  }

  console.log('\n✅ E2E PASSED — authed broker, cookie-gated WS, id_mismatch + ACL spoof blocked, 1 row persisted, /metrics correct, '
    + 'wire fields coerced (no injection), skewed status harmless, session labels bounded, /health truthful');
  pub.end();
  ws.close();
  unauth.close();
  for (const f of [PW_FILE, ACL_FILE, CONF_FILE, ACCOUNTS_FILE]) { if (existsSync(f)) rmSync(f); }
  stop();
  process.exit(0);
} catch (err) {
  console.error('\n❌ E2E FAILED:', (err as Error).message);
  try { pub?.end(); } catch { /* noop */ }
  try { ws?.close(); } catch { /* noop */ }
  try { unauth?.close(); } catch { /* noop */ }
  stop();
  process.exit(1);
}
