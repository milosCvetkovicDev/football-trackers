/**
 * Schema migrations — an ordered ladder keyed on `PRAGMA user_version` (audit §8 Phase 6).
 *
 * WHAT THIS REPLACES. db.ts used to bring the schema up with a pile of `CREATE TABLE IF NOT EXISTS`,
 * `CREATE INDEX IF NOT EXISTS` and one hand-rolled "ALTER TABLE if the column is missing" probe, run on
 * every boot. That works exactly until the first change that ISN'T expressible as "if not exists" — a
 * column type change, a backfill, a re-derived index — and it can never answer the operator's actual
 * question, which is *what schema is this field box running*. Phase 4 left a comment saying as much
 * ("that's Phase 6"); this is it.
 *
 * THE LADDER IS APPEND-ONLY. Each entry gets the next id and is never edited once it has shipped: a
 * store in the field is already at that version and will not re-run it. Migration 1 is therefore
 * EXACTLY the schema as it stood at the end of Phase 5, written idempotently, because every existing
 * store is at user_version 0 with all of it already present — it has to be a no-op there and a full
 * build on an empty file.
 *
 * A NEWER STORE MAKES THE SERVER REFUSE TO START. If user_version exceeds the ladder, this binary is
 * OLDER than the store it was pointed at — a rollback, or the wrong DB_PATH. Writing through a schema
 * you do not understand is how a column silently stops being populated; on a store of children's
 * location that is a data-integrity failure nobody would notice for weeks. Fail loudly instead.
 */

import type { Database } from 'bun:sqlite';
import { log } from './log';

export interface Migration {
  id: number;
  name: string;
  up: (db: Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'telemetry base, read indexes, seq dedupe',
    up: (db) => {
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
      // The live read (a session's window) and the two paged scans.
      db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_session_ts ON telemetry(session_id, server_ts);');
      // The retention sweep deletes by server_ts alone; the composite above cannot serve that range
      // (session_id leads), so without this every sweep is a full-table scan.
      db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_server_ts ON telemetry(server_ts);');
      // Erasure deletes by player (optionally within a session). Without this that DELETE is a full scan
      // holding the write lock — with secure_delete zeroing every freed page — for tens of seconds
      // mid-match (audit §4.5).
      db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_player ON telemetry(player_id, session_id);');
      // Phase 4 (audit F-1): the firmware's crash-safe backlog replay re-sends up to one checkpoint
      // window after a reboot. `seq` is the device's monotonic sequence — nullable, because pre-Phase-4
      // firmware sends none and NULLs are exempt from the unique index.
      const cols = db.query('PRAGMA table_info(telemetry)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'seq')) db.exec('ALTER TABLE telemetry ADD COLUMN seq INTEGER;');
      // v1 of the dedupe index was player-scoped, which swallowed a REPLACEMENT tracker's real fixes
      // (a new device starts its sequence fresh and collided with the dead device's retained rows).
      // Dropped, superseded by the device-scoped key below; a no-op once it is gone.
      db.exec('DROP INDEX IF EXISTS idx_telemetry_dedupe;');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_dedupe2 ON telemetry(player_id, device_id, seq) WHERE seq IS NOT NULL;',
      );
    },
  },
];

/** The version this build knows how to run against. */
export const SCHEMA_VERSION: number = MIGRATIONS.length;

// Ids must be 1..N with no holes and no repeats. A hole would make `id > current` skip a step forever
// on some stores and not others — the kind of divergence that is only discovered from a corrupt read.
MIGRATIONS.forEach((m, i) => {
  if (m.id !== i + 1) {
    throw new Error(`migrate: MIGRATIONS must be contiguous from 1 — entry ${i} has id ${m.id}, expected ${i + 1}`);
  }
});

/**
 * `DB_PATH` points at a SQLite database that is not ours.
 *
 * `sqliteFileProblem()` (db-path.ts) answers "is this a SQLite file", which is the right question for the
 * erasure CLI and the wrong one here: a checker pass pointed the server at an unrelated database and the
 * boot happily created `telemetry` inside it, converted it to WAL, and — new in Phase 6 — overwrote its
 * `user_version`, which is the byte other migration frameworks key on. The victim app can then take a
 * wrong migration path or refuse to start, while this server serves an empty pitch behind a green
 * `/health`. A typo'd DB_PATH, or a shared `/data` on a field box, is all it takes.
 */
