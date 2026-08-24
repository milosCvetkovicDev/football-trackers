/**
 * Persistence — the "local SQLite" option from the original TODO, via Bun's
 * built-in bun:sqlite (no external dependency).
 *
 * At 10 players x 10 Hz (~100 inserts/s) a single prepared statement in WAL mode
 * is comfortable, so we keep it simple — no batching needed at this scale.
 * Swap this module for a TimescaleDB writer later without touching ingest.ts.
 */

import { Database } from 'bun:sqlite';
import type { Telemetry } from './types';
import { DB_PATH } from './db-path';
import { envInt } from './env';

const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
// Audit §4.5(a): secure_delete zeroes freed pages in the page images THIS connection writes — and in
// WAL mode those land in the -wal sidecar, where the PRE-delete images also still sit. Without this
// pragma a WAL reset merely rewinds the write cursor and the old frames stay on disk until overwritten;
// with it, every reset truncates the file. purge-player.ts additionally forces a TRUNCATE checkpoint
// (checkpointTruncate below) so an erasure does not wait for the next incidental reset.
db.exec('PRAGMA journal_size_limit = 0;');
// WAL lets the purge-player CLI mutate the DB while the server is running; the
// busy timeout makes the two processes wait briefly for the lock instead of
// erroring out with SQLITE_BUSY.
db.exec('PRAGMA busy_timeout = 5000;');
// This data is children's location: a plain DELETE only marks pages free, leaving
// the row bytes recoverable in the file until overwritten. secure_delete zeroes
// freed pages on every DELETE so the retention sweep and purge-player erasure
// actually destroy the bytes (defence-in-depth alongside OS full-disk encryption).
db.exec('PRAGMA secure_delete = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS telemetry (
    server_ts  INTEGER NOT NULL,   -- authoritative ingest timestamp
    session_id TEXT    NOT NULL,
    player_id  TEXT    NOT NULL,
    device_id  TEXT    NOT NULL,
    device_ts  INTEGER NOT NULL,   -- device clock, ordering only
    lat        REAL    NOT NULL,
    lon        REAL    NOT NULL,
    spd        REAL,
    hdg        REAL,
    fix        INTEGER,
    sats       INTEGER,
    pdop       REAL
  );
`);
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_telemetry_session_ts ON telemetry(session_id, server_ts);',
);
// The retention sweep deletes by server_ts alone; the composite index above can't
// serve that range (session_id leads), so give it a dedicated index to avoid a
// full-table scan every sweep.
db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_server_ts ON telemetry(server_ts);');
// Erasure deletes by player (optionally within a session). Without this index that DELETE is a full
// table SCAN holding the write lock — with secure_delete zeroing every freed page — for tens of seconds
// during a match (audit §4.5). (player_id, session_id) serves both the all-sessions and the one-session
// form, and the rowid-subquery batching below keeps each statement short.
db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_player ON telemetry(player_id, session_id);');
// Phase 4 (audit F-1): the firmware's crash-safe backlog replay re-sends up to one checkpoint window of
// records after a reboot; dedupe them here. `seq` is the device's monotonic sequence (nullable — pre-Phase-4
// firmware sends none, and NULLs are exempt from the unique index). ALTER-if-missing keeps existing stores
// working without a migration framework (that's Phase 6).
//
// The key is (player_id, DEVICE_ID, seq), not (player_id, seq): the crash re-send this exists to catch always
// comes from the SAME device, while a replacement tracker enrolled for the same player starts its sequence
// fresh — with a player-scoped key its real fixes would collide with the dead device's retained rows and be
// silently swallowed for up to the retention window (checker finding). device_id embeds the MAC tail, so a
// replacement never collides; a full-NVS-erase of the SAME device is covered by the firmware's random seq base.
{
  const cols = db.query("PRAGMA table_info(telemetry)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'seq')) db.exec('ALTER TABLE telemetry ADD COLUMN seq INTEGER;');
}
db.exec('DROP INDEX IF EXISTS idx_telemetry_dedupe;'); // v1 (player-scoped) — superseded; no-op once gone
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_dedupe2 ON telemetry(player_id, device_id, seq) WHERE seq IS NOT NULL;');

// OR IGNORE: a conflict on the (player_id, seq) dedupe index is a replay re-send, not an error — the caller
// reads `changes` to tell "inserted" from "duplicate" (and only fans out the former).
const insert = db.query(`
  INSERT OR IGNORE INTO telemetry
    (server_ts, session_id, player_id, device_id, device_ts,
     lat, lon, spd, hdg, fix, sats, pdop, seq)
  VALUES
    ($serverTs, $sessionId, $playerId, $deviceId, $deviceTs,
     $lat, $lon, $spd, $hdg, $fix, $sats, $pdop, $seq)
