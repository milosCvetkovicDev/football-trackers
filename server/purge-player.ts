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
 *   1. validate ids; refuse a DB_PATH that is missing / empty / not SQLite (exit 5) BEFORE opening it;
 *   2. take the roster lock; READ the roster (an unreadable file → exit 3 with NOTHING changed);
 *   3. delete the rows in indexed, bounded batches;
 *   4. rewrite the roster without the entry, re-read to verify, release the lock;
 *   5. always (even after a failure in 3-4): VACUUM, PASSIVE checkpoint, then short TRUNCATE attempts.
 *
 * Exit codes — each one means something different for the operator, so never collapse them:
 *   0  erased. The JSON receipt on stdout is the compliance record.
 *   2  usage error (missing/invalid playerId or sessionId — an id the system cannot contain must never
 *      become an "erased 0" success record that gets filed for the real player).
 *   3  the erasure did NOT complete (roster locked/unreadable/unwritable, DB busy, delete failed). The
 *      receipt's `erased` is the TRUE number of rows already deleted (0 when the roster was unreadable —
 *      that is checked first). Re-run; it is idempotent.
 *   4  rows and roster entry erased, but the WAL could not be truncated (a reader held it) — residue may
 *      remain on disk. Re-run the SAME command until it exits 0.
 *   5  DB_PATH is the WRONG FILE (does not exist, is empty, is not SQLite, or is read-only), not a transient
 *      fault: retrying erases nothing, forever. Fix DB_PATH / permissions. bun:sqlite would otherwise
 *      CREATE a missing file or INITIALISE an empty one and report "erased 0" as success (audit §4.5 e).
 *
 * Residuals this CLI cannot reach from a separate process: (a) per-player Prometheus series in the RUNNING
 * server's in-memory registry (pseudonymous, loopback-only /metrics; restart the server to clear them);
 * (b) any file-level backup of telemetry.db taken before this wipe. See the erasure runbook in
 * docs/architecture/observability.md.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
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

function wrongFile(error: string): never {
  console.error(JSON.stringify({ erased: 0, rosterEntriesErased: 0, playerId, error, dbPath, rosterFile, retry: false }));
  process.exit(5);
}

// Audit §4.5(e): check BEFORE importing db.ts — it opens (creates / initialises) DB_PATH on import.
const problem = sqliteFileProblem(DB_PATH);
if (problem) wrongFile(`${problem} — nothing erased. This is the wrong file, not a transient failure; do not retry with the same path.`);

/** TRUNCATE attempts: each holds the WRITE lock while it busy-waits, so keep the wait short and the sleeps long. */
const TRUNCATE_ATTEMPTS = 8;
const TRUNCATE_BUSY_MS = 100;
const TRUNCATE_SLEEP_MS = 250;

// Receipt state is tracked OUTSIDE the try so a failure receipt reports what actually happened.
let erased = 0;
let rosterEntriesErased = 0;
let rosterFound = false;
let vacuumed = false;
let vacuumMs = -1;
let walTruncated = false;
let wal: { busy: number; log: number; checkpointed: number } | undefined;
let failure: string | undefined;

let dbMod: typeof import('./src/db') | undefined;
try {
  // Import inside the guard so even a failure to OPEN the DB (SQLITE_CANTOPEN, permissions) yields a
  // clear non-zero receipt rather than a bare stack trace — db.ts opens on import.
  dbMod = await import('./src/db');
  const { purgePlayer } = dbMod;
  const { withRosterLock, readRosterFile, purgeRosterPlayer } = await import('./src/roster');

  await withRosterLock(async () => {
    // Read (and validate) the roster FIRST: if it cannot be read, nothing has changed yet and exit 3 is
    // literally true. A MISSING file is a valid posture (no names provisioned) — reported in the receipt
    // as rosterFound:false so a run from the wrong cwd cannot pass for a complete erasure unnoticed.
    const raw = await readRosterFile();
    rosterFound = raw !== null;
    erased = await purgePlayer(playerId, sessionId);
    // Same lock, same run: a roster-write failure surfaces as exit 3 with the true `erased`, never as a
    // silent partial erasure (raw fixes gone but the name lingers). 0 entries removed still exits 0 — the
    // erasure goal is met regardless, matching purgePlayer's 0-rows semantics.
    rosterEntriesErased = await purgeRosterPlayer(playerId, sessionId, raw);
  });
} catch (err) {
  failure = String(err); // content-free by construction: roster.ts throws code-only errors, db.ts SQLite codes
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
      failure ??= `VACUUM failed: ${String(err)}`;
    }
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
      failure ??= `WAL checkpoint failed: ${String(err)}`;
    }
  }
}

const receipt = {
  erased,
  rosterEntriesErased,
  rosterFound,
  walTruncated,
  vacuumed,
  vacuumMs,
  playerId,
  scope: sessionId ? { sessionId } : 'all sessions',
  dbPath,
  rosterFile,
};

if (failure !== undefined) {
  // A read-only store is a WRONG-FILE/permissions problem (root-owned bind mount on Linux, host vs
  // container), not a transient fault — "retry" would never succeed.
  if (/readonly|read-only/i.test(failure)) {
    console.error(JSON.stringify({ ...receipt, error: `${failure} — the store is read-only for this user; run inside the container (docker compose exec) or fix ownership`, retry: false }));
    process.exit(5);
  }
  // Make a compliance failure unmistakable: a non-zero JSON receipt + exit 3, never a bare stack trace an
  // operator might mistake for a transient glitch.
  console.error(JSON.stringify({ ...receipt, error: failure, retry: true }));
  process.exit(3);
}
if (!walTruncated || !vacuumed) {
  console.error(JSON.stringify({ ...receipt, wal, error: 'rows and roster entry erased, but the on-disk rebuild did not complete (a reader held the WAL) — residue may remain; re-run this command', retry: true }));
  process.exit(4);
}
if (!rosterFound && !existsSync(rosterFile)) {
  console.error(`note: no roster file at ${rosterFile} — names were not provisioned there (or this is the wrong cwd/AUTH_ROSTER_FILE); the receipt says rosterFound:false`);
}
console.log(JSON.stringify(receipt));
process.exit(0);
