/**
 * Self-contained, hardware-free session-config end-to-end test (Phase 4 — age-banded speed zones;
 * ADR-0019, docs/frontend/phase-4-contract.md §2 + §0 standing invariants).
 *
 * GET /sessions/:id/config is the ONE HTTP surface that returns a session's age band → youth speed-zone
 * thresholds. Unlike /roster the band is NOT a name/location (so no rate-limit / no-store), but it IS
 * session-scoped + authed for uniformity (it reuses the SAME sessionGetGate as /roster + /history) so live
 * zone colour can never disagree with the server review breakdown. This test spins the real server.ts with a
 * SESSION_CONFIG_FILE configuring the run session as U16 and proves the endpoint end-to-end:
 *   - authz matrix in §0.4 ORDER: no-cookie → 401 (for ANY id incl. malformed — currentPrincipal runs BEFORE
 *     validSessionId so there is no 400-vs-401 session-id-validity oracle); bad Origin → 403; wrong-session
 *     (coach not assigned) → 403; authorised → 200.
 *   - the 200 body for the CONFIGURED session is EXACTLY { sessionId, ageBand:'U16',
 *     thresholds:{ jogMps:2, runMps:4, hsrMps:5.28, sprintMps:6.39 } } (the §1 table — no invented values).
 *   - an UNCONFIGURED session the coach is also assigned to defaults to U14
 *     ({ ageBand:'U14', hsrMps:4.86, sprintMps:5.83 }) — so zones always resolve.
 *   - PHASE 5 (audit §6 "Client"): the same endpoint now carries the PITCH — `pitch:{corners:[4]}` for a
 *     session that has one, the key ABSENT for one that doesn't (client keeps its built-in corners), and
 *     absent again for a configured-but-DEGENERATE quad, which is refused server-side rather than handed
 *     to a homography solve that would throw and white-screen the coach view.
 *   - NO name/PII in the body or in /metrics; ft_config_requests_total is present (by {result} only).
 *
 * Hardware-free: anonymous mosquitto + a provisioned coach account gate the endpoint. Names used here are
 * adult coach usernames + pseudonymous player ids only.
 *
 * Ports/files are dedicated and do NOT collide with the other tests (e2e 3101/9465/1883, roster-e2e
 * 3102/9466/1885, device-health 3103/9467/1886, auth-e2e 3104/9468/1885, history-e2e 3105/9469/1888,
 * auth-dos 3110/9470). We take PORT=3106/METRICS=9471/broker 1889 per the Phase-4 slice spec.
 *
 *   bun run test/config-e2e.ts        (or: bun run test:config-e2e)
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up the child processes + temp files.
 */

import { existsSync, rmSync } from 'node:fs';

const PORT = 3106;
const METRICS_PORT = 9471;
const BROKER_PORT = 1889;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = '/tmp/ft-config-e2e.db';
const ACCOUNTS_FILE = '/tmp/ft-config-e2e-accounts.json';
const CONFIG_FILE = '/tmp/ft-config-e2e-session-config.json';
const CONF_FILE = '/tmp/ft-config-e2e-mosquitto.conf';

const ORIGIN = 'http://localhost:5173';
const BAD_ORIGIN = 'http://evil.example';

// Coach is assigned to BOTH the configured (U16) and the unconfigured (U14-default) session, so the 200
// path covers both the configured + default-band branches; coach is NOT assigned OTHER_SESSION (the 403 case).
const COACH = 'coach-config';
const COACH_PW = 'coach-config-pw';
const SESSION_CONFIGURED = 'sessCfg'; // configured U16 + a real pitch in SESSION_CONFIG_FILE
const SESSION_UNCONFIGURED = 'sessDefault'; // assigned to the coach but NOT in the config file → U14 default
const SESSION_BAD_PITCH = 'sessBadPitch'; // configured band + an UNUSABLE pitch → band served, pitch dropped
const OTHER_SESSION = 'sessOther'; // the coach is NOT assigned this one → 403
const COOKIE_NAME = 'ft_session'; // AUTH_COOKIE_SECURE=false ⇒ no __Host- prefix

