/**
 * Backups — `VACUUM INTO`, verified, with ERASURE-AWARE rotation (audit §8 Phase 6).
 *
 * WHY VACUUM INTO AND NOT `cp telemetry.db`. In WAL mode the store is three files, and a plain copy of
 * the main one is a torn snapshot: committed transactions still living in the `-wal` sidecar are simply
 * missing, and the result can be a database that opens fine and is quietly short. `VACUUM INTO` asks
 * SQLite for a consistent, fully-checkpointed, defragmented copy in one statement, from a normal
 * reader — so it can run while the server is serving. That is the whole reason it is the phase's chosen
 * mechanism rather than a shell script.
 *
 * WHY A BACKUP IS NOT JUST A FILE HERE. It is a complete copy of children's raw location. That makes
 * two things non-negotiable, and they are the reason this module exists rather than a one-line script:
 *
 *   1. RETENTION APPLIES TO COPIES. ADR-0010 bounds how long a fix may exist. A backup that outlives the
 *      window silently re-creates the data the retention sweep just destroyed, so rotation is bounded by
 *      BOTH a count (BACKUP_KEEP) and RETENTION_DAYS — whichever bites first.
 *   2. ERASURE REACHES COPIES. purge-player.ts used to say, in its own docstring, that a backup taken
 *      before a wipe was a residual it could not reach. With backups as a supported feature that is no
 *      longer an acceptable footnote: `purgePlayerFromBackups` runs the SAME erasure statements
 *      (src/erase.ts) against every backup, and the CLI's exit code reflects whether it succeeded.
 *      The phase's acceptance criterion is literally "purged player absent from every backup".
 *
 * SAFETY RULE ON DELETION: rotation only ever deletes files whose names match the pattern THIS module
 * writes. An operator's own `telemetry-before-the-cup-final.db` sitting in the directory is not ours to
 * delete, and a rotation that guesses is a rotation that eventually eats something irreplaceable.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { envInt, envNumber, envString } from './env';
import { DB_PATH, sqliteFileProblem } from './db-path';
import { countPlayerRows, countRows, openTelemetryStore, purgePlayerOn } from './erase';
import { log } from './log';
import { metrics } from './metrics';

/** Where backups live. Defaults to `backups/` NEXT TO the store, so one bind mount carries both. */
export const BACKUP_DIR = envString('BACKUP_DIR', join(dirname(resolve(DB_PATH)), 'backups'));
/** How many backups to keep, newest first. */
export const BACKUP_KEEP = envInt('BACKUP_KEEP', 7, { min: 1, max: 365 });
/**
 * The same window the live store is bounded by (ADR-0010). Read here rather than imported from
 * retention.ts so this module can be used by a CLI without pulling in the sweep's timers and the
 * server's own database handle.
 */
const RETENTION_DAYS = envNumber('RETENTION_DAYS', 30, { max: 3650 });

/** `telemetry-2026-08-27T11-42-05Z.db` — ours, and recognisably ours. Only these are ever rotated away. */
const NAME_RE = /^telemetry-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.db$/;

function stampFor(atMs: number): string {
  return new Date(atMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/** Epoch ms encoded in a backup's filename, or null when the name is not one of ours. */
export function backupTakenAt(file: string): number | null {
  const m = NAME_RE.exec(basename(file));
  if (!m) return null;
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // Round-trip it: `Date.parse('2026-02-30T00:00:00Z')` silently rolls forward to 2 March, so a name we
  // could never have written would be treated as ours AND mis-dated. If it does not round-trip, it is
  // not one of ours — and rotation only ever touches files that are.
  return stampFor(t) === m[1] ? t : null;
}

export class BackupError extends Error {}

export interface BackupFile {
  path: string;
  takenAtMs: number;
  bytes: number;
}

/** Does the backup directory exist at all? The erasure receipt needs to say so — see purge-player.ts. */
export function backupDirExists(dir: string = BACKUP_DIR): boolean {
  return existsSync(dir);
}

/**
 * Every backup THIS module wrote, newest first. Foreign files in the directory are ignored, not listed.
 *
 * A directory that does not exist is an empty list (a legitimate posture: nobody has taken a backup).
 * A directory that exists but cannot be READ throws — it used to escape as a bare `EACCES` stack trace
 * outside the CLI's documented exit codes, and, worse, "return [] on error" here would be
 * indistinguishable from "there are no backups", which is precisely the shape that lets an erasure
 * report success over copies it never opened.
 */
export function listBackups(dir: string = BACKUP_DIR): BackupFile[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new BackupError(`backup directory ${dir} cannot be read: ${String(err)}`);
  }
  const out: BackupFile[] = [];
  for (const name of names) {
    const takenAtMs = backupTakenAt(name);
    if (takenAtMs === null) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) out.push({ path, takenAtMs, bytes: st.size });
    } catch {
      /* vanished between readdir and stat — nothing to report */
    }
  }
  return out.sort((a, b) => b.takenAtMs - a.takenAtMs);
}

