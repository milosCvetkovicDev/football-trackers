/**
 * The erasure DELETE, defined ONCE, usable against any open telemetry store.
 *
 * WHY IT MOVED HERE. Phase 6 makes `VACUUM INTO` backups a first-class thing, and a backup is a
 * complete copy of children's location data. The audit's acceptance criterion for the phase is
 * literally "purged player absent from EVERY backup", so purge-player.ts now has to run the same
 * erasure against N files instead of one. The wrong way to do that is a second copy of the SQL in
 * backup.ts — an erasure path that exists twice is an erasure path that will one day be fixed once.
 *
 * So: the statements and the batching loop take a `Database` handle. db.ts binds them to the live
 * store; backup.ts binds them to each backup file. Same bounded-DELETE shape, same rowid-subquery
 * trick (works without the SQLITE_ENABLE_UPDATE_DELETE_LIMIT build option), same pause between
 * batches so a concurrent writer can take the lock.
 *
 * NOTE the caller's responsibility: `secure_delete` and the VACUUM that follows are properties of the
 * CONNECTION and the FILE, not of these statements. Every opener of a store that holds real fixes must
 * set `PRAGMA secure_delete = ON` before deleting (openTelemetryStore below does it for you) and
 * VACUUM afterwards — audit §4.5(a) is exactly the bug where that was assumed rather than done.
 */

import { Database } from 'bun:sqlite';

const DELETE_PLAYER_ALL =
  'DELETE FROM telemetry WHERE rowid IN (SELECT rowid FROM telemetry WHERE player_id = $player LIMIT $limit)';
const DELETE_PLAYER_SESSION =
  'DELETE FROM telemetry WHERE rowid IN (SELECT rowid FROM telemetry WHERE player_id = $player AND session_id = $session LIMIT $limit)';

/** ONE bounded erasure batch against `db`. Returns rows removed; the caller loops until it is < limit. */
export function purgePlayerBatchOn(
  db: Database,
  playerId: string,
  sessionId: string | undefined,
  limit: number,
): number {
  return sessionId
    ? db.query(DELETE_PLAYER_SESSION).run({ $player: playerId, $session: sessionId, $limit: limit }).changes
    : db.query(DELETE_PLAYER_ALL).run({ $player: playerId, $limit: limit }).changes;
}

/**
 * Delete ALL of a player's fixes from `db`, in bounded batches with a short pause between them so a
 * concurrent writer (the live server, via busy_timeout) can take the lock in between instead of
 * stalling for the whole wipe. Returns total rows removed.
 */
export async function purgePlayerOn(
  db: Database,
  playerId: string,
  sessionId: string | undefined,
  limit: number,
): Promise<number> {
  let removed = 0;
  let n: number;
  do {
    n = purgePlayerBatchOn(db, playerId, sessionId, limit);
    removed += n;
    if (n === limit) await Bun.sleep(2);
  } while (n === limit);
  return removed;
}

/**
 * Open an EXISTING telemetry store (a backup, typically) with the pragmas an erasure needs.
 *
 * `create: false` on purpose: bun:sqlite would otherwise happily CREATE the file at a mistyped path
 * and report "erased 0" as a success — the exact shape of audit §4.5(e), which is the reason the
 * purge CLI validates its path before opening anything.
 */
export function openTelemetryStore(path: string, readonly = false): Database {
  // bun:sqlite needs an EXPLICIT readonly/readwrite flag: `{ create: false }` on its own throws
  // "flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE" (verified). So the two cases are
  // spelled out rather than passed as one object with a boolean in it.
  const db = readonly ? new Database(path, { readonly: true }) : new Database(path, { create: false, readwrite: true });
  if (!readonly) {
    db.exec('PRAGMA secure_delete = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
  }
  return db;
}

/** Row count of a store's telemetry table — the backup verification signal. */
export function countRows(db: Database): number {
  const row = db.query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number } | null;
  return row?.n ?? 0;
}

/** How many rows a given player still has in this store. Zero is what an erasure receipt has to prove. */
export function countPlayerRows(db: Database, playerId: string, sessionId?: string): number {
  const row = (
    sessionId
      ? db.query('SELECT COUNT(*) AS n FROM telemetry WHERE player_id = $player AND session_id = $session').get({
          $player: playerId,
          $session: sessionId,
        })
      : db.query('SELECT COUNT(*) AS n FROM telemetry WHERE player_id = $player').get({ $player: playerId })
  ) as { n: number } | null;
  return row?.n ?? 0;
}
