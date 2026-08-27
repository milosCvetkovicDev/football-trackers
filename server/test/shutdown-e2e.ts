/**
 * Graceful-shutdown e2e (audit §8 Phase 6, acceptance criterion 1: "`docker stop` exits 0 (not 137) in
 * under 2 s"). This is the in-process half of that criterion — the container half is proven against a
 * real `docker stop` in the Phase 6 acceptance run (docs/audit/...), and needs Docker, so it does not
 * live in the gate.
 *
 * The baseline being fixed, measured on the dev stack before this phase: `docker stop ft-server` →
 * **exit 137 (SIGKILL) after 1.3 s**. `sh` was PID 1, so Bun never saw the signal and no teardown ran.
 *
 * What is asserted here, and why each one is worth a test:
 *   A. SIGTERM → exit 0, inside the budget, with the teardown steps in the DECLARED ORDER. Order is the
 *      whole design (drain → stop producing → stop listening → touch the store last), and an ordering
 *      regression is invisible in every other test.
 *   B. a coach's /live socket is actually closed, rather than left to time out.
 *   C. a coach stays LOGGED IN across the restart, the handover file is 0600 while it exists, and it is
 *      CONSUMED (single use — a stale file must never resurrect sessions later).
 *   D. an uncaughtException runs the same teardown and exits 1 (not 0 — a restart must be triggered).
 *   E. an unhandledRejection does NOT kill the server; it is counted instead.
 *   F. a second signal stops waiting and exits non-zero.
 *
 *   bun run test/shutdown-e2e.ts
 *
 * Only adult coach usernames and pseudonymous ids appear here — never a child's name.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3112;
const METRICS_PORT = 9475;
const BROKER_PORT = 1892;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const ORIGIN = 'http://localhost:5173';
const SESSION = 'morning-5s';
const COACH = 'coach-shutdown';
const COACH_PW = 'correct-horse-battery-staple-6';
const COOKIE_NAME = 'ft_session'; // AUTH_COOKIE_SECURE=false → un-prefixed

/** The whole point of the phase: a clean exit must be comfortably inside `docker stop`'s grace period. */
const BUDGET_MS = 2_000;

const dir = mkdtempSync(join(tmpdir(), 'ft-shutdown-'));
const DB_PATH = join(dir, 'telemetry.db');
const ACCOUNTS_FILE = join(dir, 'auth-accounts.json');
const ROSTER_FILE = join(dir, 'roster.json');
// The handover file lives in its OWN directory. One case below makes that directory unwritable to prove
// a handover that cannot be CONSUMED restores nothing — and chmod'ing the shared temp dir would also stop
// SQLite creating the store's -wal/-shm sidecars, so the server would fail to start for the wrong reason
// (it did, on Linux CI, while passing on macOS where the sidecars happened to survive).
const HANDOVER_DIR = join(dir, 'handover');
const SESSIONS_FILE = join(HANDOVER_DIR, 'auth-sessions.json');
const CONF_FILE = join(dir, 'mosquitto.conf');

const children: { kill: (sig?: number | NodeJS.Signals) => void }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
let passed = 0;
const ok = (msg: string) => { passed++; console.log(`  ok: ${msg}`); };

function stop(): void {
  for (const c of children) { try { c.kill(9); } catch { /* already gone */ } }
}

interface Started {
  proc: Bun.Subprocess;
  logs: () => string;
}

function startServer(extraEnv: Record<string, string> = {}): Started {
  const lines: string[] = [];
  const proc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE, AUTH_ROSTER_FILE: ROSTER_FILE, AUTH_SESSIONS_FILE: SESSIONS_FILE,
      AUTH_COOKIE_SECURE: 'false', ALLOWED_ORIGINS: ORIGIN, LOG_LEVEL: 'debug',
      ...extraEnv,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  children.push(proc);
  void (async () => { for await (const c of proc.stdout) lines.push(Buffer.from(c).toString()); })();
  void (async () => { for await (const c of proc.stderr) lines.push(Buffer.from(c).toString()); })();
  return { proc, logs: () => lines.join('') };
}

async function waitReady(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const b = (await (await fetch(`http://127.0.0.1:${METRICS_PORT}/health`)).json()) as { ok: boolean; mqtt: boolean };
      if (b.ok && b.mqtt) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not become ready');
}

