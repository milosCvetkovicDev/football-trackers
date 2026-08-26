/**
 * Self-contained, hardware-free end-to-end test of the client beacon (Phase 5; audit §6 "Client":
 * *no client observability*).
 *
 * WHAT THE ENDPOINT IS. Everything this system measures today stops at the server's own process
 * boundary. If the coach's tablet exhausts its reconnect budget, or the review view crashes into its
 * error boundary, or a fetch hits its deadline, the server sees NOTHING: `/metrics` stays green while
 * the touchline stares at a dead screen. `POST /sessions/:id/client-beacon` closes that gap with the
 * narrowest thing that answers "did the coach's view break?" — a FIXED four-value enum, and nothing else.
 *
 * WHAT IT MUST NOT BECOME. It runs on a device displaying children's live positions, so this test
 * pins the minimisation as hard as the function:
 *   - the body carries EXACTLY {kind} from a closed vocabulary; a free-text kind is rejected 400 and
 *     can never reach the exposition (an unbounded label would also be the §S-5 cardinality bug again);
 *   - the metric carries the KIND only — no session label, no player label, no user agent;
 *   - the endpoint reuses the SAME sessionGetGate as /roster + /config, so an unauthenticated or
 *     wrong-session caller cannot use it to probe which session ids exist;
 *   - a POST demands a STRICT Origin (browsers always send one on POST), so it is not a CSRF lever;
 *   - it is rate-limited, body-size-capped, and answers 204 with no body — nothing to exfiltrate.
 *
 * Ports/files are dedicated and do NOT collide with the other suites (e2e 3101/9465/1883, roster-e2e
 * 3102/9466/1885, device-health 3103/9467/1886, auth-e2e 3104/9468/1885, history-e2e 3105/9469/1888,
 * config-e2e 3106/9471/1889, auth-dos 3110/9470, anon-scope 9472/1890): we take 3107/9473/1891.
 *
 *   bun run test/beacon-e2e.ts        (or: bun run test:beacon-e2e)
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up the child processes + temp files.
 */

import { existsSync, rmSync } from 'node:fs';

const PORT = 3107;
const METRICS_PORT = 9473;
const BROKER_PORT = 1891;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = '/tmp/ft-beacon-e2e.db';
const ACCOUNTS_FILE = '/tmp/ft-beacon-e2e-accounts.json';
const CONF_FILE = '/tmp/ft-beacon-e2e-mosquitto.conf';

const ORIGIN = 'http://localhost:5173';
const BAD_ORIGIN = 'http://evil.example';

const COACH = 'coach-beacon';
const COACH_PW = 'coach-beacon-pw';
const SESSION = 'sessBeacon';
const OTHER_SESSION = 'sessOther'; // the coach is NOT assigned this one → 403
const COOKIE_NAME = 'ft_session'; // AUTH_COOKIE_SECURE=false ⇒ no __Host- prefix

// The closed vocabulary — must match BEACON_KINDS in client/src/beacon.ts and the server allow-list.
const KINDS = ['ws_gave_up', 'ws_manual_retry', 'render_error', 'fetch_timeout'] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONF_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => { try { c.kill(); } catch { /* already gone */ } });

let serverLog = '';
const beaconUrl = (id: string) => `http://127.0.0.1:${PORT}/sessions/${encodeURIComponent(id)}/client-beacon`;

