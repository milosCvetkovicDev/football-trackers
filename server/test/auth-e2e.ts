/**
 * Self-contained, hardware-free auth end-to-end test (Phase 2 — cookie auth + principal-bound session
 * authz + server-side revocation). See docs/frontend/phase-2-auth-contract.md §8 + ADR-0015/0008.
 *
 * THREAT MODEL #1: /live gates the LIVE LOCATION OF MINORS. This test proves the SERVER's cookie gate
 * (not the broker ACLs — the broker here is anonymous on purpose) actually fails closed:
 *   - login: wrong password -> 401; no Origin -> 403 (strict CSWSH/CSRF); correct (with Origin) -> 200
 *     + HttpOnly Set-Cookie + a csrf in the body and NO raw token in the body.
 *   - WS /live with the cookie+Origin to the assigned session A  -> authorized, receives the fan-out.
 *   - WS to the UNASSIGNED session B                              -> 1008 'forbidden session'.
 *   - WS with NO cookie -> 1008 'unauthorized'; WS with cookie but NO Origin -> 1008 'forbidden origin'.
 *   - logout (Origin + X-CSRF-Token) -> 204; THEN the SAME cookie replayed on a fresh WS is rejected
 *     (server-side token deletion — the critical pre-mortem fix; a captured cookie cannot be replayed).
 *   - /metrics reflects it (login success+failure counters, the session-authz rejection, sessions gauge,
 *     anon mode off) and is NOT served on the public port.
 *
 * A rejected WS upgrade fires the browser's onopen THEN onclose(1008) (the server accepts the 101 then
 * closes), so EVERY terminal assertion below reads the CLOSE code/reason — never whether onopen fired.
 *
 *   bun run test/auth-e2e.ts      (or: bun run test:auth)
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up child processes + temp files.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';

// Dedicated ports/files — chosen NOT to collide with any other test/tool, so a stray leftover process
// from a parallel run can't poison this one: e2e.ts (3101/9465/1883), mosquitto-pub-demo (3102/9466),
// ws-origin (3103/9467), simulate (3000/9464/broker 1884). We take the next free slots.
const PORT = 3104;
const METRICS_PORT = 9468;
const BROKER_PORT = 1885;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = '/tmp/ft-authe2e.db';
const ACCOUNTS_FILE = '/tmp/ft-authe2e-accounts.json';
const CONF_FILE = '/tmp/ft-authe2e-mosquitto.conf';

const ORIGIN = 'http://localhost:5173';
const COACH = 'coach-a';
const COACH_PW = 'coachpw';
const SESSION_A = 'sessA'; // assigned to the coach
const SESSION_B = 'sessB'; // NOT assigned — the forbidden-session case
const TOPIC_A = `football-trackers/session/${SESSION_A}/player/01/telemetry`;
// Cookie name with AUTH_COOKIE_SECURE=false (the __Host- prefix is only added when Secure). See auth.ts.
const COOKIE_NAME = 'ft_session';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// Fresh DB + accounts/broker files each run.
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONF_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => {
  try { c.kill(); } catch { /* already gone */ }
});

let pub: import('mqtt').MqttClient | undefined;
const openSockets: WebSocket[] = [];

/** Resolve once a socket reaches its terminal state, reporting how it ended (open-and-receiving, or closed). */
interface WsOutcome {
  closed: boolean;
  code: number;
  reason: string;
  messages: any[];
}
/**
 * Open a /live socket with the given cookie/origin headers and observe its terminal state. A REJECTED
 * socket fires onopen THEN onclose(1008); we ALWAYS assert on the close (code/reason), never on onopen.
 * `waitMs` lets an admitted socket sit long enough to collect fan-out before we read its message buffer.
 */