async function login(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: COACH, password: COACH_PW }),
  });
  assert(res.status === 200, `coach login should be 200, got ${res.status}`);
  return res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))!.split(';')[0].trim();
}

/** Index of a log line, or -1 — used to assert the teardown ORDER, not merely its occurrence. */
const at = (logs: string, needle: string): number => logs.indexOf(needle);

try {
  // --- fixtures: a broker, an account, an empty roster --------------------------------------------------
  mkdirSync(HANDOVER_DIR, { recursive: true });
  writeFileSync(CONF_FILE, `listener ${BROKER_PORT} 127.0.0.1\nallow_anonymous true\n`);
  children.push(Bun.spawn([Bun.which('mosquitto') ?? 'mosquitto', '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' }));

  const addCoach = Bun.spawn(
    ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION],
    { cwd: `${import.meta.dir}/..`, env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE }, stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' },
  );
  addCoach.stdin.write(`${COACH_PW}\n`);
  await addCoach.stdin.end();
  assert((await addCoach.exited) === 0, 'auth-user.ts add failed');

  // ── A + B + C(part 1): SIGTERM on a live server with a connected coach ──────────────────────────────
  const first = startServer();
  await waitReady();
  const cookie = await login();

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live?sessionId=${SESSION}`, {
    headers: { cookie, origin: ORIGIN },
  } as unknown as string[]);
  const closed = new Promise<number>((resolve) => { ws.onclose = (e) => resolve(e.code); });
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    setTimeout(() => rej(new Error('/live connect timeout')), 8_000);
  });
  // The hello frame proves the socket is really subscribed, not merely accepted.
  await new Promise<void>((res, rej) => {
    ws.onmessage = () => res();
    setTimeout(() => rej(new Error('no hello frame')), 5_000);
  });

  const t0 = Date.now();
  first.proc.kill('SIGTERM');
  const code = await first.proc.exited;
  const elapsed = Date.now() - t0;

  assert(code === 0, `SIGTERM must exit 0 (the audit measured 137 before this phase), got ${code}`);
  assert(elapsed < BUDGET_MS, `shutdown must finish inside ${BUDGET_MS}ms, took ${elapsed}ms`);
  ok(`SIGTERM → exit 0 in ${elapsed}ms (was: exit 137, no teardown at all)`);

  {
    const logs = first.logs();
    assert(at(logs, '"shutdown: draining"') >= 0, 'the teardown must announce itself');
    assert(at(logs, '"shutdown: complete"') >= 0, 'the teardown must report completion');
    // ORDER: listeners must close BEFORE the store is closed. Reversed, a request in flight would hit a
    // closed database — which is precisely the class of bug an ordered teardown exists to prevent.
    const listeners = at(logs, '"step":"listeners"');
    const dbClosed = at(logs, '"msg":"db closed"');
    assert(listeners >= 0, 'the listeners step must run');
    assert(dbClosed >= 0, 'the db must be closed, not just abandoned');
    assert(listeners < dbClosed, 'listeners must close BEFORE the store');
    // And draining must precede both — /health has to stop saying "healthy" first.
    assert(at(logs, '"shutdown: draining"') < listeners, 'draining must precede the listener close');
    ok('teardown ran in the declared order: drain → … → listeners → db close');
  }

  {
    const closeCode = await Promise.race([closed, sleep(3_000).then(() => -1)]);
    assert(closeCode !== -1, "the coach's /live socket must be CLOSED by the shutdown, not left to time out");
    ok(`the live socket was closed by the server (code ${closeCode})`);
  }

  // --- C: the handover file exists, is 0600, and holds no usable token ---------------------------------
  {
    assert(existsSync(SESSIONS_FILE), 'a graceful shutdown with a live session must write the handover file');
    const mode = statSync(SESSIONS_FILE).mode & 0o777;
    assert(mode === 0o600, `the session handover file must be 0600, got 0${mode.toString(8)}`);
    const raw = await Bun.file(SESSIONS_FILE).text();
    const token = cookie.slice(cookie.indexOf('=') + 1);
    assert(!raw.includes(token), 'the RAW session token must never appear in the handover file — only its sha256');
    assert(raw.includes('"h"') && raw.includes(`"u":"${COACH}"`), 'the file must carry the hash + username shape');
    ok('the handover file is 0600 and stores a hash, never the bearer token');
  }

  // ── C(part 2): restart → the coach is STILL LOGGED IN, and the file is consumed ─────────────────────
  const second = startServer();
  await waitReady();
  {
    const me = await fetch(`http://127.0.0.1:${PORT}/auth/me`, { headers: { cookie, origin: ORIGIN } });
    assert(me.status === 200, `/auth/me after a graceful restart should be 200, got ${me.status}`);
    const body = (await me.json()) as { authenticated?: boolean; username?: string };
    assert(body.username === COACH, `the SAME cookie must still resolve to ${COACH}, got ${JSON.stringify(body)}`);
    assert(!existsSync(SESSIONS_FILE), 'the handover file must be CONSUMED at boot (single use)');
    const logs = second.logs();
    assert(/"msg":"auth sessions restored"/.test(logs), 'the restore must be logged');
    ok('a coach survives a graceful restart, and the handover file is consumed on read');
  }

  // --- and a session whose ACCOUNT is gone must not come back -------------------------------------------
  // (a revoked coach must stay revoked across a restart — the restore must not become a resurrection path)
  {
    const t = Date.now();
    second.proc.kill('SIGTERM');
    assert((await second.proc.exited) === 0, 'second server must also exit 0');
    assert(Date.now() - t < BUDGET_MS, 'second shutdown must also be inside the budget');
    assert(existsSync(SESSIONS_FILE), 'the second shutdown must have written the handover file again');

    const rm = Bun.spawn(['bun', 'run', 'auth-user.ts', 'remove', COACH], {
      cwd: `${import.meta.dir}/..`, env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE }, stdout: 'ignore', stderr: 'inherit',
    });
    assert((await rm.exited) === 0, 'auth-user.ts remove failed');

    const third = startServer();
    await waitReady();
    const me = await fetch(`http://127.0.0.1:${PORT}/auth/me`, { headers: { cookie, origin: ORIGIN } });
    const body = (await me.json()) as { username?: string; authenticated?: boolean };
    assert(body.username !== COACH, 'a session whose account was removed must NOT be restored');
    third.proc.kill('SIGTERM');
    await third.proc.exited;
    ok('a session belonging to a removed account is dropped, not resurrected');
  }

  // The removed-account case above deleted COACH; the handover cases below need it back.
  {
    const re = Bun.spawn(
      ['bun', 'run', 'auth-user.ts', 'add', COACH, '--role', 'coach', '--sessions', SESSION],
      { cwd: `${import.meta.dir}/..`, env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE }, stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' },
    );
    re.stdin.write(`${COACH_PW}\n`);
    await re.stdin.end();
    assert((await re.exited) === 0, 're-provisioning the coach failed');
    rmSync(SESSIONS_FILE, { force: true }); // start the handover cases from a known-empty state
  }

  // ── C(part 3): THE HANDOVER APPLIES THE CURRENT POLICY, NOT THE ONE THAT MINTED THE SESSION ────────
  // Four defects a checker pass reproduced in the first cut of this file, each with the case that pins it.
  // The theme: a restart is precisely how an operator APPLIES a policy change — shortening the TTL and
  // restarting is the response to a lost coach tablet — so a handover that carries the old policy across
  // silently exempts the very sessions being tightened against.
  {
    // (i) TTL: log in under a long TTL, restart under a short one, and the restored session must die on
    //     the NEW clock. Before the fix the persisted expiry was trusted verbatim: 12 hours of live
    //     child-location access continued on a policy the operator believed they had revoked.
    const long = startServer({ AUTH_SESSION_TTL_SECONDS: '3600' });
    await waitReady();
    const c = await login();
    long.proc.kill('SIGTERM');
    await long.proc.exited;

    const short = startServer({ AUTH_SESSION_TTL_SECONDS: '2' });
    await waitReady();
    const alive = await fetch(`http://127.0.0.1:${PORT}/auth/me`, { headers: { cookie: c, origin: ORIGIN } });
    assert(alive.status === 200, 'the restored session must be usable immediately after the restart');
    await sleep(2_600); // past the NEW 2 s TTL, nowhere near the old 3600 s one
    const dead = await fetch(`http://127.0.0.1:${PORT}/auth/me`, { headers: { cookie: c, origin: ORIGIN } });
    const body = (await dead.json()) as { username?: string };
    assert(body.username !== COACH, 'a restored session must expire on the CURRENT TTL, not the one it was minted under');
    short.proc.kill('SIGTERM');
    await short.proc.exited;
    ok('a restored session is clamped to the CURRENT AUTH_SESSION_TTL_SECONDS');
  }
  {
    // (ii) Per-user cap: only the GLOBAL cap was re-applied on restore, so lowering
    //      AUTH_MAX_SESSIONS_PER_USER and restarting left every old session live.
    const many = startServer({ AUTH_MAX_SESSIONS_PER_USER: '5' });
    await waitReady();
    for (let i = 0; i < 5; i++) await login();
    many.proc.kill('SIGTERM');
    await many.proc.exited;

    const tight = startServer({ AUTH_MAX_SESSIONS_PER_USER: '2' });
    await waitReady();
    const line = /"msg":"auth sessions restored"[^\n]*/.exec(tight.logs())?.[0] ?? '';
    const restored = Number(/"restored":(\d+)/.exec(line)?.[1] ?? -1);
    assert(restored === 2, `a lowered per-user cap must bound the restore: expected 2, log said ${restored} (${line})`);
    assert(/"capped":3/.test(line), `the sessions dropped by the cap must be reported, got: ${line}`);
    tight.proc.kill('SIGTERM');
    await tight.proc.exited;
    ok('a lowered AUTH_MAX_SESSIONS_PER_USER bounds what the handover restores');
  }
  {
    // (iii) A handover that cannot be CONSUMED must restore NOTHING. The delete used to live in a
    //      `finally` with a bare catch, so a read-only config directory — an ext4 remount after SD-card
    //      errors, the realistic Pi failure — restored the sessions anyway and left the file in place.
    //      A coach who pressed "sign out" got their session handed back on every boot after that, with a
    //      cheerful "restored" line and nothing said about the failed delete.
    const src = startServer();
    await waitReady();
    const doomed = await login();
    src.proc.kill('SIGTERM');
    await src.proc.exited;
    assert(existsSync(SESSIONS_FILE), 'precondition: a handover file exists');

    chmodSync(HANDOVER_DIR, 0o500); // read + execute, no write: readable, not unlinkable
    const locked = startServer();
    await waitReady();
    // Did the setup actually take? ROOT ignores directory write permission (DAC_OVERRIDE), so in a
    // root container the unlink succeeds and this case simply cannot be staged. Say so rather than
    // asserting a property the environment did not create — a test that quietly cannot run is worse
    // than one that admits it. (CI runs as a non-root user, where it does run.)
    const stillThere = existsSync(SESSIONS_FILE);
    chmodSync(HANDOVER_DIR, 0o700); // restore before any assertion can throw and skip the cleanup
    const me = await fetch(`http://127.0.0.1:${PORT}/auth/me`, { headers: { cookie: doomed, origin: ORIGIN } });
    const who = (await me.json()) as { username?: string };
    const logs = locked.logs();
    locked.proc.kill('SIGTERM');
    await locked.proc.exited;
    if (stillThere) {
      assert(who.username !== COACH, 'a handover that could not be consumed must NOT be restored — it would replay logged-out sessions');
      assert(/could not be removed/.test(logs), `the failure must be LOUD, not silent. logs: ${logs.slice(-500)}`);
      ok('a handover file that cannot be deleted restores nothing, loudly');
    } else {
      console.log('  --: handover-unlink-failure case SKIPPED — this user can unlink from a 0500 directory (running as root?)');
    }
    rmSync(SESSIONS_FILE, { force: true });
  }
  {
    // (iv) A hand-written handover is treated as untrusted input. Someone who can WRITE this file can
    //      already edit auth-accounts.json, so this is not an escalation — but a forged handover is a
    //      better backdoor (it deletes itself, leaving no artefact), so it must not also grant an
    //      unbounded lifetime or a key of an unexpected shape.
    const forgedToken = 'forged-token-value-for-the-test-abcdefghijk';
    const h = createHash('sha256').update(forgedToken).digest('base64url');
    writeFileSync(SESSIONS_FILE, JSON.stringify({
      v: 1,
      saved: Date.now(),
      sessions: [
        { h, u: COACH, c: 'x', e: 1e308 },                       // absurd lifetime
        { h, u: COACH, c: 'y', e: Date.now() + 60_000 },         // duplicate key, different owner data
        { h: 'not-a-sha256', u: COACH, c: 'z', e: Date.now() + 60_000 }, // wrong key shape
      ],
    }), { mode: 0o600 });

    const forged = startServer({ AUTH_SESSION_TTL_SECONDS: '60' });
    await waitReady();
    const line = /"msg":"auth sessions restored"[^\n]*/.exec(forged.logs())?.[0] ?? '';
    const restored = Number(/"restored":(\d+)/.exec(line)?.[1] ?? -1);
    assert(restored === 1, `only the first well-formed record may be restored, got ${restored} (${line})`);
    // The clamp is the point: 1e308 must have become now + the CURRENT 60 s TTL.
    const cookieHeader = `${COOKIE_NAME}=${forgedToken}`;
    const now = await fetch(`http://127.0.0.1:${PORT}/auth/me`, { headers: { cookie: cookieHeader, origin: ORIGIN } });
    assert(now.status === 200, 'a well-formed record IS restored (the file is trusted to the extent its writer is)');
    forged.proc.kill('SIGTERM');
    await forged.proc.exited;
    // Re-read the file the shutdown wrote: the persisted expiry proves the clamp survived the round trip.
    const back = JSON.parse(await Bun.file(SESSIONS_FILE).text()) as { sessions: { e: number }[] };
    const horizon = Date.now() + 120_000;
    assert(back.sessions.every((r) => r.e < horizon),
      `a clamped session must not persist a far-future expiry, got ${JSON.stringify(back.sessions.map((r) => r.e))}`);
    rmSync(SESSIONS_FILE, { force: true });
    ok('a forged handover gets the CURRENT TTL, one key one owner, and a shape check');
  }
  {
    // (v) The size cap is checked BEFORE the read. Reading first and measuring after turned a large file
    //     at this path into a 1.3 GB RSS spike inside initAuth() — an OOM kill inside the production
    //     container's 512 MB limit, before the listeners open, on every restart.
    const big = Buffer.alloc(8 * 1024 * 1024, 'x'); // 8 MB, well past SESSIONS_MAX_BYTES (1 MB)
    writeFileSync(SESSIONS_FILE, big);
    const t = Date.now();
    const huge = startServer();
    await waitReady();
    const bootMs = Date.now() - t;
    const logs = huge.logs();
    huge.proc.kill('SIGTERM');
    await huge.proc.exited;
    assert(/too large \(8388608 bytes\)/.test(logs), `the refusal must name the BYTE size it measured, got: ${logs.slice(-400)}`);
    assert(bootMs < 15_000, `an oversized handover must not slow the boot (took ${bootMs}ms)`);
    rmSync(SESSIONS_FILE, { force: true });
    ok('an oversized handover is refused on its size in BYTES, before it is read');
  }

  // ── G: A SIGNAL DURING BOOT ─────────────────────────────────────────────────────────────────────────
  // The handlers used to be installed as the LAST statement of server.ts, leaving the first ~150 ms with
  // none. That is not merely "no teardown": bun is pid 1 in the container and the kernel DISCARDS a
  // signal pid 1 has no handler for, so `docker stop` in that window waited out the whole grace period
  // and SIGKILLed — measured at exit 137 after 5.1 s with `stop_grace_period: 5s`, i.e. WORSE than the
  // 1.3 s baseline this phase set out to fix. An orchestrator rescheduling a starting container, or an
  // operator interrupting a crash-loop, lands exactly there.
  //
  // Swept across the window rather than aimed at it: every delay must exit promptly, and — the second
  // half of the same bug — a kill anywhere in there must not lose the coach sessions, because
  // loadSessions() CONSUMES the handover file during boot.
  {
    const src = startServer();
    await waitReady();
    const carried = await login();
    src.proc.kill('SIGTERM');
    await src.proc.exited;
    assert(existsSync(SESSIONS_FILE), 'precondition: a handover file exists');

    // Sample RELATIVE to how long this machine actually takes to boot, not at fixed millisecond marks:
    // a cold container is several times slower than a warm laptop, and fixed marks would land entirely
    // inside module loading there (measured — 5 of 6 fixed samples missed) and entirely after it here.
    const tReady = Date.now();
    const timing = startServer();
    await waitReady();
    const readyMs = Date.now() - tReady;
    timing.proc.kill('SIGTERM');
    await timing.proc.exited;

    const samples: Array<{ at: number; code: number | null; ms: number }> = [];
    for (const frac of [0.05, 0.2, 0.5, 0.65, 0.8, 0.95]) {
      const delayMs = Math.round(readyMs * frac);
      const early = startServer();
      await sleep(delayMs);
      const t = Date.now();
      early.proc.kill('SIGTERM');
      const code = await early.proc.exited;
      const took = Date.now() - t;
      // PROMPT in every case is the property that failed: the container symptom was waiting out the whole
      // grace period. A 143 in the first few per cent (before Bun has executed a line of the module) is
      // the OS default disposition and is fine — it is prompt, and there is no handler to install yet.
      assert(took < BUDGET_MS, `SIGTERM at ${Math.round(frac * 100)}% of boot must exit inside ${BUDGET_MS}ms, took ${took}ms (exit ${code})`);
      samples.push({ at: frac, code, ms: took });
    }
    // From two-thirds of the way through boot onward it must be HANDLED — exit 0, teardown run. Not
    // earlier: MODULE LOADING dominates a cold container's boot, and until Bun has executed the first
    // line of server.ts there is nothing to install (measured on Linux, 50% of a 205 ms boot is still
    // inside the imports). With the handlers where they were — the LAST statement of the module, after
    // both listeners are already up — every one of these samples is 143 instead.
    const late = samples.filter((x) => x.at >= 0.65);
    assert(
      late.every((x) => x.code === 0),
      `the signal must be handled from mid-boot onward; got ${JSON.stringify(late.map((x) => ({ at: x.at, code: x.code })))} (readyMs=${readyMs})`,
    );

    // The sessions must have survived every one of those. They are either still on disk (the kill landed
    // before the restore) or were written back by the shutdown step (it landed after) — never neither.
    const back = startServer();
    await waitReady();
    const me = await fetch(`http://127.0.0.1:${PORT}/auth/me`, { headers: { cookie: carried, origin: ORIGIN } });
    const who = (await me.json()) as { username?: string };
    back.proc.kill('SIGTERM');
    await back.proc.exited;
    assert(who.username === COACH, 'a kill during boot must not destroy the session handover — the file is consumed in that window');
    rmSync(SESSIONS_FILE, { force: true });
    ok('a SIGTERM anywhere in the boot window exits 0 promptly and does not lose the coach sessions');
  }

  // ── D + E + F: the fault handlers and the impatient second signal ───────────────────────────────────
  // Driven through a tiny harness rather than the real server: an uncaughtException has to be raised from
  // INSIDE the process, and the real server deliberately has no route that throws.
  {
    const harness = join(dir, 'harness.ts');
    writeFileSync(harness, `
      import { onShutdown, installLifecycleHandlers, STEP } from '${join(import.meta.dir, '..', 'src', 'shutdown')}';
      import { registry } from '${join(import.meta.dir, '..', 'src', 'metrics')}';
      const mode = process.argv[2];
      // Printing the RENDERED registry is what makes "counted" an assertion rather than a hope: the test
      // greps for the actual ft_process_fatal_total series, not for a log string.
      const dump = () => console.log('METRICS_BEGIN\\n' + registry.render() + 'METRICS_END');
      onShutdown('marker', STEP.STORE, () => { console.log('TEARDOWN_RAN'); dump(); });
      // 'slow' and 'wedge' exist to make the two safety behaviours REACHABLE: a teardown that finishes in
      // microseconds can neither be interrupted by a second signal nor hit its own deadline.
      if (mode === 'slow') onShutdown('slow-step', STEP.SCANS, () => new Promise((r) => setTimeout(r, 800)));
      if (mode === 'wedge') onShutdown('wedged-step', STEP.SCANS, () => new Promise(() => {}));
      installLifecycleHandlers();
      console.log('READY');
      if (mode === 'throw') setTimeout(() => { throw new Error('boom'); }, 50);
      if (mode === 'reject') setTimeout(() => { void Promise.reject(new Error('orphan')); setTimeout(dump, 200); }, 50);
      setInterval(() => {}, 1000); // keep the loop alive
    `);

    // D: uncaughtException → the SAME teardown, then exit 1.
    {
      const p = Bun.spawn(['bun', 'run', harness, 'throw'], { stdout: 'pipe', stderr: 'pipe' });
      children.push(p);
      const exit = await p.exited;
      const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
      assert(exit === 1, `an uncaughtException must exit 1 (so the restart policy fires), got ${exit}`);
      assert(out.includes('TEARDOWN_RAN'), 'an uncaughtException must run the ordered teardown, not exit raw');
      assert(/uncaught exception/.test(out), 'the fault must be logged');
      assert(/ft_process_fatal_total\{kind="uncaught_exception"\} 1/.test(out),
        `the fault must be COUNTED (ft_process_fatal_total{kind="uncaught_exception"}), got: ${out.slice(-600)}`);
      ok('uncaughtException → ordered teardown, then exit 1');
    }

    // E: unhandledRejection → logged and counted, process KEEPS SERVING.
    {
      const p = Bun.spawn(['bun', 'run', harness, 'reject'], { stdout: 'pipe', stderr: 'pipe' });
      children.push(p);
      await sleep(900);
      const stillAlive = p.exitCode === null;
      p.kill(9);
      const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
      assert(stillAlive, 'an unhandled rejection must NOT kill the server — a match feed is worth more than a tidy exit');
      assert(/ft_process_fatal_total\{kind="unhandled_rejection"\} 1/.test(out),
        `surviving is only acceptable if it is COUNTED — expected ft_process_fatal_total{kind="unhandled_rejection"}, got: ${out.slice(-600)}`);
      ok('unhandledRejection → counted in ft_process_fatal_total, process keeps running');
    }

    // F: a second signal stops waiting — measured against a teardown that is deliberately still running.
    {
      const p = Bun.spawn(['bun', 'run', harness, 'slow'], { stdout: 'pipe', stderr: 'pipe' });
      children.push(p);
      await sleep(500);
      p.kill('SIGTERM');
      await sleep(150); // the slow step is still in flight
      p.kill('SIGTERM'); // an impatient operator, or an orchestrator escalating
      const t = Date.now();
      const exit = await p.exited;
      const took = Date.now() - t;
      assert(exit !== 0, `a second signal must exit non-zero (it is not a clean exit), got ${exit}`);
      assert(took < 500, `the second signal must cut the wait short, took a further ${took}ms of the 800ms step`);
      ok(`a second signal abandons the in-flight teardown and exits non-zero (after ${took}ms, not 800ms)`);
    }

    // G: THE SAFETY NET. A step that never returns must not turn `docker stop` back into a SIGKILL —
    // the hard deadline force-exits with the code the graceful path would have used.
    {
      const p = Bun.spawn(['bun', 'run', harness, 'wedge'], {
        stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, SHUTDOWN_DEADLINE_MS: '400' },
      });
      children.push(p);
      await sleep(500);
      const t = Date.now();
      p.kill('SIGTERM');
      const exit = await p.exited;
      const took = Date.now() - t;
      const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
      // A DISTINCT code, deliberately: `docker inspect .State.ExitCode` is this phase's own acceptance
      // signal, and a wedged teardown that exits 0 claims the store was checkpointed when it was not.
      assert(exit === 75, `a deadline exit must be distinguishable from a clean one (75 = EX_TEMPFAIL), got ${exit}`);
      assert(took < 1_500, `the deadline must fire and exit, took ${took}ms`);
      assert(took >= 350, `the deadline must be WAITED for, not skipped — exited after only ${took}ms`);
      assert(/deadline exceeded/.test(out), 'a deadline exit must say so in the log, never look like a clean one');
      ok(`a wedged teardown still exits (after the ${400}ms deadline, in ${took}ms) and says why`);
    }
  }

  console.log(`\n✅ SHUTDOWN E2E PASSED — ${passed} cases: SIGTERM exits 0 well inside the ${BUDGET_MS}ms budget with the`
    + ' teardown in declared order and the live socket closed; a coach survives the restart via a 0600 hash-only'
    + ' handover file that is consumed on read (and a removed account is not resurrected); uncaughtException exits 1'
    + ' through the same teardown; unhandledRejection does not.');
  stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ SHUTDOWN E2E FAILED:', (err as Error).message);
  stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
}
