#!/usr/bin/env bun
/**
 * Right-to-erasure / lost-device wipe (ADR-0010).
 *
 * Deletes a player's raw fixes from the field-box telemetry DB AND the player's roster entry (ADR-0016
 * §1.4), then VACUUMs and forces a WAL TRUNCATE checkpoint so the rebuilt pages replace the old ones ON
 * DISK. Operates directly on DB_PATH with no network surface — the running server's /live and /metrics
 * listeners gain no mutation endpoint from this. WAL + busy_timeout (db.ts) let it run while the server is
 * live, but VACUUM holds the write lock for a time proportional to store size — run erasures between
 * sessions, not mid-match.
 *
 *   bun run purge-player.ts <playerId> [sessionId]
 *
 *   bun run purge-player.ts 07            # erase player 07 across every session
 *   bun run purge-player.ts 07 morning-5s # erase player 07 from one session only
 *
 *   While the Docker stack is up, run it INSIDE the container so it sees the container's DB_PATH and roster:
 *   docker compose exec -T server bun run purge-player.ts 07
 *   With the stack down, from server/ (both DB_PATH and the roster path resolve against the cwd):
 *   cd server && DB_PATH=./data/telemetry.db bun run purge-player.ts 07
 *
 * Order of operations (each step's failure is reported as what it is):
 *   1. validate ids; refuse a DB_PATH that is missing / empty / not SQLite (exit 5) BEFORE opening it; refuse
 *      when the disk cannot hold the rebuild (~2.5× the store, exit 5);
 *   2. under the roster lock (milliseconds): READ the roster — unreadable/malformed → exit 5, NOTHING changed;
 *   3. delete the rows in indexed, bounded batches (outside the roster lock — the DB has its own);
 *   4. under the roster lock again: rewrite the roster without the entry, re-read to verify;
 *   5. always (even after a failure in 3-4): VACUUM, PASSIVE checkpoint, then short TRUNCATE attempts.
 *
 * Exit codes — each one means something different for the operator, so never collapse them:
 *   0  erased. The JSON receipt on stdout is the compliance record (with deleteMs/vacuumMs/checkpointMs/
 *      totalMs/storeBytes — how long the store was under the knife).
 *   2  usage error (missing/invalid playerId or sessionId — an id the system cannot contain must never
 *      become an "erased 0" success record that gets filed for the real player).
 *   3  TRANSIENT: the erasure did not complete (roster locked by a live writer, DB busy, delete failed). The
 *      receipt's `erased` is the TRUE number of rows already deleted. Re-run; it is idempotent.
 *   4  rows and roster entry erased, but the on-disk rebuild did not complete (a reader pinned the WAL, a
 *      live writer held the checkpoint lock, or a BACKUP could not be erased) — residue may remain. Re-run
 *      the SAME command until it exits 0.
 *   5  PERMANENT — fix something, do not just retry: DB_PATH is the wrong file (missing, empty, not SQLite,
 *      read-only), the disk is too full for the rebuild, or the roster is unreadable/malformed/unwritable
 *      (wrong AUTH_ROSTER_FILE path, permissions, a lock that cannot be removed, a name inside a structure the
 *      rewrite cannot reach). The receipt carries `retry:false` and names the path(s). bun:sqlite would
 *      otherwise CREATE a missing DB or INITIALISE an empty one and report "erased 0" as success (audit §4.5 e).
 *   `rosterFound` is null on a receipt emitted before the roster was read; false = no file at the path named.
 *
 * READ `backupsFound` ON THE RECEIPT. It says whether the directory named in `backupDir` existed at all.
 * `backups: []` alone cannot distinguish "this box takes no backups" from "BACKUP_DIR is the host path
 * and the container's copies were never opened" — and this receipt is a compliance record, so it must not
 * be able to say "erased" over copies it never looked at. Same signal, same reason, as `rosterFound`.
 *
 * BACKUPS ARE ERASED TOO (Phase 6). This used to read "a file-level backup taken before this wipe is a
 * residual this CLI cannot reach" — which stopped being acceptable the moment backups became a supported
 * feature (src/backup.ts). Every `telemetry-*.db` in BACKUP_DIR now gets the SAME erasure statements
 * (src/erase.ts) plus its own VACUUM, and the receipt carries a per-file result that PROVES it by
 * re-counting. A backup that could not be erased is exit 4 with `retry:true`, never a silent success.
 * Backups THIS command cannot see — copies an operator made elsewhere, an SD-card image — remain the
 * operator's responsibility, and the runbook says so.
 *
 * The one residual that genuinely remains: per-player Prometheus series in the RUNNING server's in-memory
 * registry (pseudonymous, loopback-only /metrics; restart the server to clear them). See the erasure
 * runbook in docs/architecture/observability.md.
 */

