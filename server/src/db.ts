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

const DB_PATH = process.env.DB_PATH ?? 'telemetry.db';

const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
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

const insert = db.query(`
  INSERT INTO telemetry
    (server_ts, session_id, player_id, device_id, device_ts,
     lat, lon, spd, hdg, fix, sats, pdop)
  VALUES
    ($serverTs, $sessionId, $playerId, $deviceId, $deviceTs,
     $lat, $lon, $spd, $hdg, $fix, $sats, $pdop)
`);

export function insertTelemetry(t: Telemetry): void {
  insert.run({
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
  });
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
const deletePlayerAll = db.query('DELETE FROM telemetry WHERE player_id = $player');
const deletePlayerSession = db.query(
  'DELETE FROM telemetry WHERE player_id = $player AND session_id = $session',
);

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
 * Right-to-erasure / lost-device wipe: delete a player's raw fixes. Scoped to one
 * session when `sessionId` is given, otherwise every session. Returns rows removed.
 */
export function purgePlayer(playerId: string, sessionId?: string): number {
  return sessionId
    ? deletePlayerSession.run({ $player: playerId, $session: sessionId }).changes
    : deletePlayerAll.run({ $player: playerId }).changes;
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
