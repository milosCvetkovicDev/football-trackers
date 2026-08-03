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

  for (let i = 0; i < 50 && received.length < 1; i++) await sleep(100);
  assert(received.length === 1, `expected 1 WS message, got ${received.length}`);

  const msg = received[0];
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
  assert(received.length === 1, `id_mismatch packet should be dropped; got ${received.length} messages`);

  // --- 8. fix<2 -> dropped (no fan-out, no row) -------------------------------------
  pub.publish(TOPIC_01, JSON.stringify({ ...good, fix: 1 }), { qos: 0 });
  await sleep(700);
  assert(received.length === 1, `fix<2 packet should be dropped; got ${received.length} messages`);

  // --- 9. ACL anti-spoof: player "01" creds cannot publish to player "02"'s topic ----
  pub.publish(TOPIC_02, JSON.stringify({ ...good, pl: '02' }), { qos: 0 }); // broker denies
  await sleep(700);
  assert(received.length === 1, `ACL should block player-01 publishing to player-02; got ${received.length}`);

  // --- 9b. out-of-range coordinates -> dropped (no fan-out, no row) ------------------
  pub.publish(TOPIC_01, JSON.stringify({ ...good, lat: 999 }), { qos: 0 });
  await sleep(700);
  assert(received.length === 1, `out-of-range packet should be dropped; got ${received.length} messages`);

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
  // player 01 received good + id_mismatch + fix<2 = 3; player 02 never reached the server (ACL).
  assert(num(/ft_telemetry_received_total\{[^}]*player="01"[^}]*\}\s+(\d+)/) === 4,
    'metrics: received_total{player="01"} should be 4');
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

  console.log('\n✅ E2E PASSED — authed broker, cookie-gated WS, id_mismatch + ACL spoof blocked, 1 row persisted, /metrics correct');
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
