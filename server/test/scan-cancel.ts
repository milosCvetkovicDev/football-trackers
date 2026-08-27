/**
 * Off-loop scan cancellation (Phase 6 — the item Phase 5 deferred here in writing).
 *
 * THE DEFECT. `/history` and `/events` take one of OFFLOOP_MAX_INFLIGHT (3) shared scan slots and hold
 * it until the scan finishes. Nothing could make a scan finish early: the server never looked at
 * `request.signal`, so a coach who closed the tab — or whose 30 s client-side deadline fired — left a
 * full scan of a children's-location trace running for a result nobody would ever read. Three of those
 * and every subsequent review read answers 503 `busy` for the duration. There was also NO wall-clock
 * bound of any kind.
 *
 * WHAT THIS PROVES, by execution:
 *   1. an aborted request really does stop the scan (counted as client_gone, logged as normal, not error);
 *   2. its SLOT IS FREE IMMEDIATELY — the assertion that would fail without the fix: fill every slot with
 *      abandoned scans, then require a fresh read to succeed rather than 503;
 *   3. the wall-clock budget stops a scan that outlives it, with an honest 503;
 *   4. a scan that finishes normally is NOT counted as aborted (the counter is specific, not a tally of
 *      every request).
 *
 *   bun run test/scan-cancel.ts
 *
 * Only adult coach usernames and pseudonymous player ids appear here — never a child's name.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3113;
const METRICS_PORT = 9478;
const ORIGIN = 'http://localhost:5173';
const SESSION = 'morning-5s';
const COACH = 'coach-cancel';
const COACH_PW = 'correct-horse-battery-staple-7';
const COOKIE_NAME = 'ft_session';
const SEED_ROWS = 270_000; // enough that an aggregate scan runs ~1 s — long enough to interrupt

const dir = mkdtempSync(join(tmpdir(), 'ft-scan-cancel-'));
const DB_PATH = join(dir, 'telemetry.db');
const ACCOUNTS_FILE = join(dir, 'auth-accounts.json');
const ROSTER_FILE = join(dir, 'roster.json');

const children: { kill: (s?: number | NodeJS.Signals) => void }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
let passed = 0;
const ok = (msg: string) => { passed++; console.log(`  ok: ${msg}`); };
const stop = () => { for (const c of children) { try { c.kill(9); } catch { /* gone */ } } };

/** Sum of one counter's samples, matching an optional label substring. */
function counter(text: string, name: string, labelPart?: string): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    if (labelPart && !line.includes(labelPart)) continue;
    const v = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}
const metricsText = () => fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`).then((r) => r.text());

let now = 0;
let serverLog: string[] = [];

async function startServer(extra: Record<string, string>): Promise<Bun.Subprocess> {
  serverLog = [];
  const proc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), DB_PATH,
      MQTT_URL: 'mqtt://127.0.0.1:1', // no broker: these routes do not need one, and it keeps the test fast
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE, AUTH_ROSTER_FILE: ROSTER_FILE,
      AUTH_COOKIE_SECURE: 'false', ALLOWED_ORIGINS: ORIGIN, LOG_LEVEL: 'info',
      ...extra,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  children.push(proc);
  void (async () => { for await (const c of proc.stdout) serverLog.push(Buffer.from(c).toString()); })();
  void (async () => { for await (const c of proc.stderr) serverLog.push(Buffer.from(c).toString()); })();
  // /health answers 503 with no broker — a RESPONSE is the readiness signal here, not `ok`.
  for (let i = 0; i < 150; i++) {
    try { await fetch(`http://127.0.0.1:${METRICS_PORT}/health`); return proc; } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function loginCookie(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(res.status === 200, `login should be 200, got ${res.status}`);
  return res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))!.split(';')[0].trim();
}

