/**
 * Self-contained, hardware-free test for the Phase-2 anonymous-mode posture (audit §4.1).
 *
 * ALLOW_ANONYMOUS_LIVE is the isolated-LAN bypass that lets a coach tablet watch the pitch without a
 * login. The audit proved two things about it against the running dev stack:
 *
 *   curl (no Origin at all)          -> 200  {"displayName":"CANARY-CHILD-NAME"}
 *   curl -H 'Origin: http://evil…'   -> 403  {"error":"forbidden_origin"}
 *
 * i.e. the Origin allow-list — the ONLY gate anon mode left standing — blocks a browser and waves
 * through a script, because `originOkLenient` treats an ABSENT Origin as trusted and absent is exactly
 * what every non-browser client sends. Two fixes, both asserted here:
 *
 *   1. THE BIND. Anon mode defaults the listener to 127.0.0.1, so a no-login feed of children's
 *      positions is not reachable from the subnet at all. PUBLIC_HOST still overrides it (a container
 *      needs 0.0.0.0 inside its own namespace) — so this test pins BOTH directions: the default really
 *      is loopback-only, and the override really does open it. A default nobody can turn off is not a
 *      default, and one that silently does nothing is worse.
 *   2. THE SCOPE. Anon is now the LIVE PITCH and nothing else: /roster (names), /history (bulk raw
 *      location) and /events (the review series built from them) answer 403 login_required. /config is
 *      the single exception — one age-band enum, no per-child anything, and the live view needs it to
 *      colour speed zones.
 *
 * The canary is the load-bearing part: the roster this server loads maps a player to a distinctive
 * display name, and every response body AND the whole server log are scraped for it at the end. That
 * re-runs the audit's exact exploit rather than trusting a status code to imply the name stayed put.
 *
 * Ports/files are dedicated and do NOT collide (e2e 3101/9465/1883, roster-e2e 3102/9466/1885,
 * device-health 3103/9467/1886, auth-e2e 3104/9468/1885, history-e2e 3105/9469/1888, config-e2e
 * 3106/9471/1889, auth-dos 3110/9470). We take 3111/3112/3113 + 9472 + broker 1890.
 *
 *   bun run test/anon-scope.ts        (or: bun run test:anon-scope)
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up child processes + temp files.
 */

import { existsSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const ANON_PORT = 3111; // anon mode, PUBLIC_HOST unset  -> must be loopback-only
const OPEN_PORT = 3112; // anon mode, PUBLIC_HOST=0.0.0.0 -> must be reachable off-loopback
const AUTH_PORT = 3113; // anon OFF, PUBLIC_HOST unset    -> must be reachable off-loopback
const METRICS_PORT = 9472;
const BROKER_PORT = 1890;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = '/tmp/ft-anon-scope.db';
const ROSTER_FILE = '/tmp/ft-anon-scope-roster.json';
const CONF_FILE = '/tmp/ft-anon-scope-mosquitto.conf';
const ACCOUNTS_FILE = '/tmp/ft-anon-scope-accounts.json';

const COACH = 'coach-anon-scope';
const COACH_PW = 'coach-anon-scope-pw';
const COOKIE_NAME = 'ft_session'; // AUTH_COOKIE_SECURE=false ⇒ no __Host- prefix
const SESSION = 'anonSess';
const PLAYER = '01';
/** Distinctive enough that a substring hit anywhere is a real leak, not a coincidence. */
const CANARY = 'CANARY-CHILD-NAME-9f3a';
const ORIGIN = 'http://localhost:5173';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

let checks = 0;
function ok(msg: string) {
  checks++;
  console.log(`  ✓ ${msg}`);
}

/** First non-internal IPv4 on this machine — the address a phone on the same Wi-Fi would use. */
function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/**
 * Every body seen by an UNAUTHENTICATED caller, for the end-of-run canary scrape. The authenticated
 * reads in (g) deliberately opt out (`track: false`) — a signed-in coach is SUPPOSED to receive the
 * name, and folding those bodies in would make the leak probe unsatisfiable.
 */
const seenBodies: string[] = [];
async function get(url: string, init?: RequestInit, track = true): Promise<{ status: number; body: string }> {
  const res = await fetch(url, init);
  const body = await res.text();
  if (track) seenBodies.push(body);
  return { status: res.status, body };
}

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ROSTER_FILE, CONF_FILE, ACCOUNTS_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => { try { c.kill(); } catch { /* already gone */ } });

/** Everything the ANON server wrote — scraped for the canary and for the PUBLIC_HOST warning. */
let anonLog = '';
let openLog = '';

