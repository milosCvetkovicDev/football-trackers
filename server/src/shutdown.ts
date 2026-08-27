/**
 * Process lifecycle — an ordered graceful shutdown, and the two last-resort fault handlers.
 *
 * WHY THIS EXISTS. `docker stop` on this stack exited **137 (SIGKILL) in 1.3 s** with zero drain
 * window (measured, audit §6 "Server"): the compose command was `sh -c "…"`, so `sh` was PID 1, the
 * signal reached a shell that does not forward it, and Bun was killed outright. Nothing ran — no WAL
 * checkpoint, no socket close, no "I am going away" to the coach tablets. That is survivable for a
 * telemetry store in WAL mode (the audit measured no data loss), but it is not something to rely on,
 * and it makes every restart a small unexplained gap in the record.
 *
 * TWO HALVES, AND BOTH ARE NEEDED. This module is the in-process half: a signal handler that runs an
 * ORDERED teardown and exits 0. The other half is the container: the process must actually BE pid 1
 * (compose uses `exec` + `init: true`), or none of this code ever runs.
 *
 * ORDER IS THE WHOLE DESIGN (see docs/decisions/0025-operability-lifecycle.md). The steps are
 * registered ONCE, in one block in server.ts, and run in REGISTRATION order — deliberately not the
 * LIFO an `atexit` stack would give you, because the correct teardown order here is not the reverse
 * of the setup order and pretending otherwise would hide that. Drain first (so a health check stops
 * routing to us), then stop producing work, then stop the listeners, and only then touch the store.
 *
 * A HARD DEADLINE, ALWAYS. Every step is wrapped: a step that throws is logged and the next one still
 * runs, and the whole sequence is capped by SHUTDOWN_DEADLINE_MS. A shutdown that hangs is worse than
 * an abrupt one — it turns `docker stop`'s 10 s grace into the 137 we are trying to eliminate — so the
 * deadline force-exits with the SAME exit code the graceful path would have used.
 */

import { envTimerMs } from './env';
import { log } from './log';
import { metrics } from './metrics';

export type ShutdownReason = 'SIGTERM' | 'SIGINT' | 'uncaughtException' | 'manual';

/**
 * The teardown order, as VALUES rather than as "wherever the call happens to sit".
 *
 * It started as registration order and one place to read it, which was true right up until a checker
 * pass showed the handlers had to be installed BEFORE the async boot (see installLifecycleHandlers) and
 * `auth.ts` had to register its own step at the moment it consumes the handover file. Once two modules
 * register, "the order is the order you read them in" stops being a property anyone can check. Numbers
 * are worse to read and better to rely on.
 *
 * Stop being reachable, stop producing work, stop listening, touch the store last.
 */
export const STEP = {
  SCANS: 10,      // in-flight off-loop reads: tell them to stop at their next page
  TIMERS: 20,     // nothing new may start (the retention sweep takes the write lock)
  MQTT: 30,       // stop taking packets
  LISTENERS: 40,  // close the sockets; after this nothing can be serving
  SESSIONS: 50,   // hand the logged-in coaches to the next process
  STORE: 60,      // checkpoint + close, last, when nothing else can be writing
} as const;

interface Step {
  name: string;
  order: number;
  run: () => void | Promise<void>;
}

const steps: Step[] = [];
let draining = false;
let shuttingDown = false;

/**
 * The graceful budget. Default 1500 ms because the acceptance criterion is "`docker stop` exits 0 in
 * under 2 s" and the deadline is the WORST case, not the expected one (a healthy shutdown here is a
 * few ms). Raising it past `docker stop`'s own grace period (10 s by default, `stop_grace_period` in
 * compose) would simply hand the kill back to Docker.
 */
const DEADLINE_MS = envTimerMs('SHUTDOWN_DEADLINE_MS', 1_500, { min: 100 });

/**
 * Exit code when the deadline fires. 75 = EX_TEMPFAIL: the process is going away as asked, but the
 * teardown did not finish, so the store may need WAL replay and the coaches were not handed over. It
 * MUST differ from the graceful code — an operator (and this phase's acceptance criterion) reads the
 * exit code to decide whether the shutdown worked.
 */
export const DEADLINE_EXIT_CODE = 75;

/**
 * Register one teardown step. `order` is a STEP value above; steps run lowest-first, and ties keep
 * registration order. A step may be registered at any time — including after a shutdown has already
 * begun, in which case it simply never runs.
 */
export function onShutdown(name: string, order: number, run: () => void | Promise<void>): void {
  steps.push({ name, order, run });
}

/**
 * True once a shutdown has begun. `/health` reports 503 while draining so an orchestrator's health
 * check stops sending work to a process that is on its way out — the check must not go on saying
 * "healthy" for the last second and a half of the process's life.
 */
export function isDraining(): boolean {
  return draining;
}

