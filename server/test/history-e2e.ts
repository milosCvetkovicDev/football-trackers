/**
 * history-e2e.ts — endpoint-level + SLO test for GET /sessions/:id/history (ADR-0017, contract §3.1/§5).
 *
 * The module test (test/history.ts) covers readHistory correctness, the composite cursor, params, and the DoS
 * gate in isolation. THIS test drives the real HTTP route on a live server and proves the two things only an
 * e2e can:
 *   1. ENDPOINT authz + hygiene: §0.4 order (no-cookie → 401 even for a malformed id, so there is no
 *      session-id-validity oracle), bad Origin → 403, wrong-session → 403, bad id (authed) → 400, authorised
 *      → 200; Cache-Control: no-store on every response; opaque 400 bodies (no echoed query value); and NO
 *      child name in any log line or /metrics label.
 *   2. THE ADR-0017 SLO (event-loop non-starvation): over a PRE-SEEDED DB of >= 270k rows (so the paged
 *      keyset reader actually yields many times), a concurrent aggregate query must NOT freeze the live WS
 *      fan-out — ft_ws_messages_sent_total must keep rising throughout the scan. This assertion CAN fail: a
 *      naive blocking `.all()` read would flatline the counter for the duration of the scan.
 *
 * Hardware-free: anonymous mosquitto + a tiny in-process publisher generate the live feed; a provisioned
 * coach account gates the endpoint. Names used here are adult coach usernames + pseudonymous player ids only.
 *
 *   bun run test/history-e2e.ts        (or: bun run test:history-e2e)
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up child processes + temp files.
 */

import mqtt from 'mqtt';
import { existsSync, rmSync } from 'node:fs';

const PORT = 3105;
const METRICS_PORT = 9469;
const BROKER_PORT = 1888;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = '/tmp/ft-hist-e2e.db';
const ACCOUNTS_FILE = '/tmp/ft-hist-e2e-accounts.json';
const CONF_FILE = '/tmp/ft-hist-e2e-mosquitto.conf';

const ORIGIN = 'http://localhost:5173';
const SESSION = 'sessH';
const OTHER_SESSION = 'sessOther'; // the coach is NOT assigned this one
const COACH = 'coach-hist';
const COACH_PW = 'coach-hist-pw';
const COOKIE_NAME = 'ft_session'; // AUTH_COOKIE_SECURE=false ⇒ no __Host- prefix
const SEED_ROWS = 270_000; // ADR-0017 SLO fixture floor — forces >= 270 keyset chunks (yields) at chunk 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONF_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => { try { c.kill(); } catch { /* gone */ } });
let pub: mqtt.MqttClient | undefined;
let feedTimer: ReturnType<typeof setInterval> | undefined;

/** Sum every series of a counter in the /metrics text (labels vary by session). */
function sumCounter(text: string, name: string): number {
  const re = new RegExp(`^${name}\\{[^}]*\\}\\s+(\\d+)`, 'gm');
  let total = 0;
  for (const m of text.matchAll(re)) total += Number(m[1]);
  // Also match the no-label form, just in case.
  const re2 = new RegExp(`^${name}\\s+(\\d+)`, 'gm');
  for (const m of text.matchAll(re2)) total += Number(m[1]);
  return total;
}
async function wsSent(): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  return sumCounter(text, 'ft_ws_messages_sent_total');
}

