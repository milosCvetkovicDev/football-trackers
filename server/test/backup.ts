/**
 * Backup unit/integration test — `VACUUM INTO` copies, erasure-aware rotation, and the two Phase 6
 * acceptance criteria that live on this surface:
 *
 *   "backup restores to a byte-identical row count"   → cases 1 + 2
 *   "purged player absent from every backup"          → case 7 (and case 8 proves it can FAIL)
 *
 * No broker, no server: a temp store is seeded directly, then driven through src/backup.ts. Only
 * pseudonymous player ids and match-session ids appear here — never a child's name.
 *
 *   bun run test/backup.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp dir.
 */

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), 'ft-backup-'));
const DB = join(dir, 'telemetry.db');
const BACKUPS = join(dir, 'backups');

// backup.ts reads BACKUP_DIR / BACKUP_KEEP / RETENTION_DAYS at import, so set them BEFORE importing.
process.env.DB_PATH = DB;
process.env.BACKUP_DIR = BACKUPS;
process.env.BACKUP_KEEP = '3';
process.env.RETENTION_DAYS = '30';

const PLAYERS = ['07', '09', '11'];
const SESSION = 'morning-5s';
const OTHER_SESSION = 'evening-5s';
const ROWS_PER_PLAYER = 400;

/** Seed a store the way real ingest does — players INTERLEAVED, not one contiguous block per player. */
function seed(path: string): number {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
    server_ts INTEGER NOT NULL, session_id TEXT NOT NULL, player_id TEXT NOT NULL, device_id TEXT NOT NULL,
    device_ts INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, spd REAL, hdg REAL, fix INTEGER,
    sats INTEGER, pdop REAL, seq INTEGER);`);
  const ins = db.query(
    `INSERT INTO telemetry (server_ts, session_id, player_id, device_id, device_ts, lat, lon, spd, hdg, fix, sats, pdop, seq)
     VALUES ($ts, $s, $p, $d, $ts, 44.81, 20.46, 3, 90, 3, 11, 1.0, NULL)`,
  );
  const base = Date.now() - 3_600_000;
  db.transaction(() => {
    for (let i = 0; i < ROWS_PER_PLAYER; i++) {
      for (const p of PLAYERS) {
        ins.run({ $ts: base + i * 100, $s: i % 5 === 0 ? OTHER_SESSION : SESSION, $p: p, $d: `trk-${p}` });
      }
    }
  })();
  const n = (db.query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number }).n;
  db.close(false);
  return n;
}

const totalRows = seed(DB);

const { createBackup, listBackups, rotateBackups, purgePlayerFromBackups, backupTakenAt, BackupError } =
  await import('../src/backup');
const { countPlayerRows, countRows } = await import('../src/erase');

let passed = 0;
const ok = (msg: string) => { passed++; console.log(`  ok: ${msg}`); };

/** Open a backup read-only and answer a question about it — i.e. what "restoring" it would give you. */
function inBackup<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close(false);
  }
}

try {
  // --- 1. ACCEPTANCE: a backup holds exactly the rows the source held ---------------------------------
  {
    const r = createBackup(DB, BACKUPS, Date.now());
    assert(existsSync(r.path), 'the backup file must exist');
    assert(r.verified, 'createBackup must report verified');
    assert(r.sourceRows === totalRows, `source count ${r.sourceRows} should be the seeded ${totalRows}`);
    assert(r.backupRows === totalRows, `backup count ${r.backupRows} must equal the source's ${totalRows}`);
    // Re-read it independently: the receipt could be right and the file still wrong.
    const reread = inBackup(r.path, countRows);
    assert(reread === totalRows, `re-opened backup must hold ${totalRows} rows, got ${reread}`);
    ok(`VACUUM INTO copy holds an identical row count (${totalRows})`);
  }

  // --- 2. and identical PER PLAYER + PER SESSION, not just in total ------------------------------------
  // A copy that is right in aggregate and wrong per key would still pass a naive count check.
  {
    const [b] = listBackups(BACKUPS);
    const src = new Database(DB, { readonly: true });
    try {
      for (const p of PLAYERS) {
        for (const s of [SESSION, OTHER_SESSION]) {
          const a = countPlayerRows(src, p, s);
          const c = inBackup(b.path, (db) => countPlayerRows(db, p, s));
          assert(a === c && a > 0, `player ${p} in ${s}: source ${a} vs backup ${c}`);
        }
      }
    } finally {
      src.close(false);
    }
    ok('per-player, per-session counts match the source exactly');
  }

  // --- 3. at-rest posture: 0600 file inside a 0700 directory -------------------------------------------
  {
    const [b] = listBackups(BACKUPS);
    const fmode = statSync(b.path).mode & 0o777;
    const dmode = statSync(BACKUPS).mode & 0o777;
    assert(fmode === 0o600, `a backup of children's location must be 0600, got 0${fmode.toString(8)}`);
    assert(dmode === 0o700, `the backup directory must be 0700, got 0${dmode.toString(8)}`);
    // And an ALREADY-EXISTING loose directory must be tightened, not left as it was found (the audit's
    // "mode is a no-op on an existing file" finding applies to the directory too).
    chmodSync(BACKUPS, 0o755);
    createBackup(DB, BACKUPS, Date.now() + 1_000);
    assert((statSync(BACKUPS).mode & 0o777) === 0o700, 'an existing loose backup dir must be re-tightened to 0700');
    ok('backup file 0600, directory 0700 — and a pre-existing 0755 dir is tightened');
  }

  // --- 4. rotation keeps BACKUP_KEEP newest ------------------------------------------------------------
  {
    const now = Date.now();
    for (let i = 2; i < 6; i++) createBackup(DB, BACKUPS, now + i * 1_000); // 6 total now
    assert(listBackups(BACKUPS).length === 6, 'precondition: 6 backups on disk');
    const r = rotateBackups(BACKUPS, { keep: 3, retentionDays: 30, now: now + 10_000 });
    const left = listBackups(BACKUPS);
    assert(left.length === 3, `keep=3 must leave 3, got ${left.length}`);
    assert(r.removed.length === 3, `3 should have been removed, got ${r.removed.length}`);
    // The SURVIVORS must be the newest three, not an arbitrary three.
    assert(left[0].takenAtMs > left[1].takenAtMs && left[1].takenAtMs > left[2].takenAtMs, 'survivors ordered newest-first');
    ok('rotation keeps the newest BACKUP_KEEP and deletes the rest');
  }

  // --- 5. rotation ALSO expires by RETENTION_DAYS, even inside the keep count ---------------------------
  // The compliance half: ADR-0010 bounds how long a fix may exist, and a copy is a fix.
  {
    rmSync(BACKUPS, { recursive: true, force: true });
    const now = Date.parse('2026-06-01T12:00:00Z');
    const old1 = now - 40 * 86_400_000; // 40 days — past a 30-day window
    const old2 = now - 31 * 86_400_000;
    const fresh = now - 2 * 86_400_000;
    for (const t of [old1, old2, fresh]) createBackup(DB, BACKUPS, t);
    assert(listBackups(BACKUPS).length === 3, 'precondition: 3 backups');
    const r = rotateBackups(BACKUPS, { keep: 10, retentionDays: 30, now }); // keep is generous ON PURPOSE
    const left = listBackups(BACKUPS);
    assert(left.length === 1, `only the fresh backup may survive a 30-day window, got ${left.length}`);
    assert(left[0].takenAtMs === fresh, 'the survivor must be the fresh one');
    assert(r.expired.length === 2, `both aged copies must be reported as expired-by-retention, got ${r.expired.length}`);
    ok('rotation expires copies older than RETENTION_DAYS even when the keep count would hold them');
  }

  // --- 6. rotation NEVER deletes a file it did not create ------------------------------------------------
  {
    const foreign = join(BACKUPS, 'telemetry-before-the-cup-final.db');
    writeFileSync(foreign, 'not ours');
    const alsoForeign = join(BACKUPS, 'notes.txt');
    writeFileSync(alsoForeign, 'operator notes');
    rotateBackups(BACKUPS, { keep: 0, retentionDays: 1, now: Date.now() }); // maximally aggressive
    assert(existsSync(foreign), "an operator's own copy must never be rotated away");
    assert(existsSync(alsoForeign), 'a non-backup file in the directory must be left alone');
    assert(listBackups(BACKUPS).every((b) => backupTakenAt(b.path) !== null), 'listBackups must only ever return our own files');
    rmSync(foreign); rmSync(alsoForeign);
    ok('rotation only ever removes files matching the name pattern it writes');
  }

  // --- 7. ACCEPTANCE: a purged player is absent from EVERY backup ----------------------------------------
  {
    rmSync(BACKUPS, { recursive: true, force: true });
    const now = Date.now();
    for (let i = 0; i < 3; i++) createBackup(DB, BACKUPS, now + i * 1_000);
    const before = listBackups(BACKUPS).map((b) => inBackup(b.path, (db) => countPlayerRows(db, '07')));
    assert(before.every((n) => n > 0), `precondition: player 07 present in all 3 backups (${before.join(',')})`);

    const results = await purgePlayerFromBackups('07', undefined, { dir: BACKUPS });
    assert(results.length === 3, `all 3 backups must be processed, got ${results.length}`);
    assert(results.every((r) => r.ok), `every backup must report ok, got ${JSON.stringify(results.map((r) => r.error))}`);
    for (const r of results) {
      // Re-open independently: the returned `remaining` is the module's own claim.
      const left = inBackup(r.path, (db) => countPlayerRows(db, '07'));
      assert(left === 0, `player 07 must be GONE from ${r.path}, ${left} rows remain`);
      const others = inBackup(r.path, (db) => countPlayerRows(db, '09'));
      assert(others > 0, 'the other players must survive — erasure is per player, not per file');
    }
    ok('purgePlayerFromBackups erases the player from every backup and leaves the others intact');
  }

  // --- 8. a backup that CANNOT be erased is reported as a failure, not skipped ---------------------------
  // This is the case that makes case 7 non-vacuous: if an unwritable file were silently ignored, the CLI
  // would report a complete erasure over a copy that still holds the child's positions.
  {
    const [target] = listBackups(BACKUPS);
    chmodSync(target.path, 0o400); // read-only file
    const results = await purgePlayerFromBackups('09', undefined, { dir: BACKUPS });
    const failed = results.filter((r) => !r.ok);
    chmodSync(target.path, 0o600); // restore so cleanup and later cases work
    assert(failed.length === 1, `the read-only backup must be reported as a failure, got ${failed.length}`);
    assert(failed[0].path === target.path, 'the reported failure must name the offending file');
    assert(typeof failed[0].error === 'string' && failed[0].error.length > 0, 'a failure must carry a reason');
    ok('an unerasable backup is reported ok:false with a reason (never silently skipped)');
  }

  // --- 9. createBackup refuses a source that is not a telemetry store -------------------------------------
  // bun:sqlite would otherwise CREATE the file at a mistyped path and hand back an empty "backup".
  {
    const missing = join(dir, 'nope.db');
    let threw = false;
    try { createBackup(missing, BACKUPS, Date.now()); } catch (e) { threw = e instanceof BackupError; }
    assert(threw, 'a missing DB_PATH must throw BackupError, not create one');
    assert(!existsSync(missing), 'a missing source must NOT be created by the backup attempt');

    const empty = join(dir, 'empty.db');
    writeFileSync(empty, '');
    threw = false;
    try { createBackup(empty, BACKUPS, Date.now()); } catch (e) { threw = e instanceof BackupError; }
    assert(threw, 'a 0-byte source must throw BackupError');
    ok('a missing / empty / non-SQLite source is refused (never silently "backed up")');
  }

  // --- 10. two backups in the same second do not collide silently ------------------------------------------
  {
    // A timestamp no earlier case used, so the collision under test is the SECOND call, not the first.
    const t = Date.parse('2026-07-04T09-30-00Z'.replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z'));
    const first = createBackup(DB, BACKUPS, t);
    let threw = false;
    try { createBackup(DB, BACKUPS, t); } catch (e) { threw = e instanceof BackupError; }
    assert(threw, 'a same-second second backup must fail loudly, not overwrite the first');
    assert(existsSync(first.path), 'the first backup must survive the collision');
    ok('a name collision fails loudly instead of overwriting an existing backup');
  }

  // --- 11. an unreadable BACKUP_DIR THROWS — it must never look like "there are no backups" ------------
  // `listBackups` returning [] on an error is the shape that lets an erasure report success over copies
  // it never opened. It also used to escape as a raw EACCES stack trace, outside the CLI's exit contract.
  {
    const locked = join(dir, 'locked-backups');
    mkdirSync(locked, { recursive: true });
    createBackup(DB, locked, Date.now());
    chmodSync(locked, 0o000);
    let threw = false;
    try { listBackups(locked); } catch (e) { threw = e instanceof BackupError; }
    chmodSync(locked, 0o700);
    assert(threw, 'an unreadable backup directory must throw BackupError, not silently return []');
    // A directory that does not EXIST is still legitimately empty — that distinction is the whole point.
    assert(listBackups(join(dir, 'never-created')).length === 0, 'a missing directory is an empty list, not an error');
    ok('an unreadable backup directory throws; a missing one is simply empty');
  }

  // --- 12. a FUTURE-dated copy can never age out, so it is expired on sight ------------------------------
  // A Pi has no RTC. A copy written while the clock was ahead has `now - takenAt` permanently negative,
  // so RETENTION_DAYS could never reach it — a complete copy of children's location that no retention
  // rule can ever expire. There are BACKUP_KEEP others; this one goes, loudly.
  {
    rmSync(BACKUPS, { recursive: true, force: true });
    const now = Date.now();
    createBackup(DB, BACKUPS, now - 1000);                 // normal
    createBackup(DB, BACKUPS, now + 10 * 86_400_000);      // clock was 10 days ahead
    assert(listBackups(BACKUPS).length === 2, 'precondition: 2 copies');
    const r = rotateBackups(BACKUPS, { keep: 10, retentionDays: 30, now });
    const left = listBackups(BACKUPS);
    assert(left.length === 1, `the future-dated copy must be removed, ${left.length} left`);
    assert(left[0].takenAtMs < now, 'the survivor must be the normally-dated one');
    assert(r.expired.length === 1, 'it must be reported as expired, not merely as surplus');
    ok('a future-dated backup is expired rather than left immortal');
  }

  // --- 13. a name that does not ROUND-TRIP is not one of ours -------------------------------------------
  // `Date.parse('2026-02-30T00:00:00Z')` silently rolls forward to 2 March, so a name we could never have
  // written would have been treated as ours AND mis-dated.
  {
    assert(backupTakenAt('telemetry-2026-02-30T00-00-00Z.db') === null, 'an impossible date must not parse as ours');
    assert(backupTakenAt('telemetry-2026-13-01T00-00-00Z.db') === null, 'month 13 must not parse as ours');
    assert(backupTakenAt('telemetry-2026-08-27T11-42-05Z.db') !== null, 'a real stamp must still parse');
    const rt = backupTakenAt('telemetry-2026-08-27T11-42-05Z.db')!;
    assert(new Date(rt).toISOString() === '2026-08-27T11:42:05.000Z', 'and parse to the right instant');
    ok('a backup name that does not round-trip is not treated as ours');
  }

  console.log(`\n✅ BACKUP PASSED — ${passed} cases: VACUUM INTO copies verify row-for-row (total and per player/session),`
    + ' 0600/0700 at rest, rotation bounded by BOTH count and RETENTION_DAYS, foreign files never touched,'
    + ' a purged player is absent from every backup, and an unerasable copy is a loud failure');
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ BACKUP FAILED:', (err as Error).message);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
}
