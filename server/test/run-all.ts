/**
 * run-all.ts — the single-command server gate. `bun run test` from server/.
 *
 * WHY THIS EXISTS. Before this file there were 14 `test:*` scripts for 20 suites and no way to run
 * them together. Six suites — auth-cli, auth-dos, auth-loader, events, events-e2e, scan-load — were
 * reachable only by typing their path, which means in practice they ran when someone remembered
 * them. A gate nobody can run in one command is not a gate; CI cannot have one either.
 *
 * THE COVERAGE ASSERTION IS THE POINT. Step 1 below fails if any .ts in test/ is neither a declared
 * suite nor a declared non-suite. A hand-maintained list silently rots the moment someone adds a
 * test file — which is exactly how the six above went missing. Adding a suite must therefore be a
 * deliberate edit here, and forgetting to make it turns the build red instead of quietly shrinking
 * the gate. Same reasoning as the "no silent caps" rule: coverage that narrows without saying so
 * reads as a pass.
 *
 * SEQUENTIAL, ON PURPOSE. Most e2e suites spawn their own mosquitto and bind fixed ports; running
 * them concurrently produces EADDRINUSE flakes that look like product bugs. Order is cheapest-first
 * so a broken loader fails in seconds rather than after the ten broker-spawning suites.
 *
 *   bun run test                      — all suites, exits 0 only if every one passes
 *   SUITE_TIMEOUT_MS=600000 bun run test   — longer per-suite deadline (default 300 s)
 */

import { readdirSync } from 'node:fs';

/**
 * Strict parse. `Number('5 min')` is NaN, and Bun.spawn treats a NaN timeout as NO TIMEOUT — so a
 * typo'd override would silently remove the deadline and a hung suite would hang the gate forever,
 * which is the exact opposite of what the person setting it intended. Same NaN-propagation failure
 * this project already hit in production caps; refuse the value instead of coercing it.
 */
function ms(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`❌ ${name}="${raw}" is not a positive number of milliseconds.`);
    process.exit(1);
  }
  return n;
}

const TIMEOUT_MS = ms('SUITE_TIMEOUT_MS', 300_000);
/** How long to wait for a killed suite's output after it exits. See the drain note in the loop. */
const DRAIN_GRACE_MS = 5_000;

/** Ordered cheapest-first: pure unit/loader, then CLI, then the broker-spawning e2e suites. */
const SUITES: Array<[file: string, proves: string]> = [
  // --- no broker, no ports: fail here in seconds rather than after ten stack spin-ups ---
  ['gitignore-guard.ts', 'no personal data or secret can enter git'],
  ['deploy-posture.ts', 'the dev stack stays loopback-published with an authenticated broker'],
  ['auth-loader.ts', 'account file parsing + fail-closed posture'],
  ['roster-loader.ts', 'roster parsing; names never leave the loader'],
  ['session-config-loader.ts', 'session config parsing + reload'],
  ['history.ts', 'history paging, span caps, off-loop gate'],
  ['events.ts', 'tactical event detection (team-shape series + phases)'],
  ['scan-load.ts', 'the off-loop inflight cap is shared across /history and /events'],
  ['retention.ts', 'the retention sweep deletes on schedule'],
  // --- spawn a CLI + temp files ---
  ['auth-cli.ts', 'auth-user.ts add/remove/sessions'],
  ['roster-cli.ts', 'roster-user.ts set/remove, 0600 mode'],
  ['session-config-cli.ts', 'session-config.ts set/remove, 0600 mode'],
  // --- spawn mosquitto + the real server ---
  ['e2e.ts', 'MQTT -> ingest -> WS fan-out -> sqlite, and /metrics'],
  ['ws-origin.ts', 'the /live Origin allow-list'],
  ['anon-scope.ts', 'anon mode binds loopback and is live-pitch-only (no names, no bulk history)'],
  ['auth-e2e.ts', 'login, cookies, CSRF, session scoping'],
  ['auth-dos.ts', 'rate buckets, soft-lock, concurrent-hash cap'],
  ['roster-e2e.ts', 'GET /sessions/:id/roster is authenticated + session-scoped'],
  ['history-e2e.ts', 'GET /sessions/:id/history end to end'],
  ['events-e2e.ts', 'GET /sessions/:id/events end to end'],
  ['device-health-e2e.ts', 'the .../status topic reaches /live as {event:"status"}'],
  ['config-e2e.ts', 'GET /sessions/:id/config serves the age band'],
  ['erasure-e2e.ts', 'right-to-erasure: purge removes the player and the name'],
];

/** Files in test/ that are deliberately NOT suites. Anything else here is a coverage hole. */
const NON_SUITES: Array<[file: string, why: string]> = [
  ['simulate.ts', 'the shared hardware-free harness the e2e suites and Playwright drive'],
  ['mosquitto-pub-demo.ts', "the README's literal mosquitto_pub walkthrough, run by hand"],
  ['run-all.ts', 'this runner'],
];