`);

// /health's `db` signal (checker finding: `SELECT 1` runs entirely in SQLite's VM and cannot fail with the
// table dropped or the disk full — a probe that cannot fail proves nothing). Two inputs instead: the last
// insert outcome (a store that cannot persist is not healthy, whatever a read probe says) and a read that
// actually touches the telemetry table.
let lastInsertOkTs = 0;
let lastInsertErrorTs = 0;
const INSERT_ERROR_HOLD_MS = 60_000;

/** True = row persisted; false = a (player_id, device_id, seq) DUPLICATE was ignored (crash-mid-flush re-send). */
export function insertTelemetry(t: Telemetry): boolean {
  try {
    const inserted = insertRow(t);
    lastInsertOkTs = Date.now();
    return inserted;
  } catch (err) {
    lastInsertErrorTs = Date.now();
    throw err;
  }
}

function insertRow(t: Telemetry): boolean {
  return insert.run({
    $serverTs: t.serverTs,
    $sessionId: t.sessionId,
    $playerId: t.playerId,
    $deviceId: t.id,
    $deviceTs: t.ts,
    $lat: t.lat,
    $lon: t.lon,
    $spd: t.spd,
    $hdg: t.hdg,
    $fix: t.fix,
    $sats: t.sats,
    $pdop: t.pdop,
    $seq: t.sq ?? null,
  }).changes === 1;
}

// --- retention & erasure (ADR-0010): raw fixes are children's location, so the
// store is deliberately bounded in time and erasable per player. ---------------

// Bounded DELETE (capped by $limit via a rowid subquery — works without the
// SQLITE_ENABLE_UPDATE_DELETE_LIMIT build option) so a huge backlog can be purged in
// chunks that yield the event loop instead of one multi-second blocking statement.
const deleteOlderThanBatch = db.query(
  'DELETE FROM telemetry WHERE rowid IN (SELECT rowid FROM telemetry WHERE server_ts < $cutoff LIMIT $limit)',
);
const minServerTs = db.query('SELECT MIN(server_ts) AS m FROM telemetry');
// Same bounded-DELETE shape as the retention sweep, keyed on idx_telemetry_player.
const deletePlayerAllBatch = db.query(
  'DELETE FROM telemetry WHERE rowid IN (SELECT rowid FROM telemetry WHERE player_id = $player LIMIT $limit)',
);
const deletePlayerSessionBatch = db.query(
  'DELETE FROM telemetry WHERE rowid IN (SELECT rowid FROM telemetry WHERE player_id = $player AND session_id = $session LIMIT $limit)',
);
// One indexed seek per roster session (idx_telemetry_session_ts leads on session_id). NOT `SELECT
// DISTINCT session_id` — that plans as a full covering-index SCAN, linear in ROWS, and the sweep runs on the
// live event loop (the checker measured ~170 ms+ at a 30-day store, hourly).
const sessionProbe = db.query('SELECT 1 FROM telemetry WHERE session_id = $session LIMIT 1');
const walCheckpointTruncate = db.query('PRAGMA wal_checkpoint(TRUNCATE)');
const walCheckpointPassive = db.query('PRAGMA wal_checkpoint(PASSIVE)');

/** Rows per erasure DELETE batch — bounds how long one statement holds the write lock. */
export const PURGE_BATCH_DEFAULT = envInt('PURGE_BATCH', 5_000, { min: 1 });

