/**
 * Self-contained, hardware-free DoS-guard test for the unauthenticated /auth/login surface (Phase 2).
 * See server/src/server.ts (readJsonBody → 415 'unsupported_media_type' / 413 'too_large') and
 * server/src/auth.ts (attemptLogin → 429 'throttled' via the per-IP token bucket, 503 'busy' via
 * MAX_INFLIGHT_LOGINS).
 *
 * THREAT MODEL: /auth/login is reachable by anyone before any credential is verified. Each request can
 * cost an argon2id verify (CPU + RAM) that runs on the SAME Bun event loop as the ~100 msg/s MQTT ingest
 * for a children's-location feed. So the cheap guards MUST reject abusive traffic BEFORE the hash:
 *   - 415: a non-JSON Content-Type is rejected before parse (no body read into the hasher).
 *   - 413: an over-cap body (> 4096 UTF-8 bytes) is rejected before parse.
 *   - 429: the per-IP token bucket throttles a burst of logins from one client.
 *   - 503: a global concurrent-hash cap (MAX_INFLIGHT_LOGINS) sheds load when too many verifies are in flight.
 *
 * The Origin allow-list is checked FIRST (before any of the four guards), so EVERY request below carries a
 * valid Origin; the server is started with ALLOWED_ORIGINS pinned to that same origin.
 *
 * We spin the real server.ts ourselves and restart it (SEQUENTIALLY, same port) for the env configs the
 * 429 and 503 cases need (AUTH_LOGIN_BURST / MAX_INFLIGHT_LOGINS). No broker is needed — the auth endpoints
 * serve without one; MQTT_URL points at a dead port and the ingest connect error is ignored. Readiness is
 * the PUBLIC listener: poll GET /auth/me until it returns 401 (it needs no broker).
 *
 *   bun run test/auth-dos.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up the child process + temp files.
 */

import { existsSync, rmSync } from 'node:fs';

// Dedicated ports/file — chosen NOT to collide with any other test/tool: e2e.ts (3101/9465), auth-e2e
// (3104/9468), mosquitto-pub-demo (3102/9466), ws-origin (3103/9467), simulate (3000/9464). Ours: 3110/9470.
const PORT = 3110;
const METRICS_PORT = 9470;
// A port with nothing listening — the ingest will fail to connect; auth serves regardless. We never poll
// /health (which gates on mqtt), only the public /auth/me, so the dead broker does not block readiness.
const MQTT_URL = 'mqtt://127.0.0.1:1899';
const DB_PATH = '/tmp/ft-authdos.db';
const ACCOUNTS_FILE = '/tmp/ft-authdos-accounts.json';

const ORIGIN = 'http://localhost:5173';
const COACH = 'coach1';
const COACH_PW = 'coach1-pw';
const SESSION_S1 = 's1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const LOGIN_URL = `http://127.0.0.1:${PORT}/auth/login`;

// Fresh DB + accounts file each run.
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE]) {
  if (existsSync(f)) rmSync(f);
}

// One coach account: 'coach1', role coach, sessions ['s1'], argon2id hash of 'coach1-pw'. Written directly
// (no CLI) so this test owns nothing but its single file; the shape matches loadAccounts() in auth.ts.
const hash = await Bun.password.hash(COACH_PW, { algorithm: 'argon2id' });
await Bun.write(
  ACCOUNTS_FILE,
  JSON.stringify({
    accounts: [{ username: COACH, role: 'coach', sessions: [SESSION_S1], hash }],
  }),
);

// At most one server child is alive at a time; we kill it before starting the next config.
let child: { kill: () => void; exited: Promise<number> } | undefined;