try {
  // --- 1. SEED the DB to >= 270k rows BEFORE the server opens it (so the read path yields many times). ----
  // Set DB_PATH then DYNAMIC-import db.ts (it reads DB_PATH at import time). Seed in one transaction for speed.
  process.env.DB_PATH = DB_PATH;
  const { db, insertTelemetry } = await import('../src/db');
  const now = Date.now();
  const WINDOW_MS = 2 * 60 * 60 * 1000; // spread the seed across the last 2h (well inside retention)
  const seed = db.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      const player = String((i % 12) + 1).padStart(2, '0'); // 12 players
      insertTelemetry({
        id: `trk-${player}`,
        pl: player,
        playerId: player,
        sessionId: SESSION,
        ts: i,
        serverTs: now - WINDOW_MS + Math.floor((i / count) * WINDOW_MS),
        lat: 44.8122 + (i % 100) * 0.000005, // a small spread inside the pitch rectangle
        lon: 20.4608 + (Math.floor(i / 100) % 100) * 0.000007,
        spd: 2 + (i % 6),
        hdg: (i * 7) % 360,
        fix: 3,
        sats: 11,
        pdop: 1.1,
      });
    }
  });
  const t0seed = performance.now();
  seed(SEED_ROWS);
  const seeded = (db.query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number }).n;
  assert(seeded >= SEED_ROWS, `fixture must seed >= ${SEED_ROWS} rows, got ${seeded}`);
  db.close(); // hand the file off to the server process cleanly (WAL checkpoint)
  console.log(`[seed] ${seeded} rows in ${((performance.now() - t0seed) / 1000).toFixed(1)}s`);

  // --- 2. anonymous broker (publisher + server connect freely; cookie auth is the access control here) ----
  await Bun.write(CONF_FILE, `listener ${BROKER_PORT} 127.0.0.1\nallow_anonymous true\n`);
  const mosquittoBin = Bun.which('mosquitto') ?? 'mosquitto';
  children.push(Bun.spawn([mosquittoBin, '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' }));

  // --- 3. provision a coach assigned ONLY to SESSION (so wrong-session authz is testable). ----------------
  const addCoach = Bun.spawn(
    ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION],
    { cwd: `${import.meta.dir}/..`, env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE }, stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' },
  );
  addCoach.stdin.write(`${COACH_PW}\n`);
  await addCoach.stdin.end();
  assert((await addCoach.exited) === 0, 'auth-user.ts add (coach) failed');

  // --- 4. the real server (secured cookie auth, anon OFF, strict Origin). ---------------------------------
  const serverLog: string[] = [];
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE, AUTH_COOKIE_SECURE: 'false', ALLOWED_ORIGINS: ORIGIN,
      LOG_LEVEL: 'info',
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  children.push(server);
  // Capture server logs so we can assert the audit line carries counts, never a name.
  void (async () => { for await (const chunk of server.stdout) serverLog.push(Buffer.from(chunk).toString()); })();
  void (async () => { for await (const chunk of server.stderr) serverLog.push(Buffer.from(chunk).toString()); })();

  // --- 5. wait until ready (HTTP up + MQTT subscribed). ---------------------------------------------------
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const b = (await (await fetch(`http://127.0.0.1:${METRICS_PORT}/health`)).json()) as { ok: boolean; mqtt: boolean };
      if (b.ok && b.mqtt) { ready = true; break; }
    } catch { /* not up */ }
    await sleep(100);
  }
  assert(ready, 'server did not become ready in 12s');

  // --- 6. coach login → cookie -----------------------------------------------------------------------------
  const login = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(login.status === 200, `coach login should be 200, got ${login.status}`);
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))!.split(';')[0].trim();

  const hist = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { origin: ORIGIN, ...headers } });

  // --- 7. ENDPOINT authz matrix (§0.4 order) + Cache-Control + opaque errors ------------------------------
  // no cookie, MALFORMED id → must be 401 (auth checked BEFORE id validity → no session-id oracle).
  const noCookieBadId = await hist(`/sessions/${'bad id!!'}/history?mode=aggregate&from=0&to=${now}`);
  assert(noCookieBadId.status === 401, `no-cookie + bad id must be 401 (no id oracle), got ${noCookieBadId.status}`);
  assert((noCookieBadId.headers.get('cache-control') ?? '').includes('no-store'), 'no-store missing on 401');

  // bad Origin → 403 forbidden_origin (before anything).
  const badOrigin = await fetch(`http://127.0.0.1:${PORT}/sessions/${SESSION}/history?mode=aggregate&from=0&to=${now}`, {
    headers: { origin: 'http://evil.example', cookie },
  });
  assert(badOrigin.status === 403, `bad Origin must be 403, got ${badOrigin.status}`);

  // authed but NOT assigned this session → 403 forbidden.
  const wrongSession = await hist(`/sessions/${OTHER_SESSION}/history?mode=aggregate&from=0&to=${now}`, { cookie });
  assert(wrongSession.status === 403, `wrong-session must be 403, got ${wrongSession.status}`);

  // REGRESSION GUARD (the bug wave-2 caught): a same-origin browser GET via fetch() sends NO Origin header,
  // so requiring one would 403 the real coach UI. Authed + NO Origin + valid session → 200. (Tiny window so
  // this gate-check doesn't re-scan the 270k seed.)
  const noOrigin = await fetch(`http://127.0.0.1:${PORT}/sessions/${SESSION}/history?mode=aggregate&from=${now}&to=${now + 1}`, {
    headers: { cookie }, // deliberately NO origin header — mimics the browser's same-origin GET
  });
  assert(noOrigin.status === 200, `same-origin GET with NO Origin header must be 200 (browser omits Origin on same-origin GET), got ${noOrigin.status}`);

  // authed + valid session but MALFORMED params (to<from) → opaque 400 {error:'bad_params'} (no echo).
  const badParams = await hist(`/sessions/${SESSION}/history?mode=aggregate&from=${now}&to=0`, { cookie });
  assert(badParams.status === 400, `to<from must be 400, got ${badParams.status}`);
  const badBody = await badParams.text();
  assert(badBody.includes('bad_params') && !badBody.includes(String(now)), 'opaque 400 must be {error:bad_params} with no echoed query value');

  // --- 8. the live feed: a tiny publisher streaming ~12 players @10Hz so fan-out (ws_sent) rises -----------
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
        lat: 44.8123 + i * 0.00001, lon: 20.4612 + i * 0.00001,
        spd: 3, hdg: 90, fix: 3, sats: 11, pdop: 1.0,
      }));
    }
  }, 100); // 12 players × 10 Hz = ~120 msg/s of live fan-out

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

  await sleep(1200); // let the feed reach steady state
  const before = await wsSent();
  await sleep(500);
  const after = await wsSent();
  assert(after > before, `sanity: live fan-out must be rising before the SLO scan (before=${before}, after=${after})`);

  // --- 9. THE SLO: a concurrent aggregate scan over >= 270k rows must NOT freeze fan-out ------------------
  // Sample ws_sent every 100ms while the (awaited) query runs; assert the counter rises in EVERY interval —
  // a blocking read would flatline it for the scan duration. The query's many setTimeout(0) yields are what
  // both make it take real wall-time AND let the loop service ingest/fan-out between chunks.
  const samples: { t: number; v: number }[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      samples.push({ t: performance.now(), v: await wsSent() });
      await sleep(100);
    }
  })();

  // Window covers the whole seed (now-WINDOW_MS .. now) + the live feed (~now); span ~2h is under the 24h cap.
  const qFrom = now - WINDOW_MS - 60_000;
  const qStart = performance.now();
  const res = await hist(`/sessions/${SESSION}/history?mode=aggregate&from=${qFrom}&to=${now + 60_000}`, { cookie });
  const qEnd = performance.now();
  await sleep(250); // a couple of trailing samples
  sampling = false;
  await sampler;

  assert(res.status === 200, `aggregate query should be 200, got ${res.status}`);
  assert((res.headers.get('cache-control') ?? '').includes('no-store'), 'no-store missing on the 200 history response');
  type AggPlayer = {
    playerId: string;
    displayName?: unknown;
    distanceM: number;
    zoneDistanceM: number[];
    sprint: { count: number; distanceM: number; maxSpeedMps: number };
    effort: { accelMod: number; accelHigh: number; decelMod: number; decelHigh: number };
    distancePerMin: number;
  };
  const agg = (await res.json()) as { scannedRows: number; ageBand: string; players: AggPlayer[]; heatmap: { bins: number[] } };
  assert(agg.scannedRows >= SEED_ROWS, `aggregate should scan >= ${SEED_ROWS} rows, scanned ${agg.scannedRows}`);
  assert(Array.isArray(agg.players) && agg.players.length > 0, 'aggregate must return per-player rows');
  assert(agg.players.every((p) => p.displayName === undefined), 'aggregate rows must NOT carry a displayName (pseudonymous)');

  // --- 9a. Phase-4 EXTENDED aggregate shape (contract §4.1/§5): top-level ageBand + per-player zone/sprint/
  // effort/distancePerMin. The seed session 'sessH' is UNCONFIGURED, so its provenance band is the U14 default.
  // Assert STRUCTURE + the Σ(zoneDistanceM) == distanceM invariant — NOT exact sprint/accel counts (the
  // synthetic seed cycles spd 2..7 every row and is not designed for sustained ≥1.0s efforts). --------------
  assert(agg.ageBand === 'U14', `unconfigured seed session must report the U14 default ageBand, got ${agg.ageBand}`);
  const EPS = 1e-3; // float epsilon: Σ of the per-row gated steps should equal the same gated distanceM total
  for (const p of agg.players) {
    // zoneDistanceM: a length-5 number[] (index 0=Z1 walk … 4=Z5 sprint), each finite + non-negative.
    assert(Array.isArray(p.zoneDistanceM) && p.zoneDistanceM.length === 5,
      `player ${p.playerId} zoneDistanceM must be a length-5 array, got ${JSON.stringify(p.zoneDistanceM)}`);
    assert(p.zoneDistanceM.every((z) => typeof z === 'number' && Number.isFinite(z) && z >= 0),
      `player ${p.playerId} zoneDistanceM bins must all be finite >= 0, got ${JSON.stringify(p.zoneDistanceM)}`);
    // THE Σ INVARIANT: the zone bins partition the SAME gated distance, so they must sum to distanceM.
    const zoneSum = p.zoneDistanceM.reduce((s, z) => s + z, 0);
    const tol = EPS * Math.max(1, Math.abs(p.distanceM)); // relative epsilon for large accumulated distances
    assert(Math.abs(zoneSum - p.distanceM) <= tol,
      `player ${p.playerId} Σ zoneDistanceM (${zoneSum}) must equal distanceM (${p.distanceM}) within ${tol}`);
    // sprint: structural presence, all fields finite + non-negative (no exact-count assertion — see above).
    assert(p.sprint && typeof p.sprint === 'object', `player ${p.playerId} must carry a sprint object`);
    assert(typeof p.sprint.count === 'number' && p.sprint.count >= 0, `player ${p.playerId} sprint.count must be >= 0, got ${p.sprint.count}`);
    assert(typeof p.sprint.distanceM === 'number' && p.sprint.distanceM >= 0, `player ${p.playerId} sprint.distanceM must be >= 0, got ${p.sprint.distanceM}`);
    assert(typeof p.sprint.maxSpeedMps === 'number' && p.sprint.maxSpeedMps >= 0, `player ${p.playerId} sprint.maxSpeedMps must be >= 0, got ${p.sprint.maxSpeedMps}`);
    // effort: the four numeric counts present + finite + non-negative.
    assert(p.effort && typeof p.effort === 'object', `player ${p.playerId} must carry an effort object`);
    for (const k of ['accelMod', 'accelHigh', 'decelMod', 'decelHigh'] as const) {
      assert(typeof p.effort[k] === 'number' && Number.isFinite(p.effort[k]) && p.effort[k] >= 0,
        `player ${p.playerId} effort.${k} must be a finite >= 0 number, got ${p.effort[k]}`);
    }
    // distancePerMin: a finite, non-negative volume rate over the gated distance.
    assert(typeof p.distancePerMin === 'number' && Number.isFinite(p.distancePerMin) && p.distancePerMin >= 0,
      `player ${p.playerId} distancePerMin must be a finite >= 0 number, got ${p.distancePerMin}`);
  }
  console.log(`[phase4] aggregate ageBand=${agg.ageBand}, ${agg.players.length} players — zone Σ==distanceM, sprint/effort/distancePerMin present`);

  const qDur = qEnd - qStart;
  assert(qDur >= 150, `the paged scan should take real wall-time (many chunks+yields), took ${qDur.toFixed(0)}ms`);

  // Core SLO assertion: across the query window, ws_sent rose in every consecutive-sample interval.
  const inWindow = samples.filter((s) => s.t >= qStart - 50 && s.t <= qEnd + 50);
  assert(inWindow.length >= 2, `expected >=2 ws_sent samples during the ${qDur.toFixed(0)}ms query, got ${inWindow.length}`);
  let worstGap = Infinity;
  for (let i = 1; i < inWindow.length; i++) worstGap = Math.min(worstGap, inWindow[i].v - inWindow[i - 1].v);
  assert(worstGap >= 1, `live WS fan-out FROZE during the history scan — a 100ms window saw 0 new messages (worst interval delta=${worstGap}). The read is starving the event loop.`);
  const totalDuringQuery = inWindow[inWindow.length - 1].v - inWindow[0].v;
  console.log(`[slo] query ${qDur.toFixed(0)}ms, ${inWindow.length} samples, +${totalDuringQuery} ws msgs during scan, worst 100ms interval delta=${worstGap}`);

  // --- 10. SLO metric present + name-leak guard on /metrics AND the captured server logs ------------------
  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  assert(/ft_history_read_seconds_bucket\{[^}]*mode="aggregate"[^}]*\}/.test(metricsText), 'ft_history_read_seconds{mode="aggregate"} histogram missing');
  assert(/ft_history_requests_total\{[^}]*result="ok"[^}]*\}/.test(metricsText), 'ft_history_requests_total{result="ok"} missing');
  // A displayName must never appear in a metric label NOR in any captured server log line.
  const logs = serverLog.join('');
  assert(/"msg":"history read"/.test(logs), 'expected a "history read" audit log line');
  for (const bad of ['displayName', 'Player 0', 'Alex', 'Sam ']) {
    assert(!metricsText.includes(bad), `/metrics must not contain "${bad}"`);
  }

  console.log('\n✅ HISTORY E2E PASSED — endpoint authz (no id oracle) + no-store + opaque 400; SLO: a 270k-row aggregate scan did NOT freeze live fan-out; ft_history_read_seconds present; no name in metrics/logs');
  if (feedTimer) clearInterval(feedTimer);
  pub.end();
  for (const f of [ACCOUNTS_FILE, CONF_FILE, DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) rmSync(f);
  stop();
  process.exit(0);
} catch (err) {
  console.error('\n❌ HISTORY E2E FAILED:', (err as Error).message);
  if (feedTimer) clearInterval(feedTimer);
  try { pub?.end(); } catch { /* noop */ }
  stop();
  process.exit(1);
}