export class ForeignStoreError extends Error {
  constructor(readonly tables: string[]) {
    super(
      `DB_PATH points at a SQLite database that is not a telemetry store — it holds [${tables.join(', ')}] ` +
        'and no `telemetry` table. Refusing to write this schema into someone else\'s database. ' +
        'Check DB_PATH; point it at a new path to create a store.',
    );
    this.name = 'ForeignStoreError';
  }
}

export class SchemaTooNewError extends Error {
  constructor(readonly found: number, readonly known: number) {
    super(
      `telemetry store is at schema version ${found} but this build only knows ${known}. ` +
        'This binary is older than the store (a rollback, or the wrong DB_PATH). Refusing to write ' +
        'through a schema it does not understand.',
    );
    this.name = 'SchemaTooNewError';
  }
}

/**
 * Refuse a store this build must not touch — BEFORE anything writes to it.
 *
 * Call this on a freshly opened handle, before `PRAGMA journal_mode = WAL` and friends: those write the
 * file header, so a boot that is about to declare "I do not understand this store" would already have
 * converted its journal mode. (Reachable in practice: `VACUUM INTO` backups come out in DELETE mode, so
 * "restore a newer backup onto an older binary" lands exactly here.)
 */
export function assertOurs(db: Database): void {
  const found = schemaVersion(db);
  if (found > SCHEMA_VERSION) throw new SchemaTooNewError(found, SCHEMA_VERSION);
  if (found > 0) return; // already stamped by us
  // v0 with tables but no `telemetry` = someone else's database. v0 with NO tables = a new/empty file.
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((r) => r.name);
  if (tables.length > 0 && !tables.includes('telemetry')) throw new ForeignStoreError(tables);
}

/** Current `PRAGMA user_version` of an open store. */
export function schemaVersion(db: Database): number {
  const row = db.query('PRAGMA user_version').get() as { user_version?: number } | null;
  return row?.user_version ?? 0;
}

/**
 * Bring `db` up to SCHEMA_VERSION. Returns the resulting version.
 *
 * Each step runs inside its own transaction together with the version bump, so a crash mid-migration
 * leaves the store at the PREVIOUS version with none of the step applied — never half-migrated with a
 * version that claims otherwise. (SQLite's DDL is transactional, which is the whole reason this is
 * safe to do on a live-ish file.)
 */
export function migrate(db: Database): number {
  assertOurs(db); // too-new, or not ours at all
  const found = schemaVersion(db);
  if (found === SCHEMA_VERSION) return found;

  for (const m of MIGRATIONS) {
    if (m.id <= found) continue;
    const t0 = Date.now();
    try {
      // `.immediate()` = BEGIN IMMEDIATE: take the write lock UP FRONT. A deferred BEGIN starts as a read
      // snapshot (every statement in migration 1 reads first on a legacy store) and only tries to write at
      // the version bump — and if another connection commits in between, that fails as
      // SQLITE_BUSY_SNAPSHOT, which `busy_timeout` does NOT retry. Measured: 16 ms to failure with a 5 s
      // busy timeout, and 45/60 boots failing against a hot writer. With IMMEDIATE the busy handler works.
      //
      // `PRAGMA user_version = N` takes no bound parameter, so the value is interpolated — it is a
      // literal integer from the constant ladder above, never anything that came from outside.
      db.transaction(() => {
        m.up(db);
        db.exec(`PRAGMA user_version = ${m.id};`);
      }).immediate();
    } catch (err) {
      // Say WHICH migration failed. Without this the operator gets a bare bun stack trace, repeated
      // forever by `restart: unless-stopped`, with nothing naming the step or the store.
      log.error('db migration FAILED — the store is unchanged (the step rolled back)', {
        migration: m.id,
        name: m.name,
        from: found,
        ms: Date.now() - t0,
        err: String(err),
      });
      throw err;
    }
    log.info('db migrated', { to: m.id, name: m.name, ms: Date.now() - t0 });
  }
  return schemaVersion(db);
}
