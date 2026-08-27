/**
 * events-e2e.ts — endpoint + SLO test for GET /sessions/:id/events (ADR-0020, event-detection-contract §4/§5).
 *
 * The module test (test/events.ts) covers detector + readEvents correctness in isolation. THIS test drives the
 * real HTTP route on a live server and proves what only an e2e can:
 *   1. ENDPOINT authz + hygiene (§0.4): no-cookie + malformed id → 401 (auth before id-validity ⇒ no session-id
 *      oracle); bad Origin → 403; wrong-session → 403; same-origin GET with NO Origin → 200; opaque 400 with no
 *      echoed query value; Cache-Control: no-store on every response; team-AGGREGATE body (no playerId/name);
 *      detectorParams provenance present (PM-S6).
 *   2. THE ADR-0020 SLO + PM-1: over a PRE-SEEDED DB ≥ 270k rows, CONCURRENT events scans must NOT freeze live
 *      WS fan-out (ft_ws_messages_sent_total keeps rising), AND the SHARED off-loop inflight cap holds — firing
 *      more concurrent off-loop scans than OFFLOOP_MAX_INFLIGHT yields at least one 503 'busy'.
 *
 * Hardware-free: anonymous mosquitto + a tiny in-process publisher generate the live feed; a provisioned coach
 * gates the endpoint. Adult coach usernames + pseudonymous player ids only.
 *
 *   bun run test/events-e2e.ts   — exits 0 on success, 1 on any failed assertion.
 */

import mqtt from 'mqtt';
import { existsSync, rmSync } from 'node:fs';

const PORT = 3106;
const METRICS_PORT = 9470;
const BROKER_PORT = 1889;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = '/tmp/ft-events-e2e.db';
const ACCOUNTS_FILE = '/tmp/ft-events-e2e-accounts.json';
const CONF_FILE = '/tmp/ft-events-e2e-mosquitto.conf';

const ORIGIN = 'http://localhost:5173';
const SESSION = 'sessE';
const OTHER_SESSION = 'sessOtherE';
const COACH = 'coach-ev';
const COACH_PW = 'coach-ev-pw';
const COOKIE_NAME = 'ft_session';
const SEED_ROWS = 270_000; // SLO fixture floor — forces >= 270 keyset chunks (yields) at chunk 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
/** PB-N2: no-store must be present on EVERY response (the header is set before the gate in server.ts). */
const assertNoStore = (resp: Response, label: string): void =>
  assert((resp.headers.get('cache-control') ?? '').includes('no-store'), `no-store missing on ${label}`);

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONF_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => { try { c.kill(); } catch { /* gone */ } });
let pub: mqtt.MqttClient | undefined;
let feedTimer: ReturnType<typeof setInterval> | undefined;

function sumCounter(text: string, name: string): number {
  const re = new RegExp(`^${name}\\{[^}]*\\}\\s+(\\d+)`, 'gm');
  let total = 0;
  for (const m of text.matchAll(re)) total += Number(m[1]);
  const re2 = new RegExp(`^${name}\\s+(\\d+)`, 'gm');
  for (const m of text.matchAll(re2)) total += Number(m[1]);
  return total;
}
async function wsSent(): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  return sumCounter(text, 'ft_ws_messages_sent_total');
}