/** POST one beacon with explicit control over every header the gate looks at. */
async function beacon(
  id: string,
  body: unknown,
  opts: { cookie?: string; origin?: string | null; contentType?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  headers['content-type'] = opts.contentType ?? 'application/json';
  return fetch(beaconUrl(id), {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

try {
  // --- 1. provision the coach (assigned to SESSION only) ------------------------------------------------
  const add = Bun.spawn(
    ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION],
    {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE },
      stdin: 'pipe', stdout: 'ignore', stderr: 'inherit',
    },
  );
  add.stdin.write(`${COACH_PW}\n`);
  await add.stdin.end();
  assert((await add.exited) === 0, 'auth-user.ts add (coach) failed');

  // --- 2. anonymous broker (the auth under test is the SERVER gate, not broker ACLs) --------------------
  await Bun.write(CONF_FILE, `listener ${BROKER_PORT} 127.0.0.1\nallow_anonymous true\n`);
  const mosquittoBin = Bun.which('mosquitto') ?? 'mosquitto';
  children.push(Bun.spawn([mosquittoBin, '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' }));

  // --- 3. the real server, auth on, strict Origin, a SMALL beacon rate budget so the 429 path is
  // reachable in a test without hammering (the default is a per-match budget, not a per-test one) -------
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE,
      AUTH_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: ORIGIN,
      AUTH_ACCOUNTS_RELOAD_SECONDS: '3600',
      AUTH_SESSION_TTL_SECONDS: '3600',
      // A burst of 20 with a 10/s refill: the §(d) flood still outruns it (it issues 30 back to back in
      // milliseconds), while burst/perMin keeps the sweep's "fully refilled" floor at 2 s — which is what
      // lets §(g) prove the sweep RUNS without a 60 s test. The floor is deliberately not bypassable:
      // sweeping a half-refilled bucket would hand back a full burst.
      BEACON_RATE_BURST: '20',
      BEACON_RATE_PER_MIN: '600',
      BEACON_BUCKET_IDLE_MS: '2000',
      LOG_LEVEL: 'info',
      MQTT_USERNAME: undefined as unknown as string,
      MQTT_PASSWORD: undefined as unknown as string,
      LIVE_TOKEN: undefined as unknown as string,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  children.push(server);
  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      serverLog += text;
      process.stdout.write(text);
    }
  };
  void drain(server.stdout as unknown as ReadableStream<Uint8Array>);
  void drain(server.stderr as unknown as ReadableStream<Uint8Array>);

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
  // (a) AUTHZ — the SAME gate as /roster + /config, in the same order
  // ====================================================================================================

  // (a1) no cookie → 401, and the same for a MALFORMED session id (no session-id-validity oracle).
  const noCookie = await beacon(SESSION, { kind: 'ws_gave_up' });
  assert(noCookie.status === 401, `no-cookie beacon should be 401, got ${noCookie.status}`);
  await noCookie.text();
  const noCookieMalformed = await beacon('bad id!!', { kind: 'ws_gave_up' });
  assert(noCookieMalformed.status === 401,
    `no-cookie + malformed id must be 401 (no oracle), got ${noCookieMalformed.status}`);
  await noCookieMalformed.text();

  // (a2) log in.
  const login = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(login.status === 200, `coach login should be 200, got ${login.status}`);
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))!.split(';')[0].trim();

  // (a3) bad Origin → 403. A POST is state-changing, so Origin is checked STRICTLY here.
  const badOrigin = await beacon(SESSION, { kind: 'ws_gave_up' }, { cookie, origin: BAD_ORIGIN });
  assert(badOrigin.status === 403, `bad-Origin beacon should be 403, got ${badOrigin.status}`);
  await badOrigin.text();

  // (a4) MISSING Origin → 403 too. Unlike the GET reads (where a same-origin browser omits Origin), a
  // browser ALWAYS sends Origin on POST — so "absent" here means a non-browser caller, and allowing it
  // would reopen the CSRF hole the strict check exists to close.
  const noOrigin = await beacon(SESSION, { kind: 'ws_gave_up' }, { cookie, origin: null });
  assert(noOrigin.status === 403, `Origin-less POST should be 403, got ${noOrigin.status}`);
  await noOrigin.text();

  // (a5) authed but NOT assigned this session → 403 (and no counter for that session is created).
  const wrongSession = await beacon(OTHER_SESSION, { kind: 'ws_gave_up' }, { cookie });
  assert(wrongSession.status === 403, `wrong-session beacon should be 403, got ${wrongSession.status}`);
  await wrongSession.text();

  // ====================================================================================================
  // (b) THE HAPPY PATH — 204, empty body, one counted event per kind
  // ====================================================================================================
  const ok = await beacon(SESSION, { kind: 'ws_gave_up' }, { cookie });
  assert(ok.status === 204, `authorised beacon should be 204, got ${ok.status}`);
  assert((await ok.text()) === '', 'a beacon response must have NO body (nothing to read back)');
  for (const kind of KINDS.slice(1)) {
    const r = await beacon(SESSION, { kind }, { cookie });
    assert(r.status === 204, `beacon kind=${kind} should be 204, got ${r.status}`);
    await r.text();
  }

  // ====================================================================================================
  // (c) THE BODY IS A CLOSED VOCABULARY — everything else is refused
  // ====================================================================================================
  for (const [why, body, expected] of [
    ['unknown kind', { kind: 'exfiltrate' }, 400],
    ['kind is not a string', { kind: 42 }, 400],
    ['no kind at all', { session: 'x' }, 400],
    ['a name smuggled alongside', { kind: 'render_error', displayName: 'Alex M.' }, 400],
    ['array body', [1, 2, 3], 400],
    ['not JSON at all', 'kind=render_error', 400],
  ] as Array<[string, unknown, number]>) {
    const r = await beacon(SESSION, body, { cookie });
    assert(r.status === expected, `${why}: expected ${expected}, got ${r.status}`);
    await r.text();
  }
  // A wrong content-type is refused BEFORE the parse (415), like /auth/login.
  const wrongCt = await beacon(SESSION, { kind: 'render_error' }, { cookie, contentType: 'text/plain' });
  assert(wrongCt.status === 415, `text/plain beacon should be 415, got ${wrongCt.status}`);
  await wrongCt.text();
  // An oversized body is refused (413) — the beacon has no reason to accept a payload at all.
  const huge = await beacon(SESSION, { kind: 'render_error', pad: 'x'.repeat(4_000) }, { cookie });
  assert(huge.status === 413, `oversized beacon should be 413, got ${huge.status}`);
  await huge.text();

  // ====================================================================================================
  // (d) RATE LIMIT — a broken view retrying in a loop cannot become a request flood
  // ====================================================================================================
  let sawRateLimit = false;
  for (let i = 0; i < 30; i++) {
    const r = await beacon(SESSION, { kind: 'ws_manual_retry' }, { cookie });
    await r.text();
    if (r.status === 429) { sawRateLimit = true; break; }
  }
  assert(sawRateLimit, 'a beacon flood must eventually be rate-limited (429)');

  // ====================================================================================================
  // (e) /metrics — kind-labelled counts, and NOTHING else
  // ====================================================================================================
  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  const num = (re: RegExp): number | undefined => {
    const m = metricsText.match(re);
    return m ? Number(m[1]) : undefined;
  };
  assert(metricsText.includes('ft_client_events_total'), 'metrics: ft_client_events_total must be exposed');
  for (const kind of KINDS) {
    const v = num(new RegExp(`ft_client_events_total\\{kind="${kind}"\\}\\s+(\\d+)`));
    assert((v ?? 0) >= 1, `metrics: ft_client_events_total{kind="${kind}"} should be >= 1, got ${v}`);
  }
  // The rejected free-text kind must NOT have created a series — this is the §S-5 cardinality rule.
  assert(!metricsText.includes('exfiltrate'), 'metrics: a rejected kind must never appear in the exposition');
  // NO session/player label on the event counter (no session enumeration oracle, bounded cardinality).
  assert(!/ft_client_events_total\{[^}]*session=/.test(metricsText),
    'metrics: ft_client_events_total must NEVER carry a session label');
  assert(!/ft_client_events_total\{[^}]*player=/.test(metricsText),
    'metrics: ft_client_events_total must NEVER carry a player label');
  // Per-result request accounting, mirroring ft_roster_requests_total / ft_config_requests_total.
  for (const result of ['ok', 'unauthorized', 'forbidden_origin', 'forbidden', 'bad_kind', 'rate_limited']) {
    const v = num(new RegExp(`ft_client_beacon_requests_total\\{result="${result}"\\}\\s+(\\d+)`));
    assert((v ?? 0) >= 1, `metrics: ft_client_beacon_requests_total{result="${result}"} should be >= 1, got ${v}`);
  }

  // ====================================================================================================
  // (g) THE RATE-LIMIT MAP IS SWEPT — a memory bound, not just a request bound
  // ====================================================================================================
  // This is the ONE limiter that admits the anonymous principal, so its key is the CLIENT IP rather than
  // a bounded username set: without a sweep every distinct source address would add a permanent entry
  // (the checker's finding). The gauge is the observable — it must return to ~0 once the buckets go idle.
  const bucketsNow = async (): Promise<number> => {
    const text = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
    const m = text.match(/ft_client_beacon_buckets\s+(\d+)/);
    return m ? Number(m[1]) : -1;
  };
  // The gauge samples on a 5 s timer while the sweep runs every 2 s, so keep touching the bucket until
  // a tick observes it — otherwise the sweep can legitimately remove it before the gauge ever looks.
  let peak = 0;
  for (let i = 0; i < 12 && peak < 1; i++) {
    await (await beacon(SESSION, { kind: 'ws_manual_retry' }, { cookie })).text(); // 204 or 429; both touch it
    await sleep(1_000);
    peak = await bucketsNow();
  }
  assert(peak >= 1, `expected at least one retained beacon bucket while active, got ${peak}`);
  // Now go quiet for longer than BEACON_BUCKET_IDLE_MS and let both the sweep and the gauge tick.
  let after = peak;
  for (let i = 0; i < 15 && after > 0; i++) {
    await sleep(1_000);
    after = await bucketsNow();
  }
  assert(after === 0, `idle beacon buckets must be swept, still ${after} retained`);

  // ====================================================================================================
  // (f) NAME/PII GUARD (§0.1) — nothing the client sent can echo into the log or the exposition
  // ====================================================================================================
  for (const bad of ['Alex M.', 'displayName', 'exfiltrate']) {
    assert(!serverLog.includes(bad), `the audit log must not echo "${bad}"`);
    assert(!metricsText.includes(bad), `/metrics must not contain "${bad}"`);
  }

  console.log('\n✅ BEACON E2E PASSED — POST /sessions/:id/client-beacon reuses the session gate (401 even on a '
    + 'malformed id, strict Origin incl. Origin-less→403, wrong-session→403), 204 with no body on success, a '
    + 'closed four-value vocabulary (unknown/typed/oversized/non-JSON refused), rate-limited with a SWEPT '
    + 'bucket map (ft_client_beacon_buckets returns to 0), and '
    + 'ft_client_events_total is labelled by KIND only — no session, no player, no echoed input');
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONF_FILE]) {
    if (existsSync(f)) rmSync(f);
  }
  stop();
  process.exit(0);
} catch (err) {
  console.error('\n❌ BEACON E2E FAILED:', (err as Error).message);
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE, CONF_FILE]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* noop */ }
  }
  stop();
  process.exit(1);
}
