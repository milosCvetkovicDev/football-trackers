/**
 * Schema-migration unit test (audit §8 Phase 6) — the `PRAGMA user_version` ladder in src/migrate.ts.
 *
 * The properties that matter operationally, in the order they bite:
 *   1. an EMPTY file becomes a complete store, stamped with the version;
 *   2. a LEGACY store (all the objects present, user_version still 0 — every field box today) migrates
 *      in place, keeps every row, and ends up stamped. This is the case that would break a live box;
 *   3. it is idempotent — a second boot changes nothing;
 *   4. a store from the FUTURE refuses to run. A build older than its store must not write through a
 *      schema it does not understand: a column it never learned about silently stops being populated,
 *      and on a store of children's location nobody notices for weeks.
 *
 * The last one is also asserted END TO END below (case 6): the server process must EXIT, not warn.
 *
 *   bun run test/migrate.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp dir.
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForeignStoreError, MIGRATIONS, SCHEMA_VERSION, SchemaTooNewError, migrate, schemaVersion } from '../src/migrate';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), 'ft-migrate-'));
let n = 0;
const freshPath = () => join(dir, `store-${n++}.db`);

let passed = 0;
const ok = (msg: string) => { passed++; console.log(`  ok: ${msg}`); };

const objects_ = (db: Database): Set<string> =>
  new Set((db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name));

/** Exactly the pre-Phase-6 boot sequence: IF NOT EXISTS everything, and never touch user_version. */
function seedLegacyStore(path: string, rows: number): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
    server_ts INTEGER NOT NULL, session_id TEXT NOT NULL, player_id TEXT NOT NULL, device_id TEXT NOT NULL,
    device_ts INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, spd REAL, hdg REAL, fix INTEGER,
    sats INTEGER, pdop REAL, seq INTEGER);`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_session_ts ON telemetry(session_id, server_ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_server_ts ON telemetry(server_ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_player ON telemetry(player_id, session_id);');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_dedupe2 ON telemetry(player_id, device_id, seq) WHERE seq IS NOT NULL;');
  const ins = db.query(
    `INSERT INTO telemetry (server_ts, session_id, player_id, device_id, device_ts, lat, lon, spd, hdg, fix, sats, pdop, seq)
     VALUES ($t, 's1', '07', 'trk-07', $t, 44.81, 20.46, 3, 90, 3, 11, 1.0, NULL)`,
  );
  const base = Date.now();
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run({ $t: base + i }); })();
  return db;
}

try {
  // --- 1. an EMPTY file becomes a complete, stamped store ---------------------------------------------
  {
    const db = new Database(freshPath(), { create: true });
    assert(schemaVersion(db) === 0, 'a brand-new file must start at user_version 0');
    const to = migrate(db);
    assert(to === SCHEMA_VERSION, `migrate must return ${SCHEMA_VERSION}, got ${to}`);
    assert(schemaVersion(db) === SCHEMA_VERSION, 'the store must be stamped with the version it reached');
    const names = objects_(db);
    for (const want of ['telemetry', 'idx_telemetry_session_ts', 'idx_telemetry_server_ts', 'idx_telemetry_player', 'idx_telemetry_dedupe2']) {
      assert(names.has(want), `migration must create ${want}`);
    }
    // The dedupe index must actually dedupe — an index that exists but is not UNIQUE would pass a name check.
    const seed = { $t: Date.now() };
    const ins = db.query(`INSERT OR IGNORE INTO telemetry (server_ts, session_id, player_id, device_id, device_ts, lat, lon, seq)
                          VALUES ($t, 's1', '07', 'trk-07', $t, 44.81, 20.46, 42)`);
    assert(ins.run(seed).changes === 1, 'first row with seq=42 should insert');
    assert(ins.run(seed).changes === 0, 'a duplicate (player, device, seq) must be IGNORED — the unique index is load-bearing');
    db.close(false);
    ok(`an empty file migrates to a complete store at user_version ${SCHEMA_VERSION}`);
  }

  // --- 2. a LEGACY store (objects present, user_version 0) migrates in place, losing nothing -----------
  // This is every store in the field today. If migration 1 were not idempotent, this is where it would
  // throw ("index already exists") and take the server down on the upgrade.
  {
    const path = freshPath();
    const db = seedLegacyStore(path, 500);
    const before = (db.query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number }).n;
    assert(schemaVersion(db) === 0, 'precondition: a legacy store is at user_version 0');
    const to = migrate(db);
    const after = (db.query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number }).n;
    assert(to === SCHEMA_VERSION, `legacy store must reach ${SCHEMA_VERSION}, got ${to}`);
    assert(after === before && before === 500, `no row may be lost: ${before} -> ${after}`);
    db.close(false);
    ok('a legacy store migrates in place, keeps every row, and gets stamped');
  }

  // --- 3. idempotent: a second boot is a no-op ---------------------------------------------------------
  {
    const path = freshPath();
    const db = new Database(path, { create: true });
    migrate(db);
    const namesA = objects_(db);
    const to = migrate(db); // second boot
    const namesB = objects_(db);
    assert(to === SCHEMA_VERSION, 'a second migrate must still report the current version');
    assert(namesA.size === namesB.size, 'a second migrate must not create or drop objects');
    db.close(false);
    ok('migrate() is idempotent across boots');
  }

  // --- 4. a store from the FUTURE is refused ------------------------------------------------------------
  {
    const path = freshPath();
    const db = new Database(path, { create: true });
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5};`); // as if a newer build had run here
    let caught: unknown;
    try { migrate(db); } catch (e) { caught = e; }
    assert(caught instanceof SchemaTooNewError, `a newer store must throw SchemaTooNewError, got ${caught}`);
    assert((caught as SchemaTooNewError).found === SCHEMA_VERSION + 5, 'the error must report what it found');
    assert(schemaVersion(db) === SCHEMA_VERSION + 5, 'a refused migration must not have changed the version');
    db.close(false);
    ok('a store newer than the build throws SchemaTooNewError and changes nothing');
  }

  // --- 5. the ladder itself is contiguous ---------------------------------------------------------------
  // A hole in the ids would make `id > current` skip a step on some stores and not others.
  {
    MIGRATIONS.forEach((m, i) => assert(m.id === i + 1, `MIGRATIONS[${i}].id must be ${i + 1}, got ${m.id}`));
    assert(SCHEMA_VERSION === MIGRATIONS.length, 'SCHEMA_VERSION must be the ladder length');
    assert(new Set(MIGRATIONS.map((m) => m.name)).size === MIGRATIONS.length, 'migration names must be distinct');
    ok(`the ladder is contiguous 1..${SCHEMA_VERSION} with distinct names`);
  }

  // --- 6. END TO END: the SERVER refuses to start against a future store ---------------------------------
  // The unit test above proves the throw; this proves nobody catches it and carries on serving.
  {
    const path = freshPath();
    const db = new Database(path, { create: true });
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
    db.close(false);

    const proc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        DB_PATH: path,
        PORT: '3391', METRICS_PORT: '9491',
        MQTT_URL: 'mqtt://127.0.0.1:1', // nothing there; boot must die before this matters
        AUTH_ACCOUNTS_FILE: join(dir, 'no-accounts.json'),
        AUTH_ROSTER_FILE: join(dir, 'no-roster.json'),
        LOG_LEVEL: 'error',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const code = await proc.exited;
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    assert(code !== 0, `the server must EXIT on a future schema, got exit ${code}`);
    assert(/schema version/i.test(out), `the failure must name the cause, got: ${out.slice(0, 400)}`);
    // And the listener must never have opened — a process that serves for even a second has already
    // answered requests from a store it does not understand.
    let served = false;
    try { await fetch('http://127.0.0.1:9491/health', { signal: AbortSignal.timeout(300) }); served = true; } catch { /* expected */ }
    assert(!served, 'the server must not have started listening');
    ok('the server process exits non-zero (and never listens) against a store newer than its build');
  }

  // --- 7. THE FROZEN SCHEMA. Migration 1 is append-only-forever: a field store that has stamped v1 will
  //        NEVER re-run it, so drift shipped here cannot be repaired by a later migration on those stores.
  //        The module doc claims migration 1 is "EXACTLY the schema as it stood at the end of Phase 5" and
  //        nothing checked it — a checker pass deleted the `pdop` column from it and all six cases above
  //        still passed. This snapshot is that check: it fails on ANY change to the shape, including ones
  //        no prepared statement would notice (an index on the wrong columns, a lost NOT NULL).
  {
    const db = new Database(freshPath(), { create: true });
    migrate(db);
    const rows = db
      .query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as { type: string; name: string; sql: string | null }[];
    // Whitespace-normalised: the stored CREATE text keeps the source's indentation, which is not schema.
    const actual = rows.map((r) => `${r.type} ${r.name}: ${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`);
    // NB the CREATE text ends `pdop REAL , seq INTEGER)` — `seq` is added by ALTER TABLE in migration 1
    // (it was a Phase-4 addition to an existing table), and SQLite records that by appending to the
    // stored CREATE. That comma-space is not a typo; it is what the file actually holds.
    const EXPECTED = [
      'index idx_telemetry_dedupe2: CREATE UNIQUE INDEX idx_telemetry_dedupe2 ON telemetry(player_id, device_id, seq) WHERE seq IS NOT NULL',
      'index idx_telemetry_player: CREATE INDEX idx_telemetry_player ON telemetry(player_id, session_id)',
      'index idx_telemetry_server_ts: CREATE INDEX idx_telemetry_server_ts ON telemetry(server_ts)',
      'index idx_telemetry_session_ts: CREATE INDEX idx_telemetry_session_ts ON telemetry(session_id, server_ts)',
      'table telemetry: CREATE TABLE telemetry ( server_ts INTEGER NOT NULL, -- authoritative ingest timestamp session_id TEXT NOT NULL, player_id TEXT NOT NULL, device_id TEXT NOT NULL, device_ts INTEGER NOT NULL, -- device clock, ordering only lat REAL NOT NULL, lon REAL NOT NULL, spd REAL, hdg REAL, fix INTEGER, sats INTEGER, pdop REAL , seq INTEGER)',
    ];
    assert(
      JSON.stringify(actual) === JSON.stringify(EXPECTED),
      'migration 1 has DRIFTED from the frozen Phase-5 schema. It is append-only — stores already stamped v1'
        + ' will never re-run it, so this must be a NEW migration, not an edit.\n  actual:   '
        + JSON.stringify(actual, null, 2) + '\n  expected: ' + JSON.stringify(EXPECTED, null, 2),
    );
    // Column order and nullability too — sqlite_master text would catch these, but say so explicitly.
    const cols = db.query('PRAGMA table_info(telemetry)').all() as { name: string; type: string; notnull: number }[];
    const shape = cols.map((c) => `${c.name}:${c.type}:${c.notnull}`).join(',');
    assert(
      shape === 'server_ts:INTEGER:1,session_id:TEXT:1,player_id:TEXT:1,device_id:TEXT:1,device_ts:INTEGER:1,'
        + 'lat:REAL:1,lon:REAL:1,spd:REAL:0,hdg:REAL:0,fix:INTEGER:0,sats:INTEGER:0,pdop:REAL:0,seq:INTEGER:0',
      `telemetry column shape drifted: ${shape}`,
    );
    db.close(false);
    ok('migration 1 matches the frozen Phase-5 schema exactly (shape, indexes, nullability)');
  }

  // --- 8. A SQLite database that is NOT ours is refused, and NOTHING is written to it -------------------
  //        A DB_PATH typo used to get the telemetry schema created inside an unrelated database, its
  //        journal mode converted to WAL, and its `user_version` — the byte other migration tools key on —
  //        overwritten, while this server served an empty pitch behind a green /health.
  {
    const foreign = freshPath();
    {
      const other = new Database(foreign, { create: true });
      other.exec('CREATE TABLE members (id TEXT PRIMARY KEY, note TEXT)');
      other.exec("INSERT INTO members VALUES ('a', 'unrelated app')");
      other.close(false);
    }
    const before = Bun.hash(await Bun.file(foreign).arrayBuffer()).toString();

    const db = new Database(foreign, { create: false, readwrite: true });
    let caught: unknown;
    try { migrate(db); } catch (e) { caught = e; }
    assert(caught instanceof ForeignStoreError, `a foreign database must throw ForeignStoreError, got ${caught}`);
    assert(/members/.test(String(caught)), 'the error must name what it found, so the operator can see it is the wrong path');
    assert(schemaVersion(db) === 0, "a refused store's user_version must be untouched");
    const objects = objects_(db);
    assert(!objects.has('telemetry'), 'no telemetry table may be created in a foreign database');
    assert(objects.has('members'), "the foreign database's own objects must survive");
    db.close(false);
    assert(Bun.hash(await Bun.file(foreign).arrayBuffer()).toString() === before, 'a refused store must be byte-identical afterwards');

    // And an EMPTY file is still fine — that is a new store, not a foreign one.
    const blank = new Database(freshPath(), { create: true });
    assert(migrate(blank) === SCHEMA_VERSION, 'an empty file must still migrate (it is a new store, not a foreign one)');
    blank.close(false);
    ok("a foreign SQLite database is refused byte-for-byte; an empty file still migrates");
  }

  console.log(`\n✅ MIGRATE PASSED — ${passed} cases: empty -> complete store, legacy store migrated in place with no row loss,`
    + ' idempotent, a future schema refused both in-process and end to end, ladder contiguous');
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ MIGRATE FAILED:', (err as Error).message);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
}