const fmt = (d: number) => (d < 1000 ? `${d | 0}ms` : `${(d / 1000).toFixed(1)}s`);

// ── 1. Coverage: every test file is accounted for, in one direction or the other. ──────────────────
// Recursive, and not limited to .ts: a top-level-only .ts scan would let a suite hide in a
// subdirectory (test/integration/foo.ts) or under another extension while the gate still said green
// — the same silent-narrowing this assertion exists to prevent.
const onDisk = readdirSync(import.meta.dir, { recursive: true })
  .map(String)
  .filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f))
  .sort();
const declared = new Set([...SUITES.map(([f]) => f), ...NON_SUITES.map(([f]) => f)]);

const undeclared = onDisk.filter((f) => !declared.has(f));
if (undeclared.length) {
  console.error(
    `\n❌ ${undeclared.length} test file(s) exist but are not declared in run-all.ts:\n` +
      undeclared.map((f) => `     test/${f}`).join('\n') +
      `\n\n   Add each to SUITES (it runs in the gate) or to NON_SUITES with a reason (it does not).` +
      `\n   Left undeclared, a new suite would never run and the gate would still report green.\n`,
  );
  process.exit(1);
}
const missing = [...declared].filter((f) => !onDisk.includes(f));
if (missing.length) {
  console.error(`\n❌ declared but missing from test/: ${missing.join(', ')}\n   Fix the name, or drop the entry.\n`);
  process.exit(1);
}

// ── 2. Run them, in order, one at a time. ─────────────────────────────────────────────────────────
console.log(`Running ${SUITES.length} server suites sequentially (per-suite timeout ${fmt(TIMEOUT_MS)})\n`);

type Result = { file: string; ok: boolean; ms: number; timedOut: boolean; code: number | null; output: string };
const results: Result[] = [];
const t0 = Date.now();

for (const [i, [file, proves]] of SUITES.entries()) {
  const label = `[${String(i + 1).padStart(2)}/${SUITES.length}] ${file.padEnd(26)}`;
  process.stdout.write(`${label} ${proves}\n`);

  const started = Date.now();
  const proc = Bun.spawn(['bun', 'run', `test/${file}`], {
    cwd: import.meta.dir + '/..',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  // Wait for the SUITE to exit first, and only then read its pipes — never both at once.
  //
  // Ten of these suites spawn a mosquitto and a server. Those grandchildren INHERIT the stdout pipe,
  // so when the timeout SIGKILLs the suite the pipe stays open in the survivors and never reaches
  // EOF. Awaiting the text alongside proc.exited therefore blocks forever: the timeout fires, the
  // runner does not notice, and the deadline that exists to stop a hang becomes the cause of one.
  // (Measured: proc.exited resolves on schedule at the deadline with code 137; the drain does not.)
  const code = await proc.exited;
  const timedOut = proc.signalCode === 'SIGKILL'; // how Bun reports its own timeout kill
  const drained = await Promise.race([
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([o, e]) => `${o}${e}`),
    new Promise<string>((r) =>
      setTimeout(
        () => r('(output unavailable: the suite left a child process holding the pipe open)\n'),
        DRAIN_GRACE_MS,
      ),
    ),
  ]);
  const elapsed = Date.now() - started;
  const ok = code === 0 && !timedOut;

  results.push({ file, ok, ms: elapsed, timedOut, code, output: drained });
  console.log(`${' '.repeat(label.length)} ${ok ? '✅' : timedOut ? '⏱️  TIMED OUT' : '❌ FAILED'} ${fmt(elapsed)}\n`);
}

// ── 3. Report. Failures print their own output — a summary alone is not actionable. ───────────────
const failed = results.filter((r) => !r.ok);

for (const r of failed) {
  const tail = r.output.trimEnd().split('\n').slice(-40);
  console.error(`\n${'─'.repeat(78)}\n❌ test/${r.file} — ${r.timedOut ? `killed after ${fmt(r.ms)}` : `exit ${r.code}`}`);
  console.error(`   reproduce: cd server && bun run test/${r.file}`);
  console.error(`${'─'.repeat(78)}\n${tail.join('\n')}`);
  if (r.timedOut) {
    console.error(
      `\n   (a SIGKILL'd e2e suite can leave a mosquitto behind: pkill -f "mosquitto -c /tmp/ft-" before re-running)`,
    );
  }
}

console.log(`\n${'═'.repeat(78)}`);
console.log(
  failed.length === 0
    ? `✅ all ${results.length} server suites passed in ${fmt(Date.now() - t0)}`
    : `❌ ${failed.length}/${results.length} suites failed in ${fmt(Date.now() - t0)}: ${failed.map((r) => r.file).join(', ')}`,
);
console.log('═'.repeat(78));

process.exit(failed.length === 0 ? 0 : 1);