// The §1 youth threshold table values this test pins (verbatim — no invented/rounded numbers).
const U16 = { jogMps: 2, runMps: 4, hsrMps: 5.28, sprintMps: 6.39 };
const U14 = { jogMps: 2, runMps: 4, hsrMps: 4.86, sprintMps: 5.83 };

// Phase 5 (audit §6 "Client"): the pitch's four GPS corners move OUT of the client bundle and into this
// endpoint, so a coach can point the view at the pitch they are actually standing on. A synthetic
// ~105 x 68 m rectangle in on-screen corner order (TL, TR, BR, BL), built from metre offsets.
const BASE = { lat: 44.812806, lon: 20.460535 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180);
const pt = (east: number, north: number) => ({
  lat: BASE.lat + north / M_PER_DEG_LAT,
  lon: BASE.lon + east / M_PER_DEG_LON,
});
const PITCH = [pt(0, 0), pt(105, 0), pt(105, -68), pt(0, -68)];
// Three collinear corners: the client's 8x8 homography solve would throw 'degenerate homography' on
// this and white-screen the coach view, so the server must refuse to serve it at all.
const BAD_PITCH = [pt(0, 0), pt(50, 0), pt(105, 0), pt(0, -68)];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// Fresh DB + accounts/config/broker files each run.
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONFIG_FILE, CONF_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => { try { c.kill(); } catch { /* already gone */ } });

// Capture EVERYTHING the server writes so the name-leak guard can scrape the audit log.
let serverLog = '';

const cfgUrl = (id: string) => `http://127.0.0.1:${PORT}/sessions/${encodeURIComponent(id)}/config`;