/** Test seam: forget registered steps between in-process cases. */
export function _resetShutdown(): void {
  steps.length = 0;
  draining = false;
  shuttingDown = false;
}

/**
 * Run the teardown and exit. Idempotent: a second call while one is in flight is treated as an
 * operator (or an orchestrator) losing patience and exits immediately — a repeated SIGTERM should
 * never be absorbed silently.
 */
export async function shutdown(reason: ShutdownReason, code: number): Promise<void> {
  if (shuttingDown) {
    log.warn('shutdown: second signal — exiting now', { reason });
    process.exit(code === 0 ? 1 : code); // impatient exit is not a clean exit
  }
  shuttingDown = true;
  draining = true;
  const t0 = Date.now();
  log.info('shutdown: draining', { reason, steps: steps.length, deadlineMs: DEADLINE_MS });

  // Armed BEFORE the first step: the point of a deadline is to survive a step that never returns, so
  // it cannot be scheduled by the code it is protecting. Not unref'd — this timer must be able to keep
  // the loop alive long enough to fire.
  const hard = setTimeout(() => {
    // A DISTINCT exit code, not the graceful one. `docker inspect -f '{{.State.ExitCode}}'` is this
    // phase's own acceptance signal, and a wedged teardown that exits 0 tells the operator the store was
    // checkpointed and the sessions handed over when neither happened (measured: 24 KB of WAL frames left
    // behind, no `db closed` line, exit 0). The metric below cannot cover for it — by the time it is set,
    // the listeners step has already closed /metrics, so nothing can scrape it.
    log.error('shutdown: deadline exceeded — exiting anyway, teardown INCOMPLETE', {
      reason,
      ms: Date.now() - t0,
      exitCode: DEADLINE_EXIT_CODE,
    });
    metrics.shutdownSeconds.set({ outcome: 'deadline' }, (Date.now() - t0) / 1000);
    process.exit(DEADLINE_EXIT_CODE);
  }, DEADLINE_MS);

  // Sorted here, not at registration: a step registered late (auth.ts registers its own the moment it
  // consumes the handover file) must still land in the right place.
  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    const s0 = Date.now();
    try {
      await step.run();
      log.debug('shutdown: step done', { step: step.name, ms: Date.now() - s0 });
    } catch (err) {
      // One broken step must not strand the others — the store checkpoint is the LAST step and the
      // most worth reaching.
      log.error('shutdown: step failed', { step: step.name, ms: Date.now() - s0, err: String(err) });
    }
  }

  clearTimeout(hard);
  const ms = Date.now() - t0;
  metrics.shutdownSeconds.set({ outcome: 'clean' }, ms / 1000);
  log.info('shutdown: complete', { reason, ms, code });
  process.exit(code);
}

/**
 * Install the signal + fault handlers. Call this FIRST — before any `await`, before the listeners, before
 * anything is registered.
 *
 * It used to be the last statement of server.ts, which left the first ~150 ms of process life with no
 * SIGTERM handler at all. That is not merely "the teardown does not run": bun is pid 1 in the container,
 * and the kernel DISCARDS a signal that pid 1 has no handler for — so `docker stop` in that window waited
 * out the entire grace period and SIGKILLed (measured: exit 137 after 5.1 s with `stop_grace_period: 5s`,
 * i.e. WORSE than the 1.3 s baseline this phase set out to fix; 3/3 reproductions). An orchestrator
 * rescheduling a starting container, or an operator interrupting a crash-loop, lands exactly there.
 *
 * Installing first is safe because `shutdown()` runs whatever steps happen to be registered: a signal at
 * t+0 runs none of them and exits 0 promptly, which is the correct behaviour for a process that has not
 * yet opened anything.
 *
 * uncaughtException EXITS (code 1), through the same ordered teardown. It is not swallowed: after an
 * uncaught throw the process state is unknown, and a live feed of children's positions that keeps
 * serving from an unknown state is worse than one that restarts in a second (`restart: unless-stopped`
 * + Phase 5's client reconnect make that a blip). The known hole the audit named — `server.publish()`
 * throwing outside the ingest try/catch — is fixed AT THE SOURCE in server.ts, so this handler stays a
 * genuine last resort rather than a load-bearing part of the fan-out path.
 *
 * unhandledRejection does NOT exit: an orphaned rejection leaves the process consistent, and killing a
 * match feed over one is a self-inflicted outage. It is logged at error and counted, so
 * `ft_process_fatal_total{kind="unhandled_rejection"}` is the alert — silence is not the same as absence.
 */
export function installLifecycleHandlers(): void {
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));

  process.on('uncaughtException', (err) => {
    metrics.processFatal.inc({ kind: 'uncaught_exception' });
    log.error('uncaught exception — shutting down', {
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    void shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    metrics.processFatal.inc({ kind: 'unhandled_rejection' });
    log.error('unhandled promise rejection — continuing', {
      err: String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