export interface BackupResult {
  path: string;
  bytes: number;
  sourceRows: number;
  backupRows: number;
  /** sourceRows === backupRows. The acceptance criterion — a copy that is short is not a backup. */
  verified: boolean;
  ms: number;
}

/**
 * Take one verified backup of `dbPath`.
 *
 * VERIFICATION IS PART OF TAKING IT, not a separate optional step: an unverified backup is a belief, and
 * the failure mode being guarded against (a torn or truncated copy) produces a file that opens perfectly.
 * The row count is compared against the source read AFTER the copy — under live ingest the source may
 * have grown in between, so the check is "the copy is not SHORT of what the source held when we started",
 * with the post-count reported so a reader can see the drift.
 */
export function createBackup(dbPath: string = DB_PATH, dir: string = BACKUP_DIR, now = Date.now()): BackupResult {
  const problem = sqliteFileProblem(dbPath);
  if (problem) throw new BackupError(`${problem}: ${resolve(dbPath)}`);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode applies only on create; an existing 0755 dir must not stay 0755

  const path = join(dir, `telemetry-${stampFor(now)}.db`);
  if (existsSync(path)) throw new BackupError(`backup already exists: ${path}`); // VACUUM INTO refuses anyway

  const t0 = performance.now();
  // A normal reader: VACUUM INTO is read-only with respect to the source, so this is safe against a live
  // server. busy_timeout so a concurrent write checkpoint does not turn into an instant SQLITE_BUSY.
  const src = new Database(dbPath, { create: false, readwrite: true });
  let sourceRows = 0;
  let backupRows = 0;
  let bytes = 0;
  try {
    src.exec('PRAGMA busy_timeout = 5000;');
    sourceRows = countRows(src);
    // Bound parameter, not string interpolation: a path is operator-supplied and may contain a quote.
    src.query('VACUUM INTO ?').run(path);
  } finally {
    src.close(false);
  }

  // 0600 immediately — between VACUUM INTO and this chmod the file is umask-default, so the directory's
  // 0700 is what actually protects it in that window. Both, not either.
  chmodSync(path, 0o600);
  bytes = statSync(path).size;

  const copy = new Database(path, { readonly: true });
  try {
    backupRows = countRows(copy);
  } finally {
    copy.close(false);
  }

  const result: BackupResult = {
    path,
    bytes,
    sourceRows,
    backupRows,
    verified: backupRows >= sourceRows,
    ms: Math.round(performance.now() - t0),
  };
  if (!result.verified) {
    // Do not leave a short copy lying around to be restored from one day.
    rmSync(path, { force: true });
    throw new BackupError(`backup verification failed: source had ${sourceRows} rows, copy had ${backupRows} — removed ${path}`);
  }
  log.info('backup created', { path, bytes, rows: backupRows, ms: result.ms });
  return result;
}

export interface RotationResult {
  removed: string[];
  kept: number;
  /** Removed because they aged past RETENTION_DAYS rather than because of the count cap. */
  expired: string[];
}

/**
 * Apply BOTH bounds and delete what neither keeps.
 *
 * The age bound is the one that matters for compliance: `BACKUP_KEEP=7` on a box that is backed up once
 * a month would otherwise retain seven months of children's location, six of them past the window the
 * live store is held to. Whichever bound bites first, bites.
 */