interface SpawnOpts { port: number; anon: boolean; publicHost?: string; sink?: (s: string) => void }
function spawnServer({ port, anon, publicHost, sink }: SpawnOpts) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    // Only ONE server may own the metrics port; the extra servers get their own so they don't collide.
    METRICS_PORT: String(METRICS_PORT + (port - ANON_PORT)),
    MQTT_URL,
    DB_PATH,
    AUTH_ROSTER_FILE: ROSTER_FILE,
    ALLOWED_ORIGINS: ORIGIN,
    AUTH_COOKIE_SECURE: 'false',
    LOG_LEVEL: 'info',
    MQTT_USERNAME: undefined,
    MQTT_PASSWORD: undefined,
    // The coach account (g) logs in with. Present on every server here so anon mode has something to
    // authenticate AGAINST — that is the whole point of the cookie-first resolution being tested.
    AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE,
    // Explicitly cleared: process.env may carry these from the caller's shell (run-all.ts inherits the
    // environment), and either one leaking in would silently invert the posture this test is pinning.
    ALLOW_ANONYMOUS_LIVE: anon ? 'true' : undefined,
    ANON_SESSIONS: anon ? SESSION : undefined,
    PUBLIC_HOST: publicHost,
  };
  const p = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(p);
  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream) sink?.(dec.decode(chunk, { stream: true }));
  };
  void drain(p.stdout as unknown as ReadableStream<Uint8Array>);
  void drain(p.stderr as unknown as ReadableStream<Uint8Array>);
  return p;
}

async function waitReady(port: number, what: string) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/auth/me`);
      if (r.status === 200 || r.status === 401) { await r.text(); return; }
      await r.text();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`${what} did not answer on 127.0.0.1:${port} within 10s`);
}

/** Can we open a TCP connection to host:port? Used to prove a bind is / is not off-loopback. */
async function reachable(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/auth/me`, { signal: AbortSignal.timeout(3000) });
    await res.text();
    return true;
  } catch {
    return false;
  }
}