function liveSocket(
  sessionId: string,
  headers: Record<string, string>,
  waitMs = 700,
): { socket: WebSocket; outcome: Promise<WsOutcome> } {
  const url = `ws://127.0.0.1:${PORT}/live?sessionId=${sessionId}`;
  // Bun's WebSocket accepts a { headers } option (verified) — used to carry the cookie + forge the Origin.
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  openSockets.push(socket);
  const messages: any[] = [];
  socket.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try { messages.push(JSON.parse(ev.data)); } catch { /* ignore non-JSON */ }
    }
  };
  socket.onerror = () => { /* a rejected socket also surfaces an error; the close carries the verdict */ };
  const outcome = new Promise<WsOutcome>((resolve) => {
    let settled = false;
    const finish = (closed: boolean, code: number, reason: string) => {
      if (settled) return;
      settled = true;
      resolve({ closed, code, reason, messages });
    };
    socket.onclose = (ev) => finish(true, ev.code, ev.reason);
    // If it's still OPEN after waitMs, treat it as an admitted, durable connection.
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) finish(false, 0, '');
    }, waitMs);
  });
  return { socket, outcome };
}

try {
  // --- 1. provision an accounts file via the CLI (password piped to stdin; never on the argv) ----------
  const add = Bun.spawn(
    ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION_A],
    {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );
  add.stdin.write(`${COACH_PW}\n`);
  await add.stdin.end();
  assert((await add.exited) === 0, 'auth-user.ts add (coach) failed');
  assert(existsSync(ACCOUNTS_FILE), 'accounts file was not created by the CLI');

  // --- 2. anonymous broker (the auth under test is the SERVER /live cookie gate, not broker ACLs) ------
  await Bun.write(
    CONF_FILE,
    `listener ${BROKER_PORT} 127.0.0.1\n` +
    'allow_anonymous true\n',
  );
  const mosquittoBin = Bun.which('mosquitto') ?? 'mosquitto';
  const broker = Bun.spawn([mosquittoBin, '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' });
  children.push(broker);

  // --- 3. server (the real artifact) — auth on, non-Secure cookie (localhost dev), strict Origin -------
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE,
      AUTH_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: ORIGIN,
      AUTH_ACCOUNTS_RELOAD_SECONDS: '1', // fast reload so the revocation case (i) doesn't wait 15s
      AUTH_SESSION_TTL_SECONDS: '3600',
      // MQTT_USERNAME/PASSWORD unset on purpose — the broker is anonymous here.
      MQTT_USERNAME: undefined as unknown as string,
      MQTT_PASSWORD: undefined as unknown as string,
      LIVE_TOKEN: undefined as unknown as string, // the bundled token is gone in Phase 2
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.push(server);

  // --- 4. wait until server is up AND subscribed to the (anonymous) broker -----------------------------
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

  // --- 5. a publisher (anonymous MQTT) so there is something to fan out on session A -------------------
  const { default: mqtt } = await import('mqtt');
  pub = mqtt.connect(MQTT_URL);
  await new Promise<void>((res, rej) => {
    pub!.on('connect', () => res());
    pub!.on('error', rej);
    setTimeout(() => rej(new Error('publisher MQTT connect timeout')), 8000);
  });

  // --- (a) login wrong password (with Origin) -> 401; login with NO Origin -> 403 ----------------------
  const badLogin = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: 'wrong-password' }),
  });
  assert(badLogin.status === 401, `wrong-password login should be 401, got ${badLogin.status}`);
  const badBody = (await badLogin.json()) as { error?: string };
  assert(badBody.error === 'invalid_credentials', `wrong-password error should be invalid_credentials, got ${badBody.error}`);

  const noOriginLogin = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' }, // NO Origin — strict gate must reject before any hash
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(noOriginLogin.status === 403, `no-Origin login should be 403, got ${noOriginLogin.status}`);

  // --- (b) login correct (with Origin) -> 200 + HttpOnly Set-Cookie + csrf in body, NO token in body ---
  const okLogin = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(okLogin.status === 200, `correct login should be 200, got ${okLogin.status}`);

  const setCookies = okLogin.headers.getSetCookie();
  const cookieLine = setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  assert(cookieLine !== undefined, `login response must Set-Cookie ${COOKIE_NAME}=; got ${JSON.stringify(setCookies)}`);
  assert(/;\s*HttpOnly/i.test(cookieLine!), 'session cookie must be HttpOnly');
  assert(!/;\s*Secure/i.test(cookieLine!), 'with AUTH_COOKIE_SECURE=false the cookie must NOT be Secure');
  // The cookie value we replay on every WS upgrade (verbatim "name=value", no attributes).
  const cookie = cookieLine!.split(';')[0].trim();
  const tokenValue = cookie.slice(COOKIE_NAME.length + 1);
  assert(tokenValue.length > 0, 'session cookie value is empty');

  const okBody = (await okLogin.json()) as Record<string, unknown>;
  assert(okBody.username === COACH, `login body username wrong: ${okBody.username}`);
  assert(okBody.role === 'coach', `login body role wrong: ${okBody.role}`);
  assert(Array.isArray(okBody.sessions) && (okBody.sessions as string[]).includes(SESSION_A),
    `login body sessions must include ${SESSION_A}, got ${JSON.stringify(okBody.sessions)}`);
  assert(okBody.wildcard === false, 'coach login body wildcard must be false');
  assert(okBody.anonymous === false, 'login body anonymous must be false');
  assert(typeof okBody.csrf === 'string' && (okBody.csrf as string).length > 0, 'login body must carry a non-empty csrf');
  const csrf = okBody.csrf as string;
  // The raw bearer token lives ONLY in the cookie — it must never be echoed in the JSON body.
  assert(!('token' in okBody), 'login body must NOT contain a raw token (token belongs only in the cookie)');
  assert(!JSON.stringify(okBody).includes(tokenValue), 'login body must not leak the cookie token value');

  // --- (c) WS to session A with {cookie,origin} -> receives the fanned-out telemetry envelope ----------
  const a = liveSocket(SESSION_A, { cookie, origin: ORIGIN });
  await sleep(300); // let the server-side open() subscribe to the room before we publish
  const good = {
    id: 'trk-01', pl: '01', ts: 1,
    lat: 44.8125, lon: 20.4612, spd: 3.2, hdg: 90,
    fix: 3, sats: 11, pdop: 1.2,
  };
  pub.publish(TOPIC_A, JSON.stringify(good), { qos: 0 });
  const aOut = await a.outcome;
  assert(!aOut.closed, `authorized WS to ${SESSION_A} should stay open, but closed ${aOut.code} '${aOut.reason}'`);
  assert(aOut.messages.length >= 1, `authorized WS should receive >=1 telemetry envelope, got ${aOut.messages.length}`);
  const env = aOut.messages[0];
  assert(env.event === 'telemetry', `envelope event was "${env.event}"`);
  assert(env.data.sessionId === SESSION_A && env.data.playerId === '01', 'fanned-out telemetry enriched wrong');

  // --- (d) WS to UNASSIGNED session B with {cookie,origin} -> 1008 'forbidden session' -----------------
  const b = await liveSocket(SESSION_B, { cookie, origin: ORIGIN }).outcome;
  assert(b.closed && b.code === 1008, `WS to unassigned ${SESSION_B} should close 1008, got closed=${b.closed} code=${b.code}`);
  assert(b.reason === 'forbidden session', `WS to ${SESSION_B} close reason should be 'forbidden session', got '${b.reason}'`);
  assert(b.messages.length === 0, `WS to ${SESSION_B} must receive nothing, got ${b.messages.length}`);

  // --- (e) WS with NO cookie -> 1008 'unauthorized'; WS with cookie but NO origin -> 1008 'forbidden origin'
  const noCookie = await liveSocket(SESSION_A, { origin: ORIGIN }).outcome;
  assert(noCookie.closed && noCookie.code === 1008, `no-cookie WS should close 1008, got closed=${noCookie.closed} code=${noCookie.code}`);
  assert(noCookie.reason === 'unauthorized', `no-cookie WS close reason should be 'unauthorized', got '${noCookie.reason}'`);
  assert(noCookie.messages.length === 0, `no-cookie WS must receive nothing, got ${noCookie.messages.length}`);

  const noOrigin = await liveSocket(SESSION_A, { cookie }).outcome;
  assert(noOrigin.closed && noOrigin.code === 1008, `no-Origin WS should close 1008, got closed=${noOrigin.closed} code=${noOrigin.code}`);
  assert(noOrigin.reason === 'forbidden origin', `no-Origin WS close reason should be 'forbidden origin', got '${noOrigin.reason}'`);

  // --- (e2) duplicate sessionId is last-wins under the pinned Elysia (NOT an array) — pin it so an upgrade
  // can't silently change the authz key. ?sessionId=sessA&sessionId=sessB must be governed by the LAST value
  // (sessB → forbidden), proving a duplicate param can never smuggle authz for the assigned sessA. ---------
  const dup = await new Promise<{ code: number; reason: string }>((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/live?sessionId=${SESSION_A}&sessionId=${SESSION_B}`, {
      headers: { cookie, origin: ORIGIN },
    } as unknown as string[]);
    openSockets.push(w);
    w.onclose = (e) => resolve({ code: e.code, reason: e.reason });
    w.onerror = () => { /* expected — rejected */ };
    setTimeout(() => resolve({ code: 0, reason: 'stayed-open' }), 1500);
  });
  assert(dup.code === 1008 && dup.reason === 'forbidden session',
    `duplicate sessionId must be governed by the LAST value (sessB → forbidden), got code=${dup.code} reason='${dup.reason}'`);

  // --- (f) logout CSRF/cookie negatives, THEN success (204), THEN the captured cookie is dead -----------
  // Wrong CSRF token must be rejected 403 (synchronizer-token check) — and must NOT have logged the session out.
  const badCsrf = await fetch(`http://127.0.0.1:${PORT}/auth/logout`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie, 'x-csrf-token': 'not-the-real-csrf' },
  });
  assert(badCsrf.status === 403, `logout with a wrong CSRF token should be 403, got ${badCsrf.status}`);
  // No cookie at all -> 401 (no session to act on), regardless of CSRF header.
  const noCookieLogout = await fetch(`http://127.0.0.1:${PORT}/auth/logout`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'x-csrf-token': csrf },
  });
  assert(noCookieLogout.status === 401, `logout with no cookie should be 401, got ${noCookieLogout.status}`);
  // The rejected logouts must NOT have revoked the session — /auth/me with the cookie is still authed.
  // (Checked via /auth/me rather than a WS so it doesn't add a second open sessA socket that would perturb
  // the ft_ws_clients drain assertion in case (h).)
  const stillMe = await fetch(`http://127.0.0.1:${PORT}/auth/me`, { headers: { cookie } });
  assert(stillMe.status === 200, `a rejected logout must not revoke the session — /auth/me should still be 200, got ${stillMe.status}`);

  // Now the real logout: Origin + correct X-CSRF-Token + cookie -> 204.
  const logoutRes = await fetch(`http://127.0.0.1:${PORT}/auth/logout`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf },
  });
  assert(logoutRes.status === 204, `logout should be 204, got ${logoutRes.status}`);
  // The critical pre-mortem fix: logout deletes the token server-side, so the captured cookie is dead.
  const replayed = await liveSocket(SESSION_A, { cookie, origin: ORIGIN }).outcome;
  assert(replayed.closed && replayed.code === 1008,
    `replayed-cookie WS after logout should close 1008, got closed=${replayed.closed} code=${replayed.code}`);
  assert(replayed.reason === 'unauthorized',
    `replayed-cookie WS after logout should be 'unauthorized' (server-side revocation), got '${replayed.reason}'`);
  assert(replayed.messages.length === 0, `replayed-cookie WS must receive nothing, got ${replayed.messages.length}`);

  // --- (g) /metrics reflects exactly what happened, and is NOT served on the public port ---------------
  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  const num = (re: RegExp): number | undefined => {
    const m = metricsText.match(re);
    return m ? Number(m[1]) : undefined;
  };
  assert((num(/ft_auth_logins_total\{result="success"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_auth_logins_total{result="success"} should be >= 1');
  assert((num(/ft_auth_logins_total\{result="failure"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_auth_logins_total{result="failure"} should be >= 1');
  assert((num(/ft_ws_rejected_total\{reason="not_authorized_for_session"\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_ws_rejected_total{reason="not_authorized_for_session"} should be >= 1');
  assert(/ft_auth_sessions_active(\{\})?\s+\d+/.test(metricsText),
    'metrics: ft_auth_sessions_active gauge should be present');
  // Anchor to the value line (^…$ multiline): the HELP/TYPE lines also contain the metric name, so an
  // un-anchored match could capture a digit from the help text rather than the sample value.
  assert(num(/^ft_anon_mode_active(?:\{\})?\s+(\d+)$/m) === 0, 'metrics: ft_anon_mode_active should be 0 (anon off)');
  // No child/player name (and no coach username) may ever appear as a metric label.
  assert(!metricsText.includes(COACH), 'metrics: a coach username must NEVER appear in /metrics');

  // /metrics must NOT be reachable on the public port (loopback-only, separate listener).
  const pubStatus = await fetch(`http://127.0.0.1:${PORT}/metrics`).then((r) => r.status).catch(() => 0);
  assert(pubStatus !== 200, `/metrics must not be served on the public port; got status ${pubStatus}`);

  // --- (h) regression: ft_ws_clients must DRAIN back to 0 after an admitted socket closes --------------
  // Guards the /live close path: the admit record must be keyed on the STABLE ws.data, not the per-callback
  // ElysiaWS wrapper (a fresh instance each callback) — else close() never finds it, the gauge never
  // decrements, and the revocation registry leaks a handle per socket. `a` (case c) is still open + admitted.
  const wsClientsA = async (): Promise<number> => {
    const txt = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
    const m = txt.match(/^ft_ws_clients\{session="sessA"\}\s+(-?\d+)$/m);
    return m ? Number(m[1]) : 0;
  };
  assert((await wsClientsA()) >= 1, 'ft_ws_clients{session=sessA} should be >=1 while the admitted socket is open');
  a.socket.close();
  let drained = false;
  for (let i = 0; i < 40; i++) {
    if ((await wsClientsA()) === 0) { drained = true; break; }
    await sleep(100);
  }
  assert(drained, 'ft_ws_clients{session=sessA} must return to 0 after the admitted socket closes (close-path gauge/registry regression)');

  // --- (i) revocation of an OPEN socket: removing the account (reload picks it up) closes the live feed ---
  // The strongest authz guarantee for a children's-location feed — a removed/reassigned coach must lose an
  // ALREADY-OPEN socket, not just be denied on the next upgrade. AUTH_ACCOUNTS_RELOAD_SECONDS=1 makes the
  // periodic reload fast; on reload the server re-evaluates open sockets and closes the now-unauthorized one.
  // Re-login first (the case-f logout deleted the earlier token).
  const relog = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(relog.status === 200, `re-login for the revocation case should be 200, got ${relog.status}`);
  const cookie2 = (relog.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? '').split(';')[0].trim();
  assert(cookie2.length > COOKIE_NAME.length + 1, 're-login must set a session cookie');

  const revoked = new WebSocket(`ws://127.0.0.1:${PORT}/live?sessionId=${SESSION_A}`, {
    headers: { cookie: cookie2, origin: ORIGIN },
  } as unknown as string[]);
  openSockets.push(revoked);
  const revClose = new Promise<{ code: number; reason: string }>((resolve) => {
    revoked.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  // Wait until it's actually admitted (open) before revoking, so we're closing a LIVE socket.
  await new Promise<void>((res) => {
    revoked.onopen = () => res();
    setTimeout(res, 2000);
  });
  await sleep(150);
  // Remove the coach from the accounts file; the next periodic reload (~1s) revokes the open socket.
  writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: [] }));
  const revResult = await Promise.race([
    revClose,
    sleep(5000).then(() => ({ code: -1, reason: 'TIMEOUT — socket was NOT closed on revocation' })),
  ]);
  assert(revResult.code === 1008,
    `an open socket must be closed 1008 when its account is removed (reload revocation), got code=${revResult.code} reason='${revResult.reason}'`);

  console.log('\n✅ AUTH E2E PASSED — cookie login, session-bound /live authz, no-cookie/no-origin rejected, logout revokes the cookie, ws_clients drains, /metrics correct');
  pub.end();
  for (const w of openSockets) { try { w.close(); } catch { /* noop */ } }
  for (const f of [ACCOUNTS_FILE, CONF_FILE]) { if (existsSync(f)) rmSync(f); }
  stop();
  process.exit(0);
} catch (err) {
  console.error('\n❌ AUTH E2E FAILED:', (err as Error).message);
  try { pub?.end(); } catch { /* noop */ }
  for (const w of openSockets) { try { w.close(); } catch { /* noop */ } }
  for (const f of [ACCOUNTS_FILE, CONF_FILE]) { try { if (existsSync(f)) rmSync(f); } catch { /* noop */ } }
  stop();
  process.exit(1);
}