/**
 * Delete up to `limit` raw fixes stamped before `cutoffMs` (server_ts). Returns rows
 * removed; the caller loops until it returns < limit. Capped so the synchronous
 * bun:sqlite call can't stall live ingest/fan-out on a large backlog.
 */
export function purgeOlderThan(cutoffMs: number, limit: number): number {
  return deleteOlderThanBatch.run({ $cutoff: cutoffMs, $limit: limit }).changes;
}

/** server_ts of the oldest stored fix, or null when the table is empty. */
export function oldestServerTs(): number | null {
  const row = minServerTs.get() as { m: number | null } | null;
  return row?.m ?? null;
}

/**
 * ONE bounded erasure batch: delete up to `limit` of a player's raw fixes (optionally within one
 * session). Returns rows removed. Exposed so the loop below is testable at the batch boundary.
 */
export function purgePlayerBatch(playerId: string, sessionId: string | undefined, limit: number): number {
  return sessionId
    ? deletePlayerSessionBatch.run({ $player: playerId, $session: sessionId, $limit: limit }).changes
    : deletePlayerAllBatch.run({ $player: playerId, $limit: limit }).changes;
}

/**
 * Right-to-erasure / lost-device wipe: delete ALL of a player's raw fixes, scoped to one session when
 * `sessionId` is given, otherwise every session. Runs in bounded batches with a short pause between
 * them so a concurrent writer (the live server, via busy_timeout) can take the lock in between instead
 * of stalling for the whole wipe. Returns total rows removed.
 */
export async function purgePlayer(
  playerId: string,
  sessionId?: string,
  opts: { batch?: number } = {},
): Promise<number> {
  const limit = opts.batch ?? PURGE_BATCH_DEFAULT;
  let removed = 0;
  let n: number;
  do {
    n = purgePlayerBatch(playerId, sessionId, limit);
    removed += n;
    if (n === limit) await Bun.sleep(2); // let the server's pending insert through between batches
  } while (n === limit);
  return removed;
}

export interface CheckpointResult { busy: number; log: number; checkpointed: number }

/**
 * Force a TRUNCATE checkpoint: copy every WAL frame into the main file and shrink the WAL to zero
 * bytes, so the rebuilt page images REPLACE the old ones on disk instead of sitting beside them in the
 * sidecar. Returns SQLite's triple: `busy` 1 means a reader held the WAL and the truncate did NOT
 * complete — the caller must treat that as "residue remains".
 *
 * CAUTION: a TRUNCATE checkpoint takes the WRITE lock and then busy-waits for readers to drain. With
 * this connection's default busy_timeout (5 s) that is 5 s of frozen ingest per attempt — call
 * setBusyTimeout(<small>) first and keep the attempts short; do the bulk copy with checkpointPassive().
 */
export function checkpointTruncate(): CheckpointResult {
  return walCheckpointTruncate.get() as CheckpointResult;
}

/** A PASSIVE checkpoint copies whatever frames it can WITHOUT taking the write lock or waiting on readers. */
export function checkpointPassive(): CheckpointResult {
  return walCheckpointPassive.get() as CheckpointResult;
}