/** Start server.ts with the base DoS-test env merged with `extra`; resolve once the public listener is up. */
async function startServer(extra: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT),
      METRICS_PORT: String(METRICS_PORT),
      MQTT_URL,
      DB_PATH,
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE,
      AUTH_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: ORIGIN,
      // Long reload/TTL so nothing churns under us; broker creds unset (no broker here).
      AUTH_ACCOUNTS_RELOAD_SECONDS: '3600',
      AUTH_SESSION_TTL_SECONDS: '3600',
      MQTT_USERNAME: undefined as unknown as string,
      MQTT_PASSWORD: undefined as unknown as string,
      LIVE_TOKEN: undefined as unknown as string,
      ...extra,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  child = proc;

  // Readiness = the PUBLIC listener answering /auth/me with 401 (no broker required). Origin not needed for
  // /auth/me (it only reads the cookie); we just need a definitive HTTP response from the public port.
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/auth/me`);
      if (res.status === 401) {
        await res.text(); // drain
        ready = true;
        break;
      }
      await res.text();
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  assert(ready, 'server public listener did not return 401 from /auth/me within 10s');
}

/** Kill the current server child and wait for it to exit, so the port is free for the next config. */
async function stopServer(): Promise<void> {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  try {
    await child.exited;
  } catch {
    /* ignore */
  }
  child = undefined;
  // Give the OS a beat to release the listen socket before we rebind the same port.
  await sleep(300);
}

const cleanupFiles = () => {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ACCOUNTS_FILE]) {
    try {
      if (existsSync(f)) rmSync(f);
    } catch {
      /* noop */
    }
  }
};

try {
  // ============================================================================================
  // CONFIG 1 — defaults: covers the 415 and 413 body-guard cases (origin OK; guards reject pre-parse).
  // ============================================================================================
  await startServer({});

  // --- (415) non-JSON Content-Type with a valid Origin -> 415 unsupported_media_type ----------
  const wrongCt = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: ORIGIN },
    body: '{}',
  });
  assert(wrongCt.status === 415, `text/plain login should be 415, got ${wrongCt.status}`);
  const wrongCtBody = (await wrongCt.json()) as { error?: string };
  assert(
    wrongCtBody.error === 'unsupported_media_type',
    `415 body error should be 'unsupported_media_type', got ${JSON.stringify(wrongCtBody)}`,
  );

  // --- (413) JSON body whose UTF-8 length exceeds MAX_BODY_BYTES (4096) -> 413 too_large -------
  // 5000 'a' chars in the username pushes the JSON well past 4096 bytes; the byte-length guard fires
  // even if Content-Length were absent/forged (here fetch sets it).
  const bigBody = JSON.stringify({ username: 'a'.repeat(5000), password: 'x' });
  assert(Buffer.byteLength(bigBody, 'utf8') > 4096, 'test fixture: oversized body must exceed 4096 bytes');
  const tooBig = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: bigBody,
  });
  assert(tooBig.status === 413, `oversized login should be 413, got ${tooBig.status}`);
  const tooBigBody = (await tooBig.json()) as { error?: string };
  assert(
    tooBigBody.error === 'too_large',
    `413 body error should be 'too_large', got ${JSON.stringify(tooBigBody)}`,
  );

  await stopServer();

  // ============================================================================================
  // CONFIG 2 — AUTH_LOGIN_BURST=3 (small per-IP bucket; inflight cap left high so it does NOT trip first).
  // A burst of SEQUENTIAL wrong-credential logins from loopback must start returning 429 'throttled'.
  // ============================================================================================
  await startServer({ AUTH_LOGIN_BURST: '3', MAX_INFLIGHT_LOGINS: '100' });

  let sawThrottle = false;
  let throttleBody: { error?: string } | undefined;
  // ~6 sequential POSTs: the bucket starts at 3 tokens and refills slowly (30s window), so the later ones
  // drain it to < 1 token and get 429 before any argon2id work. WRONG creds so a success can't refill state.
  for (let i = 0; i < 6; i++) {
    const res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: COACH, password: 'definitely-wrong' }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 429) {
      sawThrottle = true;
      throttleBody = body;
      // Don't break — confirm subsequent ones stay throttled too, but one is enough to assert.
    }
  }
  assert(sawThrottle, 'a burst of 6 logins with AUTH_LOGIN_BURST=3 must produce at least one 429');
  assert(
    throttleBody?.error === 'throttled',
    `429 body error should be 'throttled', got ${JSON.stringify(throttleBody)}`,
  );

  await stopServer();

  // ============================================================================================
  // CONFIG 3 — MAX_INFLIGHT_LOGINS=1 with AUTH_LOGIN_BURST=100 (so the per-IP bucket does NOT trip first).
  // Fire concurrent logins with VALID-FORMAT creds (real username 'coach1', wrong password) so each reaches
  // the argon2id verify and holds the single inflight slot; the overflow must shed as 503 'busy'.
  // ============================================================================================
  await startServer({ MAX_INFLIGHT_LOGINS: '1', AUTH_LOGIN_BURST: '100', AUTH_LOGIN_WINDOW_S: '60' });

  // Helper: fire N concurrent logins, return the set of statuses + the first 503 body seen.
  async function fireConcurrent(n: number): Promise<{ statuses: number[]; busyBody?: { error?: string } }> {
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        fetch(LOGIN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          // Valid-format creds (known user, wrong password) → each one reaches the argon2id verify and holds
          // the inflight slot long enough that concurrent peers overflow MAX_INFLIGHT_LOGINS=1 → 503.
          body: JSON.stringify({ username: COACH, password: 'wrong' }),
        })
          .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as { error?: string } }))
          .catch(() => ({ status: 0, body: {} as { error?: string } })),
      ),
    );
    let busyBody: { error?: string } | undefined;
    for (const r of results) if (r.status === 503 && !busyBody) busyBody = r.body;
    return { statuses: results.map((r) => r.status), busyBody };
  }

  // Timing-sensitive: an argon2id verify is fast, so the inflight slot may free before peers arrive. Retry
  // with rising concurrency; assert ">=1 of {503}" once observed. Each attempt is a fresh concurrent volley.
  let sawBusy = false;
  let busyBody: { error?: string } | undefined;
  for (const concurrency of [8, 16, 32, 48]) {
    const { statuses, busyBody: bb } = await fireConcurrent(concurrency);
    if (statuses.includes(503)) {
      sawBusy = true;
      busyBody = bb;
      break;
    }
    await sleep(50);
  }
  assert(sawBusy, 'concurrent logins with MAX_INFLIGHT_LOGINS=1 must produce at least one real 503 (busy)');
  assert(
    busyBody?.error === 'busy',
    `503 body error should be 'busy', got ${JSON.stringify(busyBody)}`,
  );

  await stopServer();

  console.log(
    '\n✅ AUTH DOS PASSED — /auth/login guards: 415 unsupported_media_type, 413 too_large, 429 throttled (per-IP bucket), 503 busy (inflight cap)',
  );
  cleanupFiles();
  process.exit(0);
} catch (err) {
  console.error('\n❌ AUTH DOS FAILED:', (err as Error).message);
  await stopServer();
  cleanupFiles();
  process.exit(1);
}