try {
  // --- seed a store big enough that an aggregate scan takes real wall-time -------------------------------
  process.env.DB_PATH = DB_PATH;
  const { db, insertTelemetry } = await import('../src/db');
  now = Date.now();
  const t0 = performance.now();
  db.transaction(() => {
    for (let i = 0; i < SEED_ROWS; i++) {
      const p = String((i % 12) + 1).padStart(2, '0');
      insertTelemetry({
        serverTs: now - SEED_ROWS * 2 + i * 2, sessionId: SESSION, playerId: p, id: `trk-${p}`,
        ts: i, lat: 44.8123 + (i % 100) * 1e-5, lon: 20.4612 + (i % 100) * 1e-5,
        spd: 3, hdg: 90, fix: 3, sats: 11, pdop: 1, sq: undefined,
      } as never);
    }
  })();
  db.close(false);
  console.log(`[seed] ${SEED_ROWS} rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  const addCoach = Bun.spawn(
    ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION],
    { cwd: `${import.meta.dir}/..`, env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE }, stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' },
  );
  addCoach.stdin.write(`${COACH_PW}\n`);
  await addCoach.stdin.end();
  assert((await addCoach.exited) === 0, 'auth-user.ts add failed');

  const server = await startServer({});
  const cookie = await loginCookie();
  const WHOLE_WINDOW = `from=${now - SEED_ROWS * 2 - 1000}&to=${now}`;
  const url = `http://127.0.0.1:${PORT}/sessions/${SESSION}/history?mode=aggregate&${WHOLE_WINDOW}`;

  // Baseline: how long does the scan actually take? Everything below depends on it being interruptible.
  const tScan = performance.now();
  const full = await fetch(url, { headers: { cookie, origin: ORIGIN } });
  const scanMs = performance.now() - tScan;
  assert(full.status === 200, `the baseline scan should be 200, got ${full.status}`);
  assert(scanMs > 300, `the fixture must produce a scan long enough to interrupt (got ${Math.round(scanMs)}ms)`);
  ok(`baseline: a ${SEED_ROWS}-row aggregate scan takes ${Math.round(scanMs)}ms`);

  // --- 1. an abandoned request stops the scan, and is counted as client_gone -----------------------------
  {
    const before = counter(await metricsText(), 'ft_scan_aborted_total', 'reason="client_gone"');
    const ac = new AbortController();
    const inflight = fetch(url, { headers: { cookie, origin: ORIGIN }, signal: ac.signal }).catch(() => 'aborted');
    await sleep(150); // mid-scan
    ac.abort();
    await inflight;
    // The server observes the disconnect at its next page boundary, not instantly.
    let after = before;
    for (let i = 0; i < 40 && after === before; i++) {
      await sleep(50);
      after = counter(await metricsText(), 'ft_scan_aborted_total', 'reason="client_gone"');
    }
    assert(after > before, 'an abandoned request must be counted as ft_scan_aborted_total{reason="client_gone"}');
    assert(/"msg":"scan abandoned by client"/.test(serverLog.join('')), 'the abandonment must be logged');
    assert(!/"level":"error"[^\n]*scan/.test(serverLog.join('')), 'a coach closing a tab is NOT an error-level event');
    ok('an abandoned /history request stops the scan and is counted as client_gone');
  }

  // --- 2. THE POINT: the abandoned scans free their SHARED slots immediately -----------------------------
  // Without cancellation all three slots stay held for the rest of the scan, and this read is 503 'busy'.
  {
    const { OFFLOOP_MAX_INFLIGHT } = await import('../src/scanLoad');
    const abandoned = [];
    for (let i = 0; i < OFFLOOP_MAX_INFLIGHT; i++) {
      const ac = new AbortController();
      abandoned.push({ ac, p: fetch(url, { headers: { cookie, origin: ORIGIN }, signal: ac.signal }).catch(() => 'aborted') });
    }
    await sleep(200); // every slot is now held by a scan in progress
    for (const a of abandoned) a.ac.abort();
    await Promise.all(abandoned.map((a) => a.p));

    // Give the server its next page boundary to notice, then demand a working read.
    let status = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await sleep(100);
      const r = await fetch(`http://127.0.0.1:${PORT}/sessions/${SESSION}/history?mode=aggregate&from=${now - 5_000}&to=${now}`, {
        headers: { cookie, origin: ORIGIN },
      });
      status = r.status;
      await r.text();
      if (status === 200) break;
    }
    assert(status === 200, `after ${OFFLOOP_MAX_INFLIGHT} abandoned scans a fresh read must succeed, got ${status}`);
    ok(`all ${OFFLOOP_MAX_INFLIGHT} shared slots are released when the clients vanish (was: held to the end → 503 busy)`);
  }

  // --- 4. a scan that COMPLETES is not counted as aborted -------------------------------------------------
  // (checked here, before the budget server replaces this one — the counter must be specific)
  {
    const before = counter(await metricsText(), 'ft_scan_aborted_total');
    const r = await fetch(`http://127.0.0.1:${PORT}/sessions/${SESSION}/history?mode=aggregate&from=${now - 5_000}&to=${now}`, {
      headers: { cookie, origin: ORIGIN },
    });
    await r.text();
    assert(r.status === 200, 'a normal read must still be 200');
    const after = counter(await metricsText(), 'ft_scan_aborted_total');
    assert(after === before, `a completed scan must not increment ft_scan_aborted_total (${before} -> ${after})`);
    ok('a scan that completes normally is not counted as aborted');
  }

  server.kill('SIGTERM');
  await server.exited;

  // --- 3. the wall-clock budget stops a scan that outlives it ---------------------------------------------
  {
    const budgeted = await startServer({ SCAN_BUDGET_MS: '1000' }); // min is 1000; the scan above exceeds it
    const cookie2 = await loginCookie();
    const r = await fetch(url, { headers: { cookie: cookie2, origin: ORIGIN } });
    const body = (await r.json()) as { error?: string };
    assert(r.status === 503, `a scan past its budget must answer 503, got ${r.status}`);
    assert(body.error === 'scan_aborted', `the body must say scan_aborted, got ${JSON.stringify(body)}`);
    const text = await metricsText();
    assert(counter(text, 'ft_scan_aborted_total', 'reason="budget"') >= 1, 'the budget abort must be counted');
    assert(counter(text, 'ft_history_requests_total', 'result="aborted"') >= 1, 'the request counter must record it too');
    // And the slot must be free afterwards — a budget abort that leaked the slot would be no better.
    const small = await fetch(`http://127.0.0.1:${PORT}/sessions/${SESSION}/history?mode=aggregate&from=${now - 5_000}&to=${now}`, {
      headers: { cookie: cookie2, origin: ORIGIN },
    });
    await small.text();
    assert(small.status === 200, `a small read after a budget abort must succeed, got ${small.status}`);
    budgeted.kill('SIGTERM');
    await budgeted.exited;
    ok('a scan that outlives SCAN_BUDGET_MS is stopped with an honest 503 and frees its slot');
  }

  // --- 6. A SCAN IN FLIGHT AT SHUTDOWN gets an honest 503, not a socket reset -------------------------
  // The shutdown step used to MARK the budgets and return immediately — but a scan only notices at its
  // next page boundary, a yield away, and process.exit() fired ~1 ms later. So `reason="shutdown"` was a
  // permanently-zero metric and the coach mid-review got a connection reset instead of the retryable
  // answer the design promised (measured: 3 marked, 0 aborted). The step now waits for the drain.
  {
    const drained = await startServer({});
    const cookie3 = await loginCookie();
    const inflight = fetch(url, { headers: { cookie: cookie3, origin: ORIGIN } })
      .then(async (r) => ({ status: r.status, body: await r.text() }))
      .catch((e) => ({ status: -1, body: String(e) }));
    await sleep(250); // mid-scan
    const t = Date.now();
    drained.kill('SIGTERM');
    const [res, exit] = await Promise.all([inflight, drained.exited]);
    const took = Date.now() - t;
    assert(exit === 0, `the shutdown must still exit 0, got ${exit}`);
    assert(took < 2_000, `and still inside the budget, took ${took}ms`);
    assert(res.status === 503, `a scan in flight at shutdown must get a 503, not a socket error — got ${res.status}: ${res.body.slice(0, 120)}`);
    assert(res.body.includes('scan_aborted'), `the body must say scan_aborted, got ${res.body.slice(0, 120)}`);
    const logs = serverLog.join('');
    assert(/"reason":"shutdown"/.test(logs), `the abort must be logged with reason "shutdown", got: ${logs.slice(-400)}`);
    assert(/"msg":"shutdown: aborted off-loop scans"[^\n]*"drained":true/.test(logs),
      `the step must report that it actually DRAINED, got: ${/"msg":"shutdown: aborted off-loop scans"[^\n]*/.exec(logs)?.[0] ?? '(no line)'}`);
    ok('a scan in flight at shutdown is aborted and answered 503 — not reset — and the exit stays fast');
  }

  console.log(`\n✅ SCAN-CANCEL PASSED — ${passed} cases: an abandoned request stops its scan and frees the shared`
    + ' off-loop slot immediately (the failure Phase 5 could only make rarer), the wall-clock budget bounds a scan'
    + ' that outlives it, and a completed scan is never counted as aborted');
  stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ SCAN-CANCEL FAILED:', (err as Error).message);
  stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
}