try {
  // --- 1. SEED the DB to >= 270k rows BEFORE the server opens it. -----------------------------------------
  process.env.DB_PATH = DB_PATH;
  const { db, insertTelemetry } = await import('../src/db');
  const now = Date.now();
  const WINDOW_MS = 2 * 60 * 60 * 1000;
  const seed = db.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      const player = String((i % 12) + 1).padStart(2, '0');
      insertTelemetry({
        id: `trk-${player}`, pl: player, playerId: player, sessionId: SESSION, ts: i,
        serverTs: now - WINDOW_MS + Math.floor((i / count) * WINDOW_MS),
        lat: 44.8122 + (i % 100) * 0.000005, lon: 20.4608 + (Math.floor(i / 100) % 100) * 0.000007,
        spd: 2 + (i % 6), hdg: (i * 7) % 360, fix: 3, sats: 11, pdop: 1.1,
      });
    }
  });
  const t0seed = performance.now();
  seed(SEED_ROWS);
  const seeded = (db.query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number }).n;
  assert(seeded >= SEED_ROWS, `fixture must seed >= ${SEED_ROWS} rows, got ${seeded}`);
  db.close();
  console.log(`[seed] ${seeded} rows in ${((performance.now() - t0seed) / 1000).toFixed(1)}s`);

  // --- 2. anonymous broker ------------------------------------------------------------------------------
  await Bun.write(CONF_FILE, `listener ${BROKER_PORT} 127.0.0.1\nallow_anonymous true\n`);
  const mosquittoBin = Bun.which('mosquitto') ?? 'mosquitto';
  children.push(Bun.spawn([mosquittoBin, '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' }));

  // --- 3. provision a coach assigned ONLY to SESSION ----------------------------------------------------
  const addCoach = Bun.spawn(
    ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION],
    { cwd: `${import.meta.dir}/..`, env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE }, stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' },
  );
  addCoach.stdin.write(`${COACH_PW}\n`);
  await addCoach.stdin.end();
  assert((await addCoach.exited) === 0, 'auth-user.ts add (coach) failed');

  // --- 4. the real server (secured cookie auth, anon OFF, strict Origin). --------------------------------
  const serverLog: string[] = [];
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE, AUTH_COOKIE_SECURE: 'false', ALLOWED_ORIGINS: ORIGIN, LOG_LEVEL: 'info',
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  children.push(server);
  void (async () => { for await (const chunk of server.stdout) serverLog.push(Buffer.from(chunk).toString()); })();
  void (async () => { for await (const chunk of server.stderr) serverLog.push(Buffer.from(chunk).toString()); })();

  // --- 5. wait until ready ------------------------------------------------------------------------------
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const b = (await (await fetch(`http://127.0.0.1:${METRICS_PORT}/health`)).json()) as { ok: boolean; mqtt: boolean };
      if (b.ok && b.mqtt) { ready = true; break; }
    } catch { /* not up */ }
    await sleep(100);
  }
  assert(ready, 'server did not become ready in 12s');

  // --- 6. coach login → cookie --------------------------------------------------------------------------
  const login = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(login.status === 200, `coach login should be 200, got ${login.status}`);
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))!.split(';')[0].trim();

  const ev = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { origin: ORIGIN, ...headers } });

  // --- 7. ENDPOINT authz matrix (§0.4) + Cache-Control (every path, PB-N2) + opaque errors ----------------
  // NO-ID-ORACLE, both sides (PB-N3): a no-cookie caller must get 401 for a MALFORMED id AND a WELL-FORMED id —
  // auth is checked before id-validity, so the two are indistinguishable (no 400-vs-401 session-id oracle).
  const noCookieBadId = await ev(`/sessions/${'bad id!!'}/events?from=0&to=${now}`);
  assert(noCookieBadId.status === 401, `no-cookie + bad id must be 401 (no id oracle), got ${noCookieBadId.status}`);
  assertNoStore(noCookieBadId, '401 (bad id)');
  const noCookieGoodId = await ev(`/sessions/${SESSION}/events?from=0&to=${now}`); // valid id, still no cookie
  assert(noCookieGoodId.status === 401, `no-cookie + VALID id must ALSO be 401 (closes the oracle), got ${noCookieGoodId.status}`);
  assertNoStore(noCookieGoodId, '401 (valid id)');

  const badOrigin = await fetch(`http://127.0.0.1:${PORT}/sessions/${SESSION}/events?from=0&to=${now}`, {
    headers: { origin: 'http://evil.example', cookie },
  });
  assert(badOrigin.status === 403, `bad Origin must be 403, got ${badOrigin.status}`);
  assertNoStore(badOrigin, '403 (bad origin)');

  const wrongSession = await ev(`/sessions/${OTHER_SESSION}/events?from=0&to=${now}`, { cookie });
  assert(wrongSession.status === 403, `wrong-session must be 403, got ${wrongSession.status}`);
  assertNoStore(wrongSession, '403 (wrong session)');

  // same-origin browser GET sends NO Origin header → must be 200 (tiny window so it doesn't rescan the seed).
  const noOrigin = await fetch(`http://127.0.0.1:${PORT}/sessions/${SESSION}/events?from=${now}&to=${now + 1}`, {
    headers: { cookie },
  });
  assert(noOrigin.status === 200, `same-origin GET with NO Origin must be 200, got ${noOrigin.status}`);
  assertNoStore(noOrigin, '200');

  // opaque 400: to<from → {error:'bad_params'} with no echoed query value.
  const badParams = await ev(`/sessions/${SESSION}/events?from=${now}&to=0`, { cookie });
  assert(badParams.status === 400, `to<from must be 400, got ${badParams.status}`);
  assertNoStore(badParams, '400 (bad params)');
  const badBody = await badParams.text();
  assert(badBody.includes('bad_params') && !badBody.includes(String(now)), 'opaque 400 {error:bad_params}, no echoed value');

  // span too large → 400 (bad_params, opaque).
  const tooBig = await ev(`/sessions/${SESSION}/events?from=0&to=${30 * 60 * 60 * 1000}`, { cookie }); // 30h > 6h cap
  assert(tooBig.status === 400, `span > cap must be 400, got ${tooBig.status}`);
  assertNoStore(tooBig, '400 (span too large)');

  // --- 8. the live feed (so ws_sent rises during the SLO scan) -------------------------------------------
  pub = mqtt.connect(MQTT_URL);
  await new Promise<void>((res, rej) => { pub!.on('connect', () => res()); pub!.on('error', rej); setTimeout(() => rej(new Error('pub connect timeout')), 8000); });
  const FEED_PLAYERS = 12;
  const telTopic = (p: string) => `football-trackers/session/${SESSION}/player/${p}/telemetry`;
  feedTimer = setInterval(() => {
    const tn = Date.now();
    for (let i = 0; i < FEED_PLAYERS; i++) {
      const player = String(i + 1).padStart(2, '0');
      pub!.publish(telTopic(player), JSON.stringify({
        id: `trk-${player}`, pl: player, ts: tn,
        lat: 44.8123 + i * 0.00001, lon: 20.4612 + i * 0.00001, spd: 3, hdg: 90, fix: 3, sats: 11, pdop: 1.0,
      }));
    }
  }, 100);

  // --- 8a. A REAL /live subscriber, so "fan-out" below means DELIVERED, not merely attempted. -------------
  // Phase 6 made server.publish()'s return meaningful: 0 = dropped (no subscriber), -1 = backpressure.
  // Before that, ft_ws_messages_sent_total counted ATTEMPTS — so this SLO section used to pass with no
  // client connected at all: it measured "ingest kept running", not "frames reached a coach". With a real
  // socket attached it measures what its own assertion claims, and it doubles as the regression guard for
  // the drop accounting (delete the subscriber and the sanity check below goes red).
  const liveWs = new WebSocket(`ws://127.0.0.1:${PORT}/live?sessionId=${SESSION}`, {
    headers: { cookie, origin: ORIGIN },
  } as unknown as string[]);
  await new Promise<void>((res, rej) => {
    liveWs.onopen = () => res();
    liveWs.onerror = () => rej(new Error('/live subscriber failed to connect'));
    setTimeout(() => rej(new Error('/live subscriber connect timeout')), 8000);
  });

  await sleep(1200);
  const before = await wsSent();
  await sleep(500);
  assert((await wsSent()) > before, 'sanity: live fan-out must be rising before the SLO scan');

  // --- 9. THE SLO + PM-1: fire MORE concurrent events scans than the SHARED cap; assert (a) fan-out never
  // froze across the whole burst, (b) at least one returned 503 'busy' (the shared off-loop cap held). ----
  const qFrom = now - WINDOW_MS - 60_000;
  const qTo = now + 60_000;
  const url = `http://127.0.0.1:${PORT}/sessions/${SESSION}/events?from=${qFrom}&to=${qTo}`;

  const samples: { t: number; v: number }[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) { samples.push({ t: performance.now(), v: await wsSent() }); await sleep(100); }
  })();

  const N_CONCURRENT = 5; // > OFFLOOP_MAX_INFLIGHT (3) so the shared cap must reject some
  const qStart = performance.now();
  const responses = await Promise.all(
    Array.from({ length: N_CONCURRENT }, () => fetch(url, { headers: { origin: ORIGIN, cookie } })),
  );
  const qEnd = performance.now();
  await sleep(250);
  sampling = false;
  await sampler;

  const statuses = responses.map((r) => r.status);
  const okCount = statuses.filter((s) => s === 200).length;
  const busyCount = statuses.filter((s) => s === 503).length;
  assert(okCount >= 1, `at least one concurrent events scan should succeed, statuses=${statuses}`);
  assert(busyCount >= 1, `the SHARED off-loop cap (PM-1) must reject ≥1 of ${N_CONCURRENT} concurrent scans with 503, statuses=${statuses}`);
  for (const r of responses) if (r.status === 503) assertNoStore(r, '503 (busy)'); // PB-N2: no-store on the 503 path too

  // Validate one successful body: team-aggregate, provenance present, NO name/playerId.
  const okRes = responses.find((r) => r.status === 200)!;
  type EvBody = {
    scannedRows: number; ageBand: string; bucketMs: number;
    detectorParams: { minPlayersForEvents: number };
    series: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>;
  };
  const body = (await okRes.json()) as EvBody;
  assert(body.scannedRows >= SEED_ROWS, `events scan should cover >= ${SEED_ROWS} rows, got ${body.scannedRows}`);
  assert(body.ageBand === 'U14', `unconfigured seed session → U14 provenance, got ${body.ageBand}`);
  assert(body.detectorParams && typeof body.detectorParams.minPlayersForEvents === 'number', 'detectorParams provenance present (PM-S6)');
  assert(Array.isArray(body.series) && body.series.length > 0, 'series should be non-empty over the seed');
  assert(body.series.length <= 5000, 'series bounded by MAX_BUCKETS');
  // Team-aggregate: NO playerId/displayName anywhere in a bucket or event.
  const rawBody = JSON.stringify(body);
  assert(!rawBody.includes('playerId') && !rawBody.includes('displayName'), 'events body must be team-aggregate (no playerId/displayName)');
  for (const b of body.series) assert(!('playerId' in b), 'a series bucket must not carry a playerId');

  const qDur = qEnd - qStart;
  assert(qDur >= 150, `the paged scan(s) should take real wall-time, took ${qDur.toFixed(0)}ms`);
  const inWindow = samples.filter((s) => s.t >= qStart - 50 && s.t <= qEnd + 50);
  assert(inWindow.length >= 2, `expected >=2 ws_sent samples during the ${qDur.toFixed(0)}ms burst, got ${inWindow.length}`);
  let worstGap = Infinity;
  for (let i = 1; i < inWindow.length; i++) worstGap = Math.min(worstGap, inWindow[i].v - inWindow[i - 1].v);
  assert(worstGap >= 1, `live WS fan-out FROZE during the concurrent events scans (worst 100ms delta=${worstGap}) — the read is starving the loop`);
  console.log(`[slo] ${N_CONCURRENT} concurrent scans in ${qDur.toFixed(0)}ms: ${okCount} ok / ${busyCount} busy(503); worst 100ms ws delta=${worstGap}`);

  // --- 10. metrics present + name-leak guard on /metrics AND server logs ---------------------------------
  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  assert(/ft_events_read_seconds_bucket\{/.test(metricsText), 'ft_events_read_seconds histogram missing');
  assert(/ft_events_requests_total\{[^}]*result="ok"[^}]*\}/.test(metricsText), 'ft_events_requests_total{result="ok"} missing');
  assert(/ft_events_requests_total\{[^}]*result="busy"[^}]*\}/.test(metricsText), 'ft_events_requests_total{result="busy"} missing (cap rejection not counted)');
  const logs = serverLog.join('');
  assert(/"msg":"events read"/.test(logs), 'expected an "events read" audit log line');
  for (const bad of ['displayName', 'Player 0', 'Alex', 'Sam ']) {
    assert(!metricsText.includes(bad), `/metrics must not contain "${bad}"`);
  }
  // PB-N5: test the ACTUAL label control, not absent needles — every ft_events_* series must carry ONLY a
  // bounded {result} label, NEVER a session/player label (which would enumerate which sessions have data on the
  // unauthenticated-scrapeable /metrics). This would FAIL if a per-session/player label were ever added.
  for (const line of metricsText.split('\n')) {
    if (!line.startsWith('ft_events_')) continue;
    assert(!/\b(session|player)="/.test(line), `ft_events_* must carry no session/player label: ${line}`);
  }
  // The audit line must NOT carry a playerId (PM-N3) — no player dimension on this surface.
  const eventsAuditLines = logs.split('\n').filter((l) => l.includes('"msg":"events read"'));
  for (const l of eventsAuditLines) assert(!l.includes('playerId'), 'events audit line must not carry a playerId (PM-N3)');

  console.log('\n✅ EVENTS E2E PASSED — endpoint authz (no id oracle) + no-store + opaque 400; SLO: concurrent 270k-row scans did NOT freeze fan-out; shared off-loop cap (PM-1) rejected excess with 503; team-aggregate body; no name in metrics/logs');
  if (feedTimer) clearInterval(feedTimer);
  pub.end();
  for (const f of [ACCOUNTS_FILE, CONF_FILE, DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) rmSync(f);
  stop();
  process.exit(0);
} catch (err) {
  console.error('\n❌ EVENTS E2E FAILED:', (err as Error).message);
  if (feedTimer) clearInterval(feedTimer);
  try { pub?.end(); } catch { /* noop */ }
  stop();
  process.exit(1);
}
