/**
 * Retention & erasure unit test (ADR-0010) — no broker, deterministic clock.
 *
 * Proves the privacy guarantees that bound the children's-location blast-radius:
 *   1. the time-based sweep deletes raw fixes older than RETENTION_DAYS and leaves the rest,
 *      and the observability is honest (purged counter present-at-0, oldest-fix age, last-run);
 *   2. purge-player erasure removes exactly one player's rows, scoped to a session or all,
 *      and secure_delete actually destroys the bytes (not just the row);
 *   3. a sweep that throws is caught and counted, never crashing the server;
 *   4. a malformed RETENTION_DAYS fails SAFE to the 30-day default, never silently off.
 *
 *   bun run test/retention.ts      (or: bun run test:retention)
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

export {}; // module scope so top-level await is allowed

const DB_PATH = '/tmp/ft-retention-test.db';
const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000; // fixed "now" so the sweep is deterministic
const SENTINEL = 'ZZ-ERASE-SENTINEL-ZZ'; // unique marker for the byte-level erasure scan

// Must be set before importing db.ts (opens DB on import) / retention.ts (reads RETENTION_DAYS).
process.env.DB_PATH = DB_PATH;
process.env.RETENTION_DAYS = '30';
process.env.LOG_LEVEL = 'error';

import { existsSync, rmSync, readFileSync } from 'node:fs';
import type { Telemetry } from '../src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (existsSync(f)) rmSync(f);
}

try {
  const { db, insertTelemetry, purgePlayer } = await import('../src/db');
  const { runRetention, refreshRetentionGauges, RETENTION_DAYS } = await import('../src/retention');
  const { registry } = await import('../src/metrics');

  assert(RETENTION_DAYS === 30, `RETENTION_DAYS should be 30, got ${RETENTION_DAYS}`);

  const fix = (over: Partial<Telemetry>): Telemetry => ({
    id: 'trk', pl: '01', ts: 1, lat: 44.8, lon: 20.4, spd: 1, hdg: 0,
    fix: 3, sats: 10, pdop: 1, sessionId: 's1', playerId: '01', serverTs: NOW, ...over,
  });
  const count = (): number =>
    (db.query('SELECT COUNT(*) AS c FROM telemetry').get() as { c: number }).c;
  // Anchor at line start so HELP/TYPE comment lines (and digits inside HELP text) never match.
  const metric = (name: string): number | undefined => {
    const m = registry.render().match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)`, 'm'));
    return m ? Number(m[1]) : undefined;
  };

  // --- 0. observability is present-at-0 before anything expires ----------------------
  assert((await runRetention(NOW)) === 0, 'a sweep on an empty store should remove 0');
  assert(metric('ft_retention_rows_purged_total') === 0,
    'ft_retention_rows_purged_total must be present-at-0 (else "stays 0" alerts cannot bind)');
  assert(metric('ft_retention_last_run_timestamp_seconds') === NOW / 1000,
    'ft_retention_last_run_timestamp_seconds should be stamped by the sweep');

  // --- 1. time-based sweep: drop a 40-day-old fix, keep a 1-day-old one --------------
  insertTelemetry(fix({ serverTs: NOW - 40 * DAY_MS })); // older than the 30d window
  insertTelemetry(fix({ serverTs: NOW - 1 * DAY_MS }));  // inside the window
  assert(count() === 2, `expected 2 rows before sweep, got ${count()}`);

  const removed = await runRetention(NOW);
  assert(removed === 1, `sweep should remove exactly the stale row, removed ${removed}`);
  assert(count() === 1, `expected 1 row after sweep, got ${count()}`);

  // gauges reflect reality: 1 purged, oldest remaining fix is ~1 day old
  assert(metric('ft_retention_rows_purged_total') === 1, 'ft_retention_rows_purged_total should be 1');
  const age = metric('ft_oldest_raw_fix_age_seconds');
  assert(age !== undefined && Math.abs(age - DAY_MS / 1000) < 1,
    `oldest-fix age should be ~${DAY_MS / 1000}s, got ${age}`);

  // a fresh fix is never purged (regression guard on the cutoff direction)
  assert((await runRetention(NOW)) === 0, 'a second sweep with no stale rows should remove 0');

  // --- 2. per-player erasure: scoped to a session, then all sessions -----------------
  insertTelemetry(fix({ playerId: '02', sessionId: 's1', serverTs: NOW - 3600_000 }));
  insertTelemetry(fix({ playerId: '02', sessionId: 's1', serverTs: NOW - 3600_000 }));
  insertTelemetry(fix({ playerId: '02', sessionId: 's2', serverTs: NOW - 3600_000 }));
  assert(count() === 4, `expected 4 rows (1 player01 + 3 player02), got ${count()}`);

  assert(purgePlayer('02', 's1') === 2, 'session-scoped erasure should remove the 2 s1 rows only');
  assert(count() === 2, `expected 2 rows after session-scoped erasure (4 - 2), got ${count()}`);

  assert(purgePlayer('02') === 1, 'all-session erasure should remove the remaining s2 row');
  assert(count() === 1, `expected 1 row after full erasure of player 02 (only player01 left), got ${count()}`);

  assert(purgePlayer('99') === 0, 'erasing an unknown player should remove 0 and not throw');

  const remainingPlayers = (db.query('SELECT DISTINCT player_id AS p FROM telemetry').all() as { p: string }[])
    .map((r) => r.p);
  assert(remainingPlayers.length === 1 && remainingPlayers[0] === '01',
    `only player 01 should remain, got [${remainingPlayers.join(',')}]`);

  // --- 3. erasure destroys the bytes, not just the row (PRAGMA secure_delete) ---------
  insertTelemetry(fix({ id: SENTINEL, playerId: SENTINEL, sessionId: 'sx', serverTs: NOW - 3600_000 }));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // flush so the live bytes are in the main file
  assert(readFileSync(DB_PATH).includes(SENTINEL), 'sanity: sentinel should be in the DB file before erasure');
  assert(purgePlayer(SENTINEL) === 1, 'sentinel row should be erased');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // flush the secure_delete zeroing into the main file
  assert(!readFileSync(DB_PATH).includes(SENTINEL),
    'secure_delete must zero freed pages — the sentinel bytes must NOT survive erasure in the DB file');

  // --- 4. empty store -> age gauge resets to 0 ---------------------------------------
  purgePlayer('01');
  assert(count() === 0, 'store should be empty after erasing player 01');
  refreshRetentionGauges(NOW);
  assert(metric('ft_oldest_raw_fix_age_seconds') === 0,
    'oldest-fix age should be 0 when the store is empty');

  // --- 5. a sweep that throws is caught + counted, never crashes ----------------------
  const failBefore = metric('ft_retention_sweep_failures_total') ?? 0;
  db.close(); // make every subsequent DB call throw
  let threw = false;
  let r = -1;
  try { r = await runRetention(NOW); } catch { threw = true; }
  assert(!threw, 'runRetention must not throw even when the DB is unusable');
  assert(r === 0, 'a failed sweep returns 0');
  assert((metric('ft_retention_sweep_failures_total') ?? 0) === failBefore + 1,
    'a failed sweep must increment ft_retention_sweep_failures_total');

  // --- 6. fail-safe env: a garbage RETENTION_DAYS must default to 30, never disable ---
  const garbage = Bun.spawnSync(
    ['bun', '-e', 'import("./src/retention").then((m) => process.exit(m.RETENTION_DAYS === 30 ? 0 : 7))'],
    {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, RETENTION_DAYS: 'abc', DB_PATH: '/tmp/ft-ret-garbage.db' },
      stdout: 'ignore', stderr: 'ignore',
    },
  );
  assert(garbage.exitCode === 0,
    'a malformed RETENTION_DAYS (e.g. "abc") must fail safe to 30, not silently disable the purge');

  console.log('\n✅ RETENTION PASSED — purge correct & present-at-0, bytes erased, failures caught, env fails safe');
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, '/tmp/ft-ret-garbage.db', '/tmp/ft-ret-garbage.db-wal', '/tmp/ft-ret-garbage.db-shm']) {
    rmSync(f, { force: true });
  }
  process.exit(0);
} catch (err) {
  console.error('\n❌ RETENTION TEST FAILED:', (err as Error).message);
  process.exit(1);
}