import { dirname, resolve } from 'node:path';
import { realpathSync, statSync, statfsSync } from 'node:fs';
import { DB_PATH, absoluteDbPath, sqliteFileProblem } from './src/db-path';
import { PLAYER_ID_RE } from './src/roster';

const [playerId, sessionId] = process.argv.slice(2);

function usage(msg: string): never {
  console.error(`${msg}\nusage: bun run purge-player.ts <playerId> [sessionId]   (ids: [A-Za-z0-9._-]{1,64})`);
  process.exit(2);
}
if (!playerId) usage('missing playerId');
if (!PLAYER_ID_RE.test(playerId)) usage('invalid playerId');
if (sessionId !== undefined && !PLAYER_ID_RE.test(sessionId)) usage('invalid sessionId');

const dbPath = absoluteDbPath(DB_PATH);
const rosterFile = resolve(process.env.AUTH_ROSTER_FILE ?? './roster.json');
/** Receipt paths: the real path where one exists, so the two fields read as the same tree. */
const shown = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/** Wrong file / permissions / disk — permanent: exit 5, retry:false. */
function permanent(error: string, extra: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ erased: 0, rosterEntriesErased: 0, rosterFound: null, playerId, error, dbPath: shown(dbPath), rosterFile: shown(rosterFile), retry: false, ...extra }));
  process.exit(5);
}

// Audit §4.5(e): check BEFORE importing db.ts — it opens (creates / initialises) DB_PATH on import.
const problem = sqliteFileProblem(DB_PATH);
if (problem) permanent(`${problem} — nothing erased. This is the wrong file, not a transient failure; do not retry with the same path.`);

// VACUUM appends a full rebuilt copy of the store to the WAL and the secure_delete batches add zeroed page
// images before it: the checker measured a transient footprint of ~2.6× the store. Refuse up front rather than
// die mid-VACUUM with SQLITE_FULL (which no retry fixes).
const storeBytes = statSync(dbPath).size;
const FREE_FACTOR = 2.5;
{
  const fsInfo = statfsSync(dirname(dbPath));
  const freeBytes = Number(fsInfo.bavail) * Number(fsInfo.bsize);
  if (freeBytes < storeBytes * FREE_FACTOR) {
    permanent(`not enough free disk for the rebuild: ${Math.round(freeBytes / 1e6)} MB free, need ~${Math.round((storeBytes * FREE_FACTOR) / 1e6)} MB (${FREE_FACTOR}× the ${Math.round(storeBytes / 1e6)} MB store) — free space, then re-run`, { storeBytes, freeBytes });
  }
}
// ~5 ms/MB on an M-series Mac (slower on a Pi); above this the live server's 5 s busy_timeout is at risk.
const VACUUM_WARN_BYTES = 256 * 1024 * 1024;
if (storeBytes > VACUUM_WARN_BYTES) {
  console.error(`warning: ${Math.round(storeBytes / 1e6)} MB store — the VACUUM will hold the write lock for roughly ${Math.round(storeBytes / 1e6 * 5 / 1000)} s+; a live server drops fixes meanwhile. Erase between sessions.`);
}

/** TRUNCATE attempts: each holds the WRITE lock while it busy-waits, so keep the wait short and the sleeps long. */
const TRUNCATE_ATTEMPTS = 12;
const TRUNCATE_BUSY_MS = 100;
const TRUNCATE_SLEEP_MS = 400;

// Receipt state is tracked OUTSIDE the try so a failure receipt reports what actually happened.
const t0 = performance.now();
let erased = 0;
let rosterEntriesErased = 0;
let rosterFound: boolean | null = null; // null = never got as far as reading it
let vacuumed = false;
let vacuumMs = -1;
let deleteMs = -1;
let checkpointMs = -1;
let walTruncated = false;
let wal: { busy: number; log: number; checkpointed: number } | undefined;
let failure: Error | undefined;
let backups: Awaited<ReturnType<typeof import('./src/backup').purgePlayerFromBackups>> = [];
let backupsMs = -1;
// Which directory was searched, and did it exist? `backups: []` on its own is indistinguishable from
// "BACKUP_DIR is a typo / the host path instead of the container one" — and the receipt is a compliance
// record. This is the same signal `rosterFound` already provides for the roster, for the same reason.
let backupDir: string | null = null;
let backupsFound: boolean | null = null;

