/**
 * Retention & data minimisation (ADR-0010).
 *
 * Raw 10 Hz fixes are the live location of children. The longer they are kept and
 * the more copies exist, the larger the breach blast-radius — so the field box keeps
 * raw fixes for `RETENTION_DAYS` (default 30) and a scheduled sweep auto-deletes
 * anything older. The durable analytic value lives in per-session aggregates, not the
 * indefinite raw trace. Per-player erasure (right-to-be-forgotten / lost device) is the
 * separate purge-player.ts CLI; this module owns the time-based purge only.
 *
 * The sweep is instrumented so the retention guarantee is observable, not just asserted:
 *   - ft_retention_rows_purged_total          — how much the job removed (present-at-0)
 *   - ft_retention_last_run_timestamp_seconds  — liveness: did the sweep actually run
 *   - ft_retention_sweep_failures_total        — did it error
 *   - ft_oldest_raw_fix_age_seconds            — data-minimisation SLI (oldest fix still held)
 *   - ft_retention_roster_sessions_pruned_total — roster sessions dropped because their fixes are gone
 *
 * The sweep ALSO bounds the name↔playerId map (audit §4.5): once a session's last raw fix has expired,
 * its roster entries have no location left to identify and are dropped after the same window — otherwise
 * roster.json would outlive every fix it names, with no time bound and no SLI watching it.
 */

import { purgeOlderThan, oldestServerTs, sessionHasTelemetry } from './db';
import { pruneRosterSessions } from './roster';
import { metrics } from './metrics';
import { log } from './log';

const DAY_MS = 86_400_000;

// Fail SAFE on a malformed value: a typo like RETENTION_DAYS="30d"/"abc"/"Infinity"
// coerces to NaN/Infinity, which must NOT silently disable the purge (the exact
// unbounded-retention failure ADR-0010 exists to prevent). Non-finite -> 30-day default.
const parsedDays = Number(process.env.RETENTION_DAYS ?? 30);
/** Retention window in days; <= 0 disables the time-based purge (keeps raw indefinitely). */
export const RETENTION_DAYS = Number.isFinite(parsedDays) ? parsedDays : 30;
/** How often the sweep runs (default hourly); the window, not the cadence, is what matters. */
const SWEEP_MS = Number(process.env.RETENTION_SWEEP_MS ?? 3_600_000);
/** Rows per DELETE batch — bounds how long a single synchronous statement holds the loop. */
const BATCH = Number(process.env.RETENTION_BATCH ?? 50_000);

/**
 * Refresh the data-minimisation gauge: how old is the oldest raw fix we still hold.
 * Cheap (one indexed MIN) and self-contained: it swallows its own DB errors so a bad
 * read degrades this one gauge instead of failing the whole /metrics scrape or a sweep.
 */
export function refreshRetentionGauges(now: number = Date.now()): void {
  try {
    const oldest = oldestServerTs();
    metrics.oldestRawFixAge.set({}, oldest == null ? 0 : Math.max(0, (now - oldest) / 1000));
  } catch (err) {
    log.error('retention gauge refresh failed', { err: String(err) });
  }
}

/**
 * Run one retention sweep: delete raw fixes older than the window, in event-loop-yielding
 * batches so a large backlog can't freeze live ingest/fan-out. Returns rows removed.
 * Never throws — a failed sweep is counted and logged so the server keeps serving.
 */
export async function runRetention(now: number = Date.now()): Promise<number> {
  let removed = 0;
  if (RETENTION_DAYS > 0) {
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    try {
      let n: number;
      do {
        n = purgeOlderThan(cutoff, BATCH);
        removed += n;
        if (n === BATCH) await new Promise((r) => setTimeout(r, 0)); // yield between full batches
      } while (n === BATCH);
      if (removed > 0) log.info('retention purge', { removed, retentionDays: RETENTION_DAYS });
    } catch (err) {
      metrics.retentionSweepFailures.inc();
      log.error('retention purge failed', { err: String(err) });
    }
    // Names follow the fixes: prune roster sessions with nothing left to identify. Its own try — a roster
    // file problem must not be mistaken for a telemetry-sweep failure, and vice versa.
    try {
      const pruned = await pruneRosterSessions(sessionHasTelemetry, now, RETENTION_DAYS * DAY_MS);
      metrics.rosterSessionsPruned.inc({}, pruned);
    } catch (err) {
      if (/locked by another writer/.test(String(err))) {
        // A purge-player.ts or roster-user.ts run overlapping the tick is benign: skip this hour's prune,
        // do not trip the sweep-failure alert.
        log.warn('roster prune skipped — the roster is locked by another writer; next sweep will retry');
      } else {
        metrics.retentionSweepFailures.inc();
        log.error('roster prune failed', { err: String(err) }); // content-free by construction (roster.ts)
      }
    }
  }
  // Always emit the work signal (present-at-0) and the liveness stamp — success or caught
  // failure — so an operator can tell "ran, nothing expired" from "never ran".
  metrics.retentionPurged.inc({}, removed);
  metrics.retentionLastRun.set({}, now / 1000);
  refreshRetentionGauges(now);
  return removed;
}

/** Start the periodic retention job: an immediate sweep, then one every SWEEP_MS. */
export function startRetention(): ReturnType<typeof setInterval> {
  const raw = process.env.RETENTION_DAYS;
  if (raw !== undefined && !Number.isFinite(Number(raw))) {
    log.warn('RETENTION_DAYS is not a finite number — falling back to the 30-day default', { provided: raw });
  }
  if (!(RETENTION_DAYS > 0)) {
    log.warn('RETENTION_DAYS <= 0 — time-based purge is DISABLED; raw fixes are kept indefinitely');
  }
  // Seed the work counter so it is present-at-0 from the first scrape, before the first
  // sweep completes — otherwise "stays at 0" / rate() alerts have no series to bind to.
  metrics.retentionPurged.inc({}, 0);
  metrics.rosterSessionsPruned.inc({}, 0);
  void runRetention();
  const timer = setInterval(() => void runRetention(), SWEEP_MS);
  // Don't let the sweep timer by itself hold the process open.
  timer.unref?.();
  log.info('retention scheduled', { retentionDays: RETENTION_DAYS, sweepMs: SWEEP_MS, batch: BATCH });
  return timer;
}
