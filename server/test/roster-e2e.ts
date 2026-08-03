/**
 * Self-contained, hardware-free roster end-to-end test (Phase 3 — player names; ADR-0016,
 * docs/frontend/phase-3-contract.md §1.2 + §0 standing invariants).
 *
 * THREAT MODEL: GET /sessions/:id/roster is the ONE HTTP surface that returns child NAMES. Names are
 * identified data — they must be gated by the same Phase-2 authz posture as /live, bounded against
 * bulk-export, never cached past logout, and (the standing invariant §0.1) NEVER leak into /metrics or any
 * log line. This test spins the real server.ts + a roster.json and proves the endpoint end-to-end:
 *   - authz matrix in §0.4 ORDER: no-cookie → 401 (for ANY id incl. malformed — currentPrincipal runs
 *     BEFORE validSessionId so there is no 400-vs-401 session-id-validity oracle); bad Origin → 403;
 *     wrong-session (coach not assigned) → 403; malformed :id WHEN AUTHED → 400; authorised → 200 with
 *     { sessionId, roster:[{playerId, displayName}] } carrying the provisioned names.
 *   - per-principal rate limit: a burst past ROSTER_RATE_BURST from one cookie → some 429; a DIFFERENT
 *     principal/cookie is unaffected (bucket isolation — one coach can never starve another).
 *   - Cache-Control: no-store on a 200 AND on a 4xx (names must not survive in the browser disk cache).
 *   - NAME-LEAK GUARD: scrape /metrics AND the server's captured stdout/stderr; assert NO displayName VALUE
 *     appears in either (the 'roster read' audit line carries playerCount, never a name).
 *
 * Ports/files are dedicated and do NOT collide with the other tests (e2e 3101/9465/1883, auth-e2e
 * 3104/9468/1885, auth-dos 3110/9470, mosquitto-pub-demo 3102/9466). We take PORT=3102/METRICS=9466/
 * broker 1885 per the Phase-3 slice spec; these run sequentially so a stale parallel proc can't poison us.
 *
 *   bun run test/roster-e2e.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up the child processes + temp files.
 */

import { existsSync, rmSync } from 'node:fs';

const PORT = 3102;
const METRICS_PORT = 9466;
const BROKER_PORT = 1885;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = '/tmp/ft-roster-e2e.db';
const ACCOUNTS_FILE = '/tmp/ft-roster-e2e-accounts.json';
const ROSTER_FILE = '/tmp/ft-roster-e2e-roster.json';
const CONF_FILE = '/tmp/ft-roster-e2e-mosquitto.conf';

const ORIGIN = 'http://localhost:5173';
const BAD_ORIGIN = 'http://evil.example';

// Coach A is assigned to sessA (the authorised case); coach B is assigned to sessB (used to prove the
// rate-limit token bucket is per-principal — B's burst is unaffected by A draining A's bucket).
const COACH_A = 'coach-roster-a';
const COACH_A_PW = 'coach-roster-a-pw';
const COACH_B = 'coach-roster-b';
const COACH_B_PW = 'coach-roster-b-pw';
const SESSION_A = 'sessA'; // assigned to coach A, has a roster
const SESSION_B = 'sessB'; // assigned to coach B, NOT to coach A (the forbidden-session case)
const SESSION_UNASSIGNED = 'sessX'; // exists nowhere — also a forbidden-session for coach A
const MALFORMED_ID = 'bad id!'; // space + '!' fail SESSION_ID_RE → 400 only AFTER authn

// The provisioned names — these strings must NEVER appear in /metrics or any log line.
const NAME_01 = 'Alex Morgan';
const NAME_07 = 'Sam OBrien';

// Cookie name with AUTH_COOKIE_SECURE=false (the __Host- prefix is only added when Secure). See auth.ts.
const COOKIE_NAME = 'ft_session';
// Keep the burst tiny so the rate-limit case is fast.
const ROSTER_RATE_BURST = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// Fresh DB + accounts/roster/broker files each run.
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, ROSTER_FILE, CONF_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => {
  try { c.kill(); } catch { /* already gone */ }
});