let dbMod: typeof import('./src/db') | undefined;
try {
  // Import inside the guard so even a failure to OPEN the DB (SQLITE_CANTOPEN, permissions) yields a
  // clear non-zero receipt rather than a bare stack trace — db.ts opens on import.
  dbMod = await import('./src/db');
  const { purgePlayer } = dbMod;
  const { withRosterLock, readRosterFile, purgeRosterPlayer } = await import('./src/roster');

  // 1. Read (and validate) the roster FIRST, under the lock: if it cannot be read, nothing has changed yet and
  //    the failure is literally "nothing was changed". A MISSING file is a valid posture (no names provisioned)
  //    — reported as rosterFound:false so a run from the wrong cwd cannot pass for a complete erasure unnoticed.
  await withRosterLock(async () => {
    rosterFound = (await readRosterFile()) !== null;
  });
  // 2. Delete the rows — OUTSIDE the roster lock (the DB has its own; a big delete can run for minutes and a
  //    lock held that long would be the one thing the other writers must not be made to wait on or break).
  const td = performance.now();
  erased = await purgePlayer(playerId, sessionId);
  deleteMs = Math.round(performance.now() - td);
  // 3. Remove the entry under a fresh short lock (re-reads the file, rewrites, re-reads to verify). A
  //    roster-write failure surfaces as a failure receipt with the TRUE `erased`, never as a silent partial
  //    erasure. 0 entries removed still exits 0 — the erasure goal is met regardless.
  await withRosterLock(async () => {
    rosterEntriesErased = await purgeRosterPlayer(playerId, sessionId);
  });
  // 4. Every backup is a full copy of the same children's location data (Phase 6). Same statements, same
  //    VACUUM, and the count is re-read afterwards so the receipt proves the erasure instead of claiming it.
  //    Runs after the live store so a crash between the two leaves the SMALLER surface behind, and so a
  //    re-run (this command is idempotent) always converges.
  const tb = performance.now();
  const { purgePlayerFromBackups, BACKUP_DIR, backupDirExists } = await import('./src/backup');
  backupDir = BACKUP_DIR;
  backupsFound = backupDirExists();
  backups = await purgePlayerFromBackups(playerId, sessionId);
  backupsMs = Math.round(performance.now() - tb);
} catch (err) {
  failure = err instanceof Error ? err : new Error(String(err)); // content-free by construction (roster.ts code-only errors, SQLite codes)
} finally {
  // Audit §4.5(a) + checker finding: secure_delete zeroes FREED pages only; a leaf page a survivor still
  // lives on is rebalanced in place and keeps the erased rows' bytes in its gap. VACUUM rebuilds every
  // page; the checkpoint then moves the rebuilt pages into the main file and shrinks the WAL to 0 bytes.
  // Runs even after a failure in the block above, so a partial run never leaves pre-delete images behind.
  if (dbMod) {
    try {
      vacuumMs = dbMod.vacuum();
      vacuumed = true;
    } catch (err) {
      failure ??= new Error(`VACUUM failed: ${String(err)}`);
    }
    const tc = performance.now();
    try {
      dbMod.checkpointPassive(); // bulk copy without the write lock or waiting on readers
      dbMod.setBusyTimeout(TRUNCATE_BUSY_MS); // a TRUNCATE busy-waits HOLDING the write lock — keep it short
      for (let attempt = 0; attempt < TRUNCATE_ATTEMPTS; attempt++) {
        if (attempt > 0) await Bun.sleep(TRUNCATE_SLEEP_MS);
        wal = dbMod.checkpointTruncate();
        if (wal.busy === 0) break;
      }
      walTruncated = wal?.busy === 0;
    } catch (err) {
      failure ??= new Error(`WAL checkpoint failed: ${String(err)}`);
    }
    checkpointMs = Math.round(performance.now() - tc);
  }
}