try {
  const LAN = lanIPv4();

  // --- roster with the canary name, so the leak probe has something real to find --------------------
  await Bun.write(
    ROSTER_FILE,
    JSON.stringify({ sessions: { [SESSION]: [{ playerId: PLAYER, displayName: CANARY }] } }, null, 2) + '\n',
  );

  // --- a coach account, so anon mode has a real identity to resolve a cookie to (section g) --------
  const add = Bun.spawn(['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE },
    stdin: 'pipe', stdout: 'ignore', stderr: 'inherit',
  });
  add.stdin.write(`${COACH_PW}\n`);
  await add.stdin.end();
  assert((await add.exited) === 0, 'auth-user.ts add (coach) failed');

  // --- an anonymous broker: the access control under test is the SERVER's, not the broker's --------
  await Bun.write(CONF_FILE, `listener ${BROKER_PORT} 127.0.0.1\nallow_anonymous true\n`);
  children.push(Bun.spawn([Bun.which('mosquitto') ?? 'mosquitto', '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' }));

  // ==================================================================================================
  console.log('\n(a) ANON MODE, PUBLIC_HOST unset — the bind must be loopback-only');
  // ==================================================================================================
  spawnServer({ port: ANON_PORT, anon: true, sink: (s) => { anonLog += s; } });
  await waitReady(ANON_PORT, 'anon server');
  ok(`anon server answers on 127.0.0.1:${ANON_PORT}`);

  if (LAN) {
    assert(!(await reachable(LAN, ANON_PORT)), `anon-mode server MUST NOT be reachable at ${LAN}:${ANON_PORT} — that is the §4.1 exposure`);
    ok(`NOT reachable at ${LAN}:${ANON_PORT} (the LAN address a phone on this Wi-Fi would use)`);
  } else {
    // Never let a skipped check read as a passed one (Phase-1 lesson: no silent caps).
    console.log('  ⚠ SKIPPED the off-loopback probe: this machine has no non-internal IPv4 address.');
  }

  // ==================================================================================================
  console.log('\n(b) ANON MODE — the scope: live pitch yes, names / bulk history no');
  // ==================================================================================================
  const me = await get(`http://127.0.0.1:${ANON_PORT}/auth/me`);
  assert(me.status === 200, `/auth/me should be 200 in anon mode, got ${me.status}`);
  assert(JSON.parse(me.body).anonymous === true, `/auth/me should report anonymous:true, got ${me.body}`);
  ok('/auth/me → 200 anonymous:true (the anon principal exists)');

  // The two GETs the live pitch legitimately needs.
  const sessions = await get(`http://127.0.0.1:${ANON_PORT}/sessions`);
  assert(sessions.status === 200, `/sessions should be 200 for anon, got ${sessions.status}`);
  assert(JSON.parse(sessions.body).sessions?.includes?.(SESSION) ?? JSON.stringify(JSON.parse(sessions.body)).includes(SESSION),
    `/sessions should list ${SESSION}, got ${sessions.body}`);
  ok('/sessions → 200 (anon can still find its session)');

  const cfg = await get(`http://127.0.0.1:${ANON_PORT}/sessions/${SESSION}/config`);
  assert(cfg.status === 200, `/config should stay 200 for anon (live zone colours), got ${cfg.status}`);
  assert(typeof JSON.parse(cfg.body).ageBand === 'string', `/config body should carry an ageBand, got ${cfg.body}`);
  ok('/config → 200 (the one session-scoped read anon keeps: an age band, no per-child data)');

  // The three that now require a real login.
  for (const [name, path] of [
    ['roster', `/sessions/${SESSION}/roster`],
    ['history', `/sessions/${SESSION}/history?from=1&to=2&mode=aggregate`],
    ['events', `/sessions/${SESSION}/events?from=1&to=2`],
  ] as const) {
    const r = await get(`http://127.0.0.1:${ANON_PORT}${path}`);
    assert(r.status === 403, `anon /${name} should be 403, got ${r.status} ${r.body}`);
    assert(JSON.parse(r.body).error === 'login_required', `anon /${name} should say login_required, got ${r.body}`);
    ok(`/${name} → 403 login_required (this is the request that returned a child's name in the audit)`);
  }

  // The audit's literal exploit: no Origin header at all — the case originOkLenient waves through.
  const bare = await get(`http://127.0.0.1:${ANON_PORT}/sessions/${SESSION}/roster`, { headers: { 'user-agent': 'curl/8.0' } });
  assert(bare.status === 403, `a bare no-Origin curl for the roster must be 403, got ${bare.status}`);
  ok('a bare no-Origin curl (the audit\'s exact bypass) → 403, not 200');

  // Malformed id must reject IDENTICALLY, or the status code becomes an id-validity oracle.
  const malformed = await get(`http://127.0.0.1:${ANON_PORT}/sessions/${'!'.repeat(8)}/roster`);
  assert(malformed.status === 403 && JSON.parse(malformed.body).error === 'login_required',
    `a malformed session id must reject the same way (no oracle), got ${malformed.status} ${malformed.body}`);
  ok('malformed session id → the same 403 login_required (no session-id-validity oracle)');

  // ==================================================================================================
  console.log('\n(c) ANON MODE — /live still works, which is the entire point of the bypass');
  // ==================================================================================================
  const wsResult = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ANON_PORT}/live?sessionId=${SESSION}`, {
      headers: { Origin: ORIGIN },
    } as unknown as string[]);
    // resolve BEFORE close(): close() fires onclose synchronously, which would otherwise re-enter done()
    // and settle the promise with "closed:1000" — reporting a rejected upgrade for a socket that opened.
    const done = (s: string) => { resolve(s); try { ws.close(); } catch { /* noop */ } };
    ws.onopen = () => done('open');
    ws.onclose = (e) => done(`closed:${e.code}`);
    ws.onerror = () => done('error');
    setTimeout(() => done('timeout'), 5000);
  });
  assert(wsResult === 'open', `anon /live upgrade should still be accepted, got "${wsResult}"`);
  ok('/live upgrade accepted for the anon principal (the pitch view still needs no login)');

  // ==================================================================================================
  console.log('\n(d) PUBLIC_HOST=0.0.0.0 — the override works AND says so loudly');
  // ==================================================================================================
  spawnServer({ port: OPEN_PORT, anon: true, publicHost: '0.0.0.0', sink: (s) => { openLog += s; } });
  await waitReady(OPEN_PORT, 'PUBLIC_HOST=0.0.0.0 server');
  if (LAN) {
    assert(await reachable(LAN, OPEN_PORT), `PUBLIC_HOST=0.0.0.0 must actually open the bind (${LAN}:${OPEN_PORT}) — otherwise (a) proves nothing`);
    ok(`reachable at ${LAN}:${OPEN_PORT} — so (a)'s loopback bind is a real decision, not an accident of the environment`);
  } else {
    console.log('  ⚠ SKIPPED the override probe: this machine has no non-internal IPv4 address.');
  }
  assert(/not loopback/.test(openLog), `anon + non-loopback bind must log a warning; log was:\n${openLog}`);
  ok('the anon + non-loopback combination logs a loud warning');
  assert(!/not loopback/.test(anonLog), 'the loopback-bound server must NOT log that warning (or it means nothing)');
  ok('the loopback-bound server does not log it');

  // ==================================================================================================
  console.log('\n(e) ANON OFF — the default bind and the 401 path are untouched');
  // ==================================================================================================
  spawnServer({ port: AUTH_PORT, anon: false });
  await waitReady(AUTH_PORT, 'auth-mode server');
  if (LAN) {
    assert(await reachable(LAN, AUTH_PORT), `with anon OFF the default bind must stay 0.0.0.0 (${LAN}:${AUTH_PORT}) — cookie auth is the control there`);
    ok(`reachable at ${LAN}:${AUTH_PORT} with anon off (the loopback default is scoped to anon mode only)`);
  }
  const noCookie = await get(`http://127.0.0.1:${AUTH_PORT}/sessions/${SESSION}/roster`);
  assert(noCookie.status === 401, `with anon off, a cookie-less roster read is 401 (not 403), got ${noCookie.status} ${noCookie.body}`);
  ok('cookie-less /roster → 401 unauthorized (403 login_required is the ANON branch, and only that)');

  // ==================================================================================================
  console.log('\n(g) ANON MODE + a real login — the bypass must not make logging in IMPOSSIBLE');
  // ==================================================================================================
  // currentPrincipal used to `return ANON_PRINCIPAL` before parsing the cookie, so on an anon stack a
  // real login was silently downgraded to the shared anonymous identity. Harmless while anon could read
  // everything; the moment (b) made names need an account it meant NOBODY could ever see a name on the
  // bench stack, and every audit line for a coach's read said username:null. Anon is a FALLBACK now.
  const login = await get(`http://127.0.0.1:${ANON_PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  }, false);
  assert(login.status === 200, `login must succeed on an anon-mode server, got ${login.status} ${login.body}`);
  ok('a coach can still LOG IN on an anon-mode server');

  // Re-fetch the Set-Cookie (get() only returns the body).
  const loginRes = await fetch(`http://127.0.0.1:${ANON_PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  await loginRes.text();
  const cookie = loginRes.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))?.split(';')[0].trim();
  assert(cookie, 'login must Set-Cookie the session cookie');

  const meAuthed = await get(`http://127.0.0.1:${ANON_PORT}/auth/me`, { headers: { cookie } }, false);
  const mp = JSON.parse(meAuthed.body);
  assert(mp.anonymous === false && mp.username === COACH,
    `with a valid cookie the anon-mode server must resolve the REAL principal, got ${meAuthed.body}`);
  ok('/auth/me with a cookie → the named coach, not the shared anon principal');

  const authedRoster = await get(`http://127.0.0.1:${ANON_PORT}/sessions/${SESSION}/roster`, { headers: { cookie } }, false);
  assert(authedRoster.status === 200, `the signed-in coach must reach /roster, got ${authedRoster.status} ${authedRoster.body}`);
  assert(authedRoster.body.includes(CANARY),
    `the signed-in coach must actually receive the name (otherwise (b) is unfalsifiable), got ${authedRoster.body}`);
  ok('/roster with a cookie → 200 WITH the name (the rule is "log in", not "never")');

  // The point of requiring a login is attribution: the audit line must name who read it.
  assert(new RegExp(`"msg":"roster read"[^\\n]*"username":"${COACH}"`).test(anonLog),
    `the roster read must be audited against the coach's username; log tail:\n${anonLog.slice(-800)}`);
  ok('the read is audited against the coach by name (anon reads logged username:null)');

  // ==================================================================================================
  console.log('\n(f) THE CANARY — the name must appear in nothing an ANONYMOUS caller saw');
  // ==================================================================================================
  const leakedBody = seenBodies.findIndex((b) => b.includes(CANARY));
  assert(leakedBody === -1, `a response body leaked the canary name: ${seenBodies[leakedBody]}`);
  ok(`no response body contains the canary (${seenBodies.length} bodies scraped)`);
  assert(!anonLog.includes(CANARY), 'the server log leaked the canary name (§0.1: names are never logged)');
  ok('the server log does not contain the canary either');

  // And prove the canary was actually loadable — otherwise (f) passes because the roster was empty.
  assert(/roster: loaded/.test(anonLog), `the server must have loaded the roster file, or the canary probe is vacuous; log:\n${anonLog}`);
  const entries = anonLog.match(/"msg":"roster: loaded"[^\n]*"entries":(\d+)/)?.[1];
  assert(entries && Number(entries) >= 1, `the loaded roster must hold at least one entry, got entries=${entries}`);
  ok(`the roster really was loaded (entries=${entries}) — so (f) is a real probe, not a vacuous one`);

  console.log(`\n✅ anon-scope: ${checks} checks passed — anon mode is loopback-bound and live-pitch-only.\n`);
} catch (err) {
  console.error(`\n❌ anon-scope FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  stop();
  process.exit(1);
} finally {
  stop();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ROSTER_FILE, CONF_FILE, ACCOUNTS_FILE]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* noop */ }
  }
}
process.exit(0);