try {
  // --- 1. provision the coach account assigned to BOTH the configured + unconfigured sessions -----------
  const add = Bun.spawn(
    ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', `${SESSION_CONFIGURED},${SESSION_UNCONFIGURED},${SESSION_BAD_PITCH}`],
    {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE },
      stdin: 'pipe', stdout: 'ignore', stderr: 'inherit',
    },
  );
  add.stdin.write(`${COACH_PW}\n`);
  await add.stdin.end();
  assert((await add.exited) === 0, 'auth-user.ts add (coach) failed');
  assert(existsSync(ACCOUNTS_FILE), 'accounts file was not created by the CLI');

  // --- 2. the SESSION_CONFIG_FILE: configure ONLY SESSION_CONFIGURED as U16 (the unconfigured one falls
  // through to the U14 default). Shape mirrors sessionConfig.ts: { sessions: { "<id>": { ageBand } } }. ----
  await Bun.write(
    CONFIG_FILE,
    JSON.stringify(
      {
        sessions: {
          [SESSION_CONFIGURED]: { ageBand: 'U16', pitch: { corners: PITCH } },
          [SESSION_BAD_PITCH]: { ageBand: 'U12', pitch: { corners: BAD_PITCH } },
        },
      },
      null,
      2,
    ) + '\n',
  );

  // --- 3. anonymous broker (the auth under test is the SERVER /config gate, not broker ACLs) ------------
  await Bun.write(CONF_FILE, `listener ${BROKER_PORT} 127.0.0.1\nallow_anonymous true\n`);
  const mosquittoBin = Bun.which('mosquitto') ?? 'mosquitto';
  children.push(Bun.spawn([mosquittoBin, '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' }));

  // --- 4. server (the real artifact) — auth on, session-config file wired, strict Origin -----------------
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE,
      SESSION_CONFIG_FILE: CONFIG_FILE, // <-- point the server at the Phase-4 session-config store
      AUTH_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: ORIGIN,
      AUTH_ACCOUNTS_RELOAD_SECONDS: '3600',
      AUTH_SESSION_TTL_SECONDS: '3600',
      LOG_LEVEL: 'info',
      // No broker creds — the broker is anonymous here.
      MQTT_USERNAME: undefined as unknown as string,
      MQTT_PASSWORD: undefined as unknown as string,
      LIVE_TOKEN: undefined as unknown as string,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  children.push(server);
  // Drain both streams into serverLog (for the §0.1 name-leak scrape of the audit log + boot line).
  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      serverLog += text;
      process.stdout.write(text); // mirror so failures are debuggable
    }
  };
  void drain(server.stdout as unknown as ReadableStream<Uint8Array>);
  void drain(server.stderr as unknown as ReadableStream<Uint8Array>);

  // --- 5. wait until server is up AND subscribed (so /metrics + endpoints are live) ---------------------
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const body = (await (await fetch(`http://127.0.0.1:${METRICS_PORT}/health`)).json()) as { ok: boolean; mqtt: boolean };
      if (body.ok && body.mqtt) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  assert(ready, 'server did not become ready (HTTP up + MQTT subscribed) in 10s');

  // ====================================================================================================
  // (a) AUTHZ MATRIX in §0.4 ORDER (reusing the SAME sessionGetGate as /roster + /history)
  // ====================================================================================================

  // (a1) no cookie, valid id → 401 (currentPrincipal fails before authz). Body is {authenticated:false}.
  const noCookie = await fetch(cfgUrl(SESSION_CONFIGURED), { headers: { origin: ORIGIN } });
  assert(noCookie.status === 401, `no-cookie /config should be 401, got ${noCookie.status}`);
  const noCookieBody = (await noCookie.json()) as { authenticated?: boolean };
  assert(noCookieBody.authenticated === false, `no-cookie body should be {authenticated:false}, got ${JSON.stringify(noCookieBody)}`);

  // (a2) §0.4 ORDER PROOF: no cookie + MALFORMED id → STILL 401 (no session-id-validity oracle).
  const noCookieMalformed = await fetch(cfgUrl('bad id!!'), { headers: { origin: ORIGIN } });
  assert(noCookieMalformed.status === 401,
    `no-cookie + malformed id must be 401 (no session-id-validity oracle), got ${noCookieMalformed.status}`);
  await noCookieMalformed.text();

  // (a3) coach login → cookie.
  const login = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(login.status === 200, `coach login should be 200, got ${login.status}`);
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))!.split(';')[0].trim();

  // (a4) bad Origin (with a valid cookie) → 403 forbidden_origin (the Origin gate is FIRST).
  const badOrigin = await fetch(cfgUrl(SESSION_CONFIGURED), { headers: { origin: BAD_ORIGIN, cookie } });
  assert(badOrigin.status === 403, `bad-Origin /config should be 403, got ${badOrigin.status}`);
  const badOriginBody = (await badOrigin.json()) as { error?: string };
  assert(badOriginBody.error === 'forbidden_origin', `bad-Origin error should be forbidden_origin, got ${JSON.stringify(badOriginBody)}`);

  // (a5) authed coach, wrong session (NOT assigned) → 403 forbidden.
  const wrongSession = await fetch(cfgUrl(OTHER_SESSION), { headers: { origin: ORIGIN, cookie } });
  assert(wrongSession.status === 403, `wrong-session /config should be 403, got ${wrongSession.status}`);
  const wrongBody = (await wrongSession.json()) as { error?: string };
  assert(wrongBody.error === 'forbidden', `wrong-session error should be forbidden, got ${JSON.stringify(wrongBody)}`);

  // ====================================================================================================
  // (b) AUTHORISED 200 — the CONFIGURED session returns EXACTLY the §1 U16 thresholds
  // ====================================================================================================
  const okCfg = await fetch(cfgUrl(SESSION_CONFIGURED), { headers: { origin: ORIGIN, cookie } });
  assert(okCfg.status === 200, `authorised /config (configured) should be 200, got ${okCfg.status}`);
  const cfgBody = (await okCfg.json()) as { sessionId?: string; ageBand?: string; thresholds?: Record<string, number> };
  assert(cfgBody.sessionId === SESSION_CONFIGURED, `body sessionId should be ${SESSION_CONFIGURED}, got ${cfgBody.sessionId}`);
  assert(cfgBody.ageBand === 'U16', `configured session ageBand should be U16, got ${cfgBody.ageBand}`);
  assert(cfgBody.thresholds !== undefined, 'configured body must carry thresholds');
  // EXACTLY the four threshold keys — no more, no fewer.
  assert(JSON.stringify(Object.keys(cfgBody.thresholds!).sort()) === JSON.stringify(['hsrMps', 'jogMps', 'runMps', 'sprintMps']),
    `thresholds must carry EXACTLY {jogMps,runMps,hsrMps,sprintMps}, got ${JSON.stringify(Object.keys(cfgBody.thresholds!))}`);
  for (const [k, v] of Object.entries(U16)) {
    assert(cfgBody.thresholds![k] === v, `U16 thresholds.${k} should be ${v}, got ${cfgBody.thresholds![k]}`);
  }
  // The body must carry ONLY {sessionId, ageBand, thresholds} (+ `pitch` when one is configured) — no
  // stray fields. This session HAS a pitch, so all four keys are expected here.
  assert(JSON.stringify(Object.keys(cfgBody).sort()) === JSON.stringify(['ageBand', 'pitch', 'sessionId', 'thresholds']),
    `configured-pitch config body must have EXACTLY {sessionId, ageBand, thresholds, pitch}, got keys ${Object.keys(cfgBody).join(',')}`);

  // (b1a) PHASE 5: the four pitch corners are served, in order, unmodified — this is what replaces the
  // compile-time PITCH_CORNERS the audit found pointing at a bench in Belgrade.
  const pitch = (cfgBody as unknown as { pitch?: { corners?: Array<{ lat: number; lon: number }> } }).pitch;
  assert(pitch !== undefined, 'configured session must carry a pitch');
  assert(JSON.stringify(Object.keys(pitch!).sort()) === JSON.stringify(['corners']),
    `pitch must carry EXACTLY {corners}, got ${Object.keys(pitch!).join(',')}`);
  assert(pitch!.corners?.length === 4, `pitch.corners must have 4 entries, got ${pitch!.corners?.length}`);
  for (let i = 0; i < 4; i++) {
    assert(JSON.stringify(Object.keys(pitch!.corners![i]).sort()) === JSON.stringify(['lat', 'lon']),
      `corner ${i} must carry EXACTLY {lat, lon}, got ${Object.keys(pitch!.corners![i]).join(',')}`);
    assert(pitch!.corners![i].lat === PITCH[i].lat && pitch!.corners![i].lon === PITCH[i].lon,
      `corner ${i} must round-trip unmodified and IN ORDER (TL,TR,BR,BL)`);
  }

  // (b1b) PHASE 5: an UNUSABLE pitch is refused at the server, not passed to a client that would throw
  // inside its homography solve. The band still resolves — a bad pitch must not cost the session its zones.
  const badPitchRes = await fetch(cfgUrl(SESSION_BAD_PITCH), { headers: { origin: ORIGIN, cookie } });
  assert(badPitchRes.status === 200, `bad-pitch session should still be 200, got ${badPitchRes.status}`);
  const badPitchBody = (await badPitchRes.json()) as Record<string, unknown>;
  assert(badPitchBody.ageBand === 'U12', `bad-pitch session must keep its band, got ${badPitchBody.ageBand}`);
  assert(!('pitch' in badPitchBody),
    `a degenerate pitch must be dropped server-side, got ${JSON.stringify(badPitchBody.pitch)}`);

  // (b2) REGRESSION GUARD: a same-origin browser GET via fetch() sends NO Origin header — authed + NO Origin
  // + own session → 200 (requiring an Origin would 403 the real coach UI).
  const noOrigin = await fetch(cfgUrl(SESSION_CONFIGURED), { headers: { cookie } }); // deliberately NO origin
  assert(noOrigin.status === 200,
    `same-origin GET with NO Origin header must be 200 (browser omits Origin on same-origin GET), got ${noOrigin.status}`);
  await noOrigin.text();

  // ====================================================================================================
  // (c) UNCONFIGURED session → the documented U14 DEFAULT (so zones always resolve)
  // ====================================================================================================
  const okDefault = await fetch(cfgUrl(SESSION_UNCONFIGURED), { headers: { origin: ORIGIN, cookie } });
  assert(okDefault.status === 200, `authorised /config (unconfigured) should be 200, got ${okDefault.status}`);
  const defBody = (await okDefault.json()) as { sessionId?: string; ageBand?: string; thresholds?: Record<string, number> };
  assert(defBody.sessionId === SESSION_UNCONFIGURED, `body sessionId should be ${SESSION_UNCONFIGURED}, got ${defBody.sessionId}`);
  assert(defBody.ageBand === 'U14', `unconfigured session must default to U14, got ${defBody.ageBand}`);
  for (const [k, v] of Object.entries(U14)) {
    assert(defBody.thresholds![k] === v, `U14 default thresholds.${k} should be ${v}, got ${defBody.thresholds![k]}`);
  }
  // An unconfigured session carries NO pitch — `pitch` is ABSENT rather than null, which is what tells
  // the client to keep its built-in corners (a null would have to be special-cased at every reader).
  assert(!('pitch' in defBody),
    `an unconfigured session must omit pitch entirely, got ${JSON.stringify((defBody as Record<string, unknown>).pitch)}`);
  assert(JSON.stringify(Object.keys(defBody).sort()) === JSON.stringify(['ageBand', 'sessionId', 'thresholds']),
    `unconfigured config body must have EXACTLY {sessionId, ageBand, thresholds}, got keys ${Object.keys(defBody).join(',')}`);

  // ====================================================================================================
  // (d) /metrics — ft_config_requests_total present, by {result} only (no session/player/name label)
  // ====================================================================================================
  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  const num = (re: RegExp): number | undefined => {
    const m = metricsText.match(re);
    return m ? Number(m[1]) : undefined;
  };
  assert(metricsText.includes('ft_config_requests_total'), 'metrics: ft_config_requests_total must be exposed');
  assert((num(/ft_config_requests_total\{result="ok"\}\s+(\d+)/) ?? 0) >= 2,
    'metrics: ft_config_requests_total{result="ok"} should be >= 2 (configured + default + no-Origin reads)');
  assert((num(/ft_config_requests_total\{result="unauthorized"\}\s+(\d+)/) ?? 0) >= 2,
    'metrics: ft_config_requests_total{result="unauthorized"} should be >= 2 (the two no-cookie probes)');
  assert((num(/ft_config_requests_total\{result="forbidden_origin"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_config_requests_total{result="forbidden_origin"} should be >= 1');
  assert((num(/ft_config_requests_total\{result="forbidden"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_config_requests_total{result="forbidden"} should be >= 1');
  // The config metric must carry NO session/player label — only {result} (no session enumeration oracle).
  assert(!/ft_config_requests_total\{[^}]*session=/.test(metricsText),
    'metrics: ft_config_requests_total must NEVER carry a session label');
  assert(!/ft_config_requests_total\{[^}]*player=/.test(metricsText),
    'metrics: ft_config_requests_total must NEVER carry a player label');

  // ====================================================================================================
  // (e) NAME/PII GUARD (§0.1) — no name, no displayName, no roster value in any body OR on /metrics
  // ====================================================================================================
  // The config body/endpoint must NEVER leak a name or anything beyond {band,thresholds} (§8.4/§8.7). The
  // run has no provisioned names, so the structural assertions above already prove minimisation; belt-and-
  // braces, confirm the wire shapes carry no name/displayName key and /metrics carries no obvious name token.
  for (const body of [cfgBody, defBody]) {
    assert(!('name' in body) && !('displayName' in body) && !('roster' in body),
      `config body must NEVER carry a name/displayName/roster, got keys ${Object.keys(body).join(',')}`);
  }
  for (const bad of ['displayName', 'name":"', 'Alex', 'Sam ', 'Player 0']) {
    assert(!metricsText.includes(bad), `/metrics must not contain "${bad}"`);
  }

  console.log('\n✅ CONFIG E2E PASSED — §0.4 authz order (no-cookie→401 even on malformed id, bad-origin→403, wrong-session→403), authorised 200 with EXACTLY {sessionId,ageBand,thresholds(,pitch)}; configured session=U16 + 4 pitch corners in order, unconfigured defaults to U14 with NO pitch, degenerate pitch refused server-side (band kept); ft_config_requests_total {result}-only; no name/PII in body or /metrics');
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONFIG_FILE, CONF_FILE]) {
    if (existsSync(f)) rmSync(f);
  }
  stop();
  process.exit(0);
} catch (err) {
  console.error('\n❌ CONFIG E2E FAILED:', (err as Error).message);
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONFIG_FILE, CONF_FILE]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* noop */ }
  }
  stop();
  process.exit(1);
}