export function rotateBackups(
  dir: string = BACKUP_DIR,
  opts: { keep?: number; retentionDays?: number; now?: number } = {},
): RotationResult {
  const keep = opts.keep ?? BACKUP_KEEP;
  const retentionDays = opts.retentionDays ?? RETENTION_DAYS;
  const now = opts.now ?? Date.now();
  const all = listBackups(dir); // newest first, ours only
  const removed: string[] = [];
  const expired: string[] = [];

  const maxAgeMs = retentionDays > 0 ? retentionDays * 86_400_000 : Infinity;
  // A stamp in the FUTURE can never age past the window — `now - takenAtMs` stays negative — so a copy
  // written while the box's clock was ahead (a Pi has no RTC; it boots in 1970 or wherever it left off,
  // and can be ahead after a bad NTP step) would be immortal under the retention rule. A complete copy of
  // children's location that NO retention rule can ever expire is worse than a lost backup, and there are
  // BACKUP_KEEP others. One day of slack, then it goes, loudly.
  const FUTURE_SLACK_MS = 86_400_000;
  all.forEach((b, i) => {
    const undatable = b.takenAtMs > now + FUTURE_SLACK_MS;
    const tooOld = now - b.takenAtMs > maxAgeMs;
    const tooMany = i >= keep;
    if (undatable) {
      log.warn('backup has a FUTURE timestamp and can never expire — removing it', {
        path: b.path,
        takenAt: new Date(b.takenAtMs).toISOString(),
        now: new Date(now).toISOString(),
      });
    }
    if (!tooOld && !tooMany && !undatable) return;
    try {
      rmSync(b.path, { force: true });
      removed.push(b.path);
      if (tooOld || undatable) expired.push(b.path);
    } catch (err) {
      log.warn('backup rotation could not remove a file', { path: b.path, err: String(err) });
    }
  });
  if (removed.length) log.info('backups rotated', { removed: removed.length, expired: expired.length, kept: all.length - removed.length });
  return { removed, kept: all.length - removed.length, expired };
}

/**
 * Point-in-time backup stats, for /metrics. Cheap (one readdir of at most a handful of files) and read on
 * the scrape path like the retention gauges — because "rotation only happens when a NEW backup is taken"
 * means a cron that has been failing for a month leaves month-old copies of children's location on disk
 * with nothing anywhere saying so. Errors are swallowed to `null`: a metrics scrape must never throw.
 */
export function backupStats(dir: string = BACKUP_DIR): { count: number; oldestAgeSeconds: number; bytes: number } | null {
  try {
    const all = listBackups(dir);
    if (all.length === 0) return { count: 0, oldestAgeSeconds: 0, bytes: 0 };
    const oldest = all[all.length - 1].takenAtMs;
    return {
      count: all.length,
      // Clamped at 0: a future-dated copy would otherwise report a negative age and read as "brand new".
      oldestAgeSeconds: Math.max(0, Math.round((Date.now() - oldest) / 1000)),
      bytes: all.reduce((n, b) => n + b.bytes, 0),
    };
  } catch {
    return null;
  }
}

/** Call on the /metrics scrape path, beside refreshRetentionGauges(). Never throws. */
export function refreshBackupGauges(dir: string = BACKUP_DIR): void {
  const st = backupStats(dir);
  if (st === null) return; // unreadable directory — leave the last values rather than publishing a lie
  metrics.backupCount.set({}, st.count);
  metrics.backupOldestAge.set({}, st.oldestAgeSeconds);
  metrics.backupBytes.set({}, st.bytes);
}

export interface BackupPurgeEntry {
  path: string;
  erased: number;
  /** Rows still matching the player AFTER the erase + VACUUM. Must be 0; anything else is a failure. */
  remaining: number;
  ok: boolean;
  error?: string;
}

/**
 * Erase a player from EVERY backup, using the same statements as the live store (src/erase.ts).
 *
 * Each file is opened, purged in bounded batches, then VACUUMed — the VACUUM is not optional: audit
 * §4.5(a) established that `secure_delete` alone leaves erased rows recoverable inside leaf pages that a
 * surviving player still occupies, and a backup is exactly the artefact someone would go looking at.
 *
 * `remaining` is re-counted afterwards so the receipt PROVES the erasure rather than asserting it. A file
 * that cannot be opened or written is reported with ok:false and the reason — never skipped silently,
 * because "the erasure completed" is a compliance claim.
 */
export async function purgePlayerFromBackups(
  playerId: string,
  sessionId: string | undefined,
  opts: { dir?: string; batch?: number } = {},
): Promise<BackupPurgeEntry[]> {
  const dir = opts.dir ?? BACKUP_DIR;
  const batch = opts.batch ?? 5_000;
  const out: BackupPurgeEntry[] = [];

  for (const b of listBackups(dir)) {
    const entry: BackupPurgeEntry = { path: b.path, erased: 0, remaining: -1, ok: false };
    let db: Database | null = null;
    try {
      db = openTelemetryStore(b.path); // create:false + secure_delete ON
      entry.erased = await purgePlayerOn(db, playerId, sessionId, batch);
      db.exec('VACUUM'); // rebuild every page: freed-page zeroing is not enough (audit §4.5 a)
      entry.remaining = countPlayerRows(db, playerId, sessionId);
      entry.ok = entry.remaining === 0;
      if (!entry.ok) entry.error = `${entry.remaining} row(s) still present after erase`;
    } catch (err) {
      entry.error = String(err);
    } finally {
      try { db?.close(false); } catch { /* already closed */ }
    }
    out.push(entry);
  }
  return out;
}