/** Change how long THIS connection's statements wait on a lock before failing with SQLITE_BUSY. */
export function setBusyTimeout(ms: number): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))};`);
}

/**
 * Rebuild every page of the store. Needed for byte-level erasure: secure_delete zeroes pages that are
 * FREED, but a leaf page that keeps a survivor's rows is rebalanced in place and the erased rows' bytes
 * stay in its unused gap (the checker found ~0.2-0.5% of an erased player's rows recoverable that way,
 * in the everyday round-robin ingest layout). VACUUM rewrites those pages clean. It holds the write
 * lock for the duration — proportional to store size — so erasures belong between sessions, not mid-match.
 * Returns wall time in ms.
 */
export function vacuum(): number {
  const t0 = performance.now();
  db.exec('VACUUM');
  return Math.round(performance.now() - t0);
}

/**
 * Is the store usable? True when (a) a read that touches the telemetry table succeeds AND (b) the most
 * recent insert outcome is not a failure (a failure "holds" for INSERT_ERROR_HOLD_MS unless a later insert
 * succeeded). Honest limits: with no traffic and an intact file this stays true; it exists to catch a
 * dropped/corrupt table, a closed handle, and a store that is failing every write (full disk, unlinked file).
 */
export function dbProbe(): boolean {
  try {
    db.query('SELECT 1 FROM telemetry LIMIT 1').get(); // null on an empty table is fine — not throwing is the signal
  } catch {
    return false;
  }
  const now = Date.now();
  if (lastInsertErrorTs > lastInsertOkTs && now - lastInsertErrorTs < INSERT_ERROR_HOLD_MS) return false;
  return true;
}

/** Does this session still have at least one stored fix? One indexed seek. */
export function sessionHasTelemetry(sessionId: string): boolean {
  return sessionProbe.get({ $session: sessionId }) !== null;
}

// --- review/replay read path (ADR-0017): paged, keyset, OFF the live loop -------
// One row of the raw trace, exactly the columns the history endpoint may expose. The
// SELECT below names these explicitly — it NEVER does `SELECT *`, so a future schema
// column can't accidentally start flowing out of the bulk-export surface, and there is
// no `device_id`/`device_ts` (internal) nor any name (names never enter this DB).
// `pdop` IS read (Phase 4, contract §4.1): the analytics distance gate needs it (drop a
// step when pdop > 5). It is NOT exposed on the raw-replay surface — readRaw never copies
// it into a RawFix — only the in-process aggregate fold reads it. `fix` is deliberately
// NOT read: ingest drops fix<2 before persisting, so every STORED row already satisfies
// fix ≥ 2 (the fix≥2 half of the §1 gate is therefore always true for a stored row).
export interface FixRow {
  serverTs: number;
  rowid: number;
  playerId: string;
  lat: number;
  lon: number;
  spd: number | null;
  hdg: number | null;
  pdop: number | null;
}

// Composite keyset page over idx_telemetry_session_ts: a half-open [fromTs, toTs) window,
// resumed UNAMBIGUOUSLY by (server_ts, rowid). A scalar server_ts cursor would dup/skip the
// rows that share a Date.now() ms (50 players × 10 Hz collide constantly), so the cursor is
// the composite (afterTs, afterRowid) and the tuple comparison is spelled out by hand —
// bun:sqlite has no row-value `(a,b) > (?,?)` — as `ts > ? OR (ts = ? AND rowid > ?)`.
// `ORDER BY server_ts, rowid` matches the index lead column so paging stays index-only.
const fixesPage = db.query(
  `SELECT server_ts AS serverTs, rowid, player_id AS playerId, lat, lon, spd, hdg, pdop
     FROM telemetry
    WHERE session_id = $session
      AND server_ts >= $fromTs
      AND server_ts <  $toTs
      AND (server_ts > $afterTs OR (server_ts = $afterTs AND rowid > $afterRowid))
    ORDER BY server_ts, rowid
    LIMIT $limit`,
);

/**
 * Read ONE keyset page of raw fixes for a session in [fromTs, toTs), resuming after the
 * composite cursor (afterTs, afterRowid) — pass (fromTs-1, 0) for the first page so no real
 * row is skipped. Caller (history.ts) loops, accumulating + yielding the loop between pages
 * like retention.purgeOlderThan, so a long match never materialises with `.all()`.
 *
 * Reads use the SAME `db` handle as the writer ON PURPOSE: this is one process, WAL mode is
 * already on (db.ts top), and WAL lets a connection read a consistent snapshot concurrently
 * with its own writes — so no separate read-only `Database` handle is needed (ADR-0017).
 */
export function readFixesPage(
  sessionId: string,
  fromTs: number,
  toTs: number,
  afterTs: number,
  afterRowid: number,
  limit: number,
): FixRow[] {
  return fixesPage.all({
    $session: sessionId,
    $fromTs: fromTs,
    $toTs: toTs,
    $afterTs: afterTs,
    $afterRowid: afterRowid,
    $limit: limit,
  }) as FixRow[];
}

export { db };
