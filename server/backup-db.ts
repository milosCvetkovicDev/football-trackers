#!/usr/bin/env bun
/**
 * Telemetry-store backup CLI (audit §8 Phase 6).
 *
 *   bun run backup-db.ts             # take one verified backup, then rotate
 *   bun run backup-db.ts --list      # what is on disk, newest first (and what is past retention)
 *   bun run backup-db.ts --no-rotate # take one, keep everything
 *   bun run backup-db.ts --rotate-only  # expire old copies WITHOUT taking a new one
 *
 *   While the Docker stack is up, run it INSIDE the container so it sees the container's DB_PATH:
 *   docker compose exec -T server bun run backup-db.ts
 *   With the stack down, from server/:  cd server && DB_PATH=./data/telemetry.db bun run backup-db.ts
 *
 * WHY A CLI AND NOT A TIMER IN THE SERVER. `VACUUM INTO` reads the whole store and writes a full copy.
 * On a field box (a Pi with one SD card) doing that at an arbitrary moment means an I/O stall on the
 * same device the live 10 Hz ingest is writing to — a self-inflicted gap in exactly the data the backup
 * exists to protect. Backups belong between sessions, on the operator's schedule (cron, or by hand
 * after a match); the runbook in deploy/production/README.md has the crontab line.
 *
 * Env: DB_PATH (the store), BACKUP_DIR (default `backups/` beside the store), BACKUP_KEEP (default 7),
 *      RETENTION_DAYS (the age bound copies inherit from ADR-0010).
 *
 * Exit codes — the same discipline as purge-player.ts, because an operator scripts against these:
 *   0  a verified backup exists (JSON receipt on stdout — that receipt is the record).
 *   2  usage error.
 *   5  PERMANENT, fix something: DB_PATH is missing/empty/not a SQLite file, the backup directory is
 *      unwritable, or the copy came back SHORT of the source (it is deleted rather than kept — a
 *      truncated backup that opens cleanly is worse than no backup, because it will be trusted).
 */

import { BACKUP_DIR, BACKUP_KEEP, BackupError, createBackup, listBackups, rotateBackups } from './src/backup';
import { envNumber } from './src/env';
import { DB_PATH, absoluteDbPath } from './src/db-path';

/** Mirrors backup.ts's own read of the knob — used only to REPORT what is past the window. */
const RETENTION_DAYS = envNumber('RETENTION_DAYS', 30, { max: 3650 });

const args = process.argv.slice(2);
const known = new Set(['--list', '--no-rotate', '--rotate-only']);
const unknown = args.filter((a) => !known.has(a));
if (unknown.length) {
  console.error(
    `unknown argument(s): ${unknown.join(' ')}\n` +
      'usage: bun run backup-db.ts [--list] [--no-rotate] [--rotate-only]',
  );
  process.exit(2);
}

if (args.includes('--list')) {
  try {
    const files = listBackups();
    const now = Date.now();
    const maxAgeMs = RETENTION_DAYS > 0 ? RETENTION_DAYS * 86_400_000 : Infinity;
    const pastRetention = files.filter((f) => now - f.takenAtMs > maxAgeMs);
    console.log(
      JSON.stringify(
        {
          dir: BACKUP_DIR,
          keep: BACKUP_KEEP,
          retentionDays: RETENTION_DAYS,
          count: files.length,
          // Named explicitly: rotation runs when a NEW backup is taken, so a cron that has been failing
          // leaves expired copies of children's location sitting here with nothing else reporting it.
          // `--rotate-only` clears them without needing the store to be readable.
          pastRetention: pastRetention.length,
          backups: files.map((f) => ({
            path: f.path,
            takenAt: new Date(f.takenAtMs).toISOString(),
            bytes: f.bytes,
            pastRetention: now - f.takenAtMs > maxAgeMs,
          })),
        },
        null,
        2,
      ),
    );
    if (pastRetention.length > 0) {
      console.error(`note: ${pastRetention.length} backup(s) are older than RETENTION_DAYS=${RETENTION_DAYS}. Run: bun run backup-db.ts --rotate-only`);
    }
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, dir: BACKUP_DIR, error: String(err) }, null, 2));
    process.exit(5);
  }
}

if (args.includes('--rotate-only')) {
  try {
    const r = rotateBackups();
    console.log(JSON.stringify({ ok: true, dir: BACKUP_DIR, rotated: r.removed.length, expiredByRetention: r.expired.length, kept: r.kept }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, dir: BACKUP_DIR, error: String(err) }, null, 2));
    process.exit(5);
  }
}

// Rotation must NOT be conditional on the backup succeeding. It used to sit in the same try, so a night
// when the store was unreachable (moved volume, full disk, a name collision on a clock-less Pi) took the
// exit-5 path and expired NOTHING — and since rotation runs nowhere else, copies of children's location
// simply accumulated past the retention window for as long as the cron kept failing. Retention is not
// something to make contingent on an unrelated operation succeeding.
let takeError: unknown;
let result: ReturnType<typeof createBackup> | undefined;
try {
  result = createBackup();
} catch (err) {
  takeError = err;
}

let rotation = { removed: [] as string[], kept: -1, expired: [] as string[] };
try {
  rotation = args.includes('--no-rotate')
    ? { removed: [], kept: listBackups().length, expired: [] }
    : rotateBackups();
} catch (err) {
  console.error(`warning: rotation failed: ${String(err)}`);
}

if (takeError !== undefined || result === undefined) {
  const msg = takeError instanceof BackupError ? takeError.message : String(takeError);
  console.error(
    JSON.stringify(
      {
        ok: false,
        source: absoluteDbPath(DB_PATH),
        dir: BACKUP_DIR,
        error: msg,
        // Said even on the failure path, so a failing nightly cron still reports the retention state.
        rotated: rotation.removed.length,
        expiredByRetention: rotation.expired.length,
      },
      null,
      2,
    ),
  );
  process.exit(5);
}

{
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: absoluteDbPath(DB_PATH),
        backup: result.path,
        bytes: result.bytes,
        rows: result.backupRows,
        sourceRowsAtStart: result.sourceRows,
        verified: result.verified,
        ms: result.ms,
        rotated: rotation.removed.length,
        // Named separately because it is the compliance-relevant half: these copies were removed for
        // being older than RETENTION_DAYS, not merely for being surplus to BACKUP_KEEP.
        expiredByRetention: rotation.expired.length,
        kept: rotation.kept,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