const receipt = {
  erased,
  rosterEntriesErased,
  rosterFound,
  walTruncated,
  vacuumed,
  deleteMs,
  vacuumMs,
  checkpointMs,
  totalMs: Math.round(performance.now() - t0),
  backupsMs,
  // One entry per backup file, each with rows erased and rows REMAINING (which must be 0). Paths only —
  // a backup filename carries a timestamp, never a player id or a name.
  backups: backups.map((b) => ({ path: b.path, erased: b.erased, remaining: b.remaining, ok: b.ok, ...(b.error ? { error: b.error } : {}) })),
  backupsErased: backups.reduce((n, b) => n + b.erased, 0),
  // `backupsFound:false` = there is no directory at `backupDir`. That is a valid posture (nobody takes
  // backups) AND the signature of a wrong BACKUP_DIR — the operator has to be able to tell which.
  backupDir: backupDir === null ? null : shown(backupDir),
  backupsFound,
  storeBytes,
  playerId,
  scope: sessionId ? { sessionId } : 'all sessions',
  dbPath: shown(dbPath),
  rosterFile: shown(rosterFile),
};

if (failure !== undefined) {
  const { RosterPermanentError } = await import('./src/roster');
  const { SchemaTooNewError, ForeignStoreError } = await import('./src/migrate');
  const msg = String(failure.message ?? failure);
  // Permanent conditions — wrong path/permissions/disk — are exit 5: "retry" would never succeed. A read-only
  // store (root-owned bind mount on Linux, host vs container) and a full disk land here too.
  //
  // The two schema refusals belong here as well, and used to fall through to the transient branch (checker
  // finding): a store newer than this binary, or a DB_PATH pointing at somebody else's database, are
  // exactly "the wrong file" — the receipt told the operator to re-run an erasure that can never succeed,
  // and that receipt is a compliance record.
  if (
    failure instanceof RosterPermanentError ||
    failure instanceof SchemaTooNewError ||
    failure instanceof ForeignStoreError ||
    /readonly|read-only|SQLITE_FULL|disk is full/i.test(msg)
  ) {
    console.error(JSON.stringify({ ...receipt, error: /readonly|read-only/i.test(msg) ? `${msg} — the store is read-only for this user; run inside the container (docker compose exec) or fix ownership` : msg, retry: false }));
    process.exit(5);
  }
  // Make a compliance failure unmistakable: a non-zero JSON receipt + exit 3, never a bare stack trace an
  // operator might mistake for a transient glitch.
  console.error(JSON.stringify({ ...receipt, error: msg, retry: true }));
  process.exit(3);
}
const badBackups = backups.filter((b) => !b.ok);
if (badBackups.length > 0) {
  // The store itself is clean, but a COPY still holds the player's fixes — which is not an erasure. Exit 4
  // (residue), the same class as an incomplete rebuild: re-run once the cause (permissions, a locked file)
  // is gone, or delete the offending backup outright.
  console.error(JSON.stringify({
    ...receipt,
    error: `${badBackups.length} of ${backups.length} backup(s) still hold this player's fixes — the erasure is NOT complete. Fix the listed file(s) (permissions, or remove them) and re-run`,
    retry: true,
  }));
  process.exit(4);
}
if (!walTruncated || !vacuumed) {
  // log === -1: the checkpoint could not even take the lock (a live writer's own checkpoint in progress);
  // log >= 0: a reader pinned `log - checkpointed` frames. Both: re-run; it is idempotent.
  const cause = !vacuumed ? 'the VACUUM did not complete' : wal && wal.log >= 0 ? `a reader pinned the WAL (${wal.log - wal.checkpointed} of ${wal.log} frames not checkpointed)` : 'the checkpoint lock was busy (a live writer was checkpointing)';
  console.error(JSON.stringify({ ...receipt, wal, error: `rows and roster entry erased, but the on-disk rebuild did not complete — ${cause}; residue may remain. Re-run this command`, retry: true }));
  process.exit(4);
}
if (rosterFound === false) {
  console.error(`note: no roster file at ${shown(rosterFile)} — names were not provisioned there (or this is the wrong cwd/AUTH_ROSTER_FILE); the receipt says rosterFound:false`);
}
if (backupsFound === false) {
  console.error(`note: no backup directory at ${backupDir === null ? '(unknown)' : shown(backupDir)} — nothing was searched for copies. If this box DOES take backups, BACKUP_DIR is wrong (host path vs container path?) and the copies still hold this player; the receipt says backupsFound:false`);
} else if (backups.length === 0 && backupsFound) {
  console.error(`note: ${shown(backupDir!)} exists but holds no telemetry-*.db backups — nothing to erase there`);
}
console.log(JSON.stringify(receipt));
process.exit(0);