// Capture EVERYTHING the server writes to stdout/stderr so the name-leak guard can scrape the audit log.
// (Both streams piped → drained into one buffer; the server logs ndjson to stdout, warnings/errors too.)
let serverLog = '';

/** Replay a verbatim "name=value" cookie on a fetch. */
async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, password }),
  });
  assert(res.status === 200, `login for ${username} should be 200, got ${res.status}`);
  const cookieLine = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
  assert(cookieLine !== undefined, `login for ${username} must Set-Cookie ${COOKIE_NAME}=`);
  await res.text(); // drain
  return cookieLine!.split(';')[0].trim();
}

function rosterUrl(id: string): string {
  return `http://127.0.0.1:${PORT}/sessions/${encodeURIComponent(id)}/roster`;
}

try {
  // --- 1. provision two coach accounts via the CLI (passwords piped to stdin; never on the argv) -------
  for (const [user, pw, sess] of [
    [COACH_A, COACH_A_PW, SESSION_A],
    [COACH_B, COACH_B_PW, SESSION_B],
  ] as const) {
    const add = Bun.spawn(
      ['bun', 'run', 'auth-user.ts', 'add', user, '--role', 'coach', '--sessions', sess],
      {
        cwd: `${import.meta.dir}/..`,
        env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE },
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'inherit',
      },
    );
    add.stdin.write(`${pw}\n`);
    await add.stdin.end();
    assert((await add.exited) === 0, `auth-user.ts add (${user}) failed`);
  }
  assert(existsSync(ACCOUNTS_FILE), 'accounts file was not created by the CLI');

  // --- 2. provision a roster.json the server will read via AUTH_ROSTER_FILE (sessA gets two named players)
  await Bun.write(
    ROSTER_FILE,
    JSON.stringify({
      sessions: {
        [SESSION_A]: [
          { playerId: '01', displayName: NAME_01 },
          { playerId: '07', displayName: NAME_07 },
        ],
      },
    }),
  );

  // --- 3. anonymous broker (the auth under test is the SERVER /roster gate, not broker ACLs) -----------
  await Bun.write(
    CONF_FILE,
    `listener ${BROKER_PORT} 127.0.0.1\n` +
    'allow_anonymous true\n',
  );
  const mosquittoBin = Bun.which('mosquitto') ?? 'mosquitto';
  const broker = Bun.spawn([mosquittoBin, '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' });
  children.push(broker);

  // --- 4. server (the real artifact) — auth on, roster file wired, tiny burst so the 429 case is fast ---
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE,
      AUTH_ROSTER_FILE: ROSTER_FILE,
      AUTH_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: ORIGIN,
      AUTH_ACCOUNTS_RELOAD_SECONDS: '3600',
      AUTH_SESSION_TTL_SECONDS: '3600',
      ROSTER_RATE_BURST: String(ROSTER_RATE_BURST),
      ROSTER_RATE_PER_MIN: '1', // slow refill so a quick burst can't be topped back up mid-test
      // No broker creds — the broker is anonymous here.
      MQTT_USERNAME: undefined as unknown as string,
      MQTT_PASSWORD: undefined as unknown as string,
      LIVE_TOKEN: undefined as unknown as string,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(server);
  // Drain both streams into serverLog as they arrive (for the §0.1 name-leak scrape of the audit log).
  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      serverLog += text;
      process.stdout.write(text); // mirror to our own stdout so failures are debuggable
    }
  };
  void drain(server.stdout as unknown as ReadableStream<Uint8Array>);
  void drain(server.stderr as unknown as ReadableStream<Uint8Array>);

  // --- 5. wait until server is up AND subscribed (so /metrics + endpoints are live) -------------------
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/health`);
      const body = (await res.json()) as { ok: boolean; mqtt: boolean };
      if (body.ok && body.mqtt) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  assert(ready, 'server did not become ready (HTTP up + MQTT subscribed) in 10s');

  // ====================================================================================================
  // (a) AUTHZ MATRIX in §0.4 ORDER
  // ====================================================================================================

  // (a1) no cookie, valid id → 401 (currentPrincipal fails before authz). Body is {authenticated:false}.
  const noCookie = await fetch(rosterUrl(SESSION_A), { headers: { origin: ORIGIN } });
  assert(noCookie.status === 401, `no-cookie /roster should be 401, got ${noCookie.status}`);
  const noCookieBody = (await noCookie.json()) as { authenticated?: boolean };
  assert(noCookieBody.authenticated === false, `no-cookie body should be {authenticated:false}, got ${JSON.stringify(noCookieBody)}`);

  // (a2) §0.4 ORDER PROOF: no cookie + MALFORMED id → STILL 401, NOT 400. currentPrincipal must run before
  // validSessionId, so an unauthenticated caller learns nothing about whether the session id is well-formed.
  const noCookieMalformed = await fetch(rosterUrl(MALFORMED_ID), { headers: { origin: ORIGIN } });
  assert(noCookieMalformed.status === 401,
    `no-cookie + malformed id must be 401 (no session-id-validity oracle), got ${noCookieMalformed.status}`);
  await noCookieMalformed.text();

  // (a3) bad Origin (with a valid cookie) → 403 forbidden_origin (the Origin gate is FIRST).
  const cookieA = await login(COACH_A, COACH_A_PW);
  const badOrigin = await fetch(rosterUrl(SESSION_A), { headers: { origin: BAD_ORIGIN, cookie: cookieA } });
  assert(badOrigin.status === 403, `bad-Origin /roster should be 403, got ${badOrigin.status}`);
  const badOriginBody = (await badOrigin.json()) as { error?: string };
  assert(badOriginBody.error === 'forbidden_origin', `bad-Origin error should be forbidden_origin, got ${JSON.stringify(badOriginBody)}`);

  // (a4) authed coach A, wrong session (assigned to B, not A) → 403 forbidden. Try both an existing-but-
  // unassigned session (sessB) and a never-seen one (sessX) — both are 'not authorized for this principal'.
  for (const wrong of [SESSION_B, SESSION_UNASSIGNED]) {
    const res = await fetch(rosterUrl(wrong), { headers: { origin: ORIGIN, cookie: cookieA } });
    assert(res.status === 403, `coach A on ${wrong} should be 403, got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert(body.error === 'forbidden', `wrong-session error should be forbidden, got ${JSON.stringify(body)}`);
  }

  // (a5) authed coach A, MALFORMED id → 400 bad_session (validSessionId fires only AFTER authn passes).
  const authedMalformed = await fetch(rosterUrl(MALFORMED_ID), { headers: { origin: ORIGIN, cookie: cookieA } });
  assert(authedMalformed.status === 400,
    `authed + malformed id should be 400 bad_session, got ${authedMalformed.status}`);
  const authedMalformedBody = (await authedMalformed.json()) as { error?: string };
  assert(authedMalformedBody.error === 'bad_session',
    `authed malformed-id error should be bad_session, got ${JSON.stringify(authedMalformedBody)}`);

  // (a6) authorised: coach A on sessA → 200 with the exact contract body + the provisioned names.
  const ok = await fetch(rosterUrl(SESSION_A), { headers: { origin: ORIGIN, cookie: cookieA } });
  assert(ok.status === 200, `authorised /roster should be 200, got ${ok.status}`);
  const okBody = (await ok.json()) as { sessionId?: string; roster?: { playerId: string; displayName: string }[] };
  assert(okBody.sessionId === SESSION_A, `body sessionId should be ${SESSION_A}, got ${okBody.sessionId}`);
  assert(Array.isArray(okBody.roster) && okBody.roster.length === 2,
    `body roster should have 2 entries, got ${JSON.stringify(okBody.roster)}`);
  const byId = new Map(okBody.roster!.map((e) => [e.playerId, e.displayName]));
  assert(byId.get('01') === NAME_01, `roster '01' displayName should be "${NAME_01}", got "${byId.get('01')}"`);
  assert(byId.get('07') === NAME_07, `roster '07' displayName should be "${NAME_07}", got "${byId.get('07')}"`);
  // The body must carry ONLY {playerId, displayName} per entry — no stray fields.
  for (const e of okBody.roster!) {
    assert(Object.keys(e).sort().join(',') === 'displayName,playerId',
      `roster entry must have exactly {playerId, displayName}, got keys ${Object.keys(e).join(',')}`);
  }

  // (a7) REGRESSION GUARD: a same-origin browser GET via fetch() sends NO Origin header. Requiring one (the
  // original bug) 403'd the real coach UI. Authed + NO Origin + own session → 200 with the names.
  const noOrigin = await fetch(rosterUrl(SESSION_A), { headers: { cookie: cookieA } }); // deliberately NO origin
  assert(noOrigin.status === 200,
    `same-origin GET with NO Origin header must be 200 (browser omits Origin on same-origin GET), got ${noOrigin.status}`);

  // ====================================================================================================
  // (b) Cache-Control: no-store on a 200 AND on a 4xx (names must not survive the browser disk cache)
  // ====================================================================================================
  assert(ok.headers.get('cache-control') === 'no-store',
    `200 /roster must carry Cache-Control: no-store, got "${ok.headers.get('cache-control')}"`);
  assert(authedMalformed.headers.get('cache-control') === 'no-store',
    `4xx /roster must carry Cache-Control: no-store, got "${authedMalformed.headers.get('cache-control')}"`);

  // ====================================================================================================
  // (c) PER-PRINCIPAL RATE LIMIT — coach A's burst hits 429; coach B is unaffected (bucket isolation)
  // ====================================================================================================
  // Coach A has already spent some of its bucket on the authz-matrix authorised reads above. Fire a fresh
  // burst (BURST + several) and require at least one 429; the refill is 1/min so it can't top back up here.
  let aThrottled = 0;
  let aThrottleBody: { error?: string } | undefined;
  for (let i = 0; i < ROSTER_RATE_BURST + 5; i++) {
    const res = await fetch(rosterUrl(SESSION_A), { headers: { origin: ORIGIN, cookie: cookieA } });
    if (res.status === 429) {
      aThrottled += 1;
      aThrottleBody = (await res.json()) as { error?: string };
      // A 429 must STILL carry no-store (Cache-Control on EVERY response, incl. rejects).
      assert(res.headers.get('cache-control') === 'no-store',
        `429 /roster must carry Cache-Control: no-store, got "${res.headers.get('cache-control')}"`);
    } else {
      await res.text();
    }
  }
  assert(aThrottled >= 1, `coach A burst past ROSTER_RATE_BURST=${ROSTER_RATE_BURST} must produce >=1 429`);
  assert(aThrottleBody?.error === 'rate_limited', `429 body should be {error:'rate_limited'}, got ${JSON.stringify(aThrottleBody)}`);

  // BUCKET ISOLATION: coach B (a DIFFERENT principal) gets 200 immediately even while A is throttled —
  // its token bucket is independent, so one coach can never starve another.
  const cookieB = await login(COACH_B, COACH_B_PW);
  const bRes = await fetch(rosterUrl(SESSION_B), { headers: { origin: ORIGIN, cookie: cookieB } });
  assert(bRes.status === 200,
    `a DIFFERENT principal (coach B) must be unaffected by coach A's throttling, got ${bRes.status}`);
  const bBody = (await bRes.json()) as { sessionId?: string; roster?: unknown[] };
  assert(bBody.sessionId === SESSION_B, `coach B body sessionId should be ${SESSION_B}, got ${bBody.sessionId}`);
  // sessB has no roster provisioned → ids-only is a valid posture (empty roster, still 200).
  assert(Array.isArray(bBody.roster) && bBody.roster.length === 0,
    `sessB has no roster provisioned → roster:[] expected, got ${JSON.stringify(bBody.roster)}`);

  // ====================================================================================================
  // (d) /metrics reflects the requests by RESULT label only (no session/player/name label)
  // ====================================================================================================
  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  const num = (re: RegExp): number | undefined => {
    const m = metricsText.match(re);
    return m ? Number(m[1]) : undefined;
  };
  assert((num(/ft_roster_requests_total\{result="ok"\}\s+(\d+)/) ?? 0) >= 2,
    'metrics: ft_roster_requests_total{result="ok"} should be >= 2 (coach A sessA + coach B sessB)');
  assert((num(/ft_roster_requests_total\{result="rate_limited"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_roster_requests_total{result="rate_limited"} should be >= 1');
  assert((num(/ft_roster_requests_total\{result="unauthorized"\}\s+(\d+)/) ?? 0) >= 2,
    'metrics: ft_roster_requests_total{result="unauthorized"} should be >= 2 (the two no-cookie probes)');
  assert((num(/ft_roster_requests_total\{result="forbidden_origin"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_roster_requests_total{result="forbidden_origin"} should be >= 1');
  assert((num(/ft_roster_requests_total\{result="forbidden"\}\s+(\d+)/) ?? 0) >= 2,
    'metrics: ft_roster_requests_total{result="forbidden"} should be >= 2 (sessB + sessX)');
  assert((num(/ft_roster_requests_total\{result="bad_session"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_roster_requests_total{result="bad_session"} should be >= 1');
  // The roster metric must carry NO session/player label — only {result}. A per-session count on the
  // unauthenticated-scrapeable /metrics would enumerate which sessions have coaches (ADR-0016 §1.2).
  assert(!/ft_roster_requests_total\{[^}]*session=/.test(metricsText),
    'metrics: ft_roster_requests_total must NEVER carry a session label');
  assert(!/ft_roster_requests_total\{[^}]*player=/.test(metricsText),
    'metrics: ft_roster_requests_total must NEVER carry a player label');

  // ====================================================================================================
  // (e) NAME-LEAK GUARD (§0.1) — NO displayName VALUE in /metrics OR any server log line.
  // ====================================================================================================
  for (const name of [NAME_01, NAME_07]) {
    assert(!metricsText.includes(name),
      `NAME LEAK: displayName "${name}" appears in /metrics`);
    assert(!serverLog.includes(name),
      `NAME LEAK: displayName "${name}" appears in a server log line (the 'roster read' audit must carry playerCount, never a name)`);
  }
  // Positive control: the audit 'roster read' line MUST exist and carry a playerCount (proving the read was
  // logged with COUNTS, not names). The ndjson line for sessA's 2-player roster carries "playerCount":2.
  assert(/"roster read"/.test(serverLog) || /roster read/.test(serverLog),
    'expected a "roster read" audit log line from the authorised reads');
  assert(/"playerCount":2/.test(serverLog),
    'the "roster read" audit line for sessA must carry "playerCount":2 (counts, not names)');

  console.log('\n✅ ROSTER E2E PASSED — §0.4 authz order (no-cookie→401 even on malformed id), bad-origin/wrong-session/bad-id, authorised 200 with names, per-principal 429 (bucket-isolated), no-store on 200+4xx, /metrics {result}-only, NO name leak in /metrics or logs');
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, ROSTER_FILE, CONF_FILE]) {
    if (existsSync(f)) rmSync(f);
  }
  stop();
  process.exit(0);
} catch (err) {
  console.error('\n❌ ROSTER E2E FAILED:', (err as Error).message);
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, ROSTER_FILE, CONF_FILE]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* noop */ }
  }
  stop();
  process.exit(1);
}
