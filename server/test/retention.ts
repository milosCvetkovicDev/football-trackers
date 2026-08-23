/**
 * Retention & erasure unit test (ADR-0010) — no broker, deterministic clock.
 *
 * Proves the privacy guarantees that bound the children's-location blast-radius:
 *   1. the time-based sweep deletes raw fixes older than RETENTION_DAYS and leaves the rest,
 *      and the observability is honest (purged counter present-at-0, oldest-fix age, last-run);
 *   2. purge-player erasure removes exactly one player's rows, scoped to a session or all,
 *      and secure_delete actually destroys the bytes (not just the row);
 *   3. a sweep that throws is caught and counted, never crashing the server;
 *   4. a malformed RETENTION_DAYS fails SAFE to the 30-day default, never silently off;
 *   5. the sweep also prunes roster sessions that have outlived their telemetry (audit §4.5 "retention
 *      never touches roster.json"): a name↔playerId map with no fixes left and a stamp older than the
 *      window is dropped — while a roster provisioned AHEAD of a match (no fixes YET) is kept.
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
const ROSTER_FILE = '/tmp/ft-retention-test-roster.json';

// Must be set before importing db.ts (opens DB on import) / retention.ts (reads RETENTION_DAYS).
process.env.DB_PATH = DB_PATH;
process.env.RETENTION_DAYS = '30';
process.env.AUTH_ROSTER_FILE = ROSTER_FILE;
process.env.LOG_LEVEL = 'error';

import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import type { Telemetry } from '../src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ROSTER_FILE]) {
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

  assert((await purgePlayer('02', 's1')) === 2, 'session-scoped erasure should remove the 2 s1 rows only');
  assert(count() === 2, `expected 2 rows after session-scoped erasure (4 - 2), got ${count()}`);

  assert((await purgePlayer('02')) === 1, 'all-session erasure should remove the remaining s2 row');
  assert(count() === 1, `expected 1 row after full erasure of player 02 (only player01 left), got ${count()}`);

  assert((await purgePlayer('99')) === 0, 'erasing an unknown player should remove 0 and not throw');

  const remainingPlayers = (db.query('SELECT DISTINCT player_id AS p FROM telemetry').all() as { p: string }[])
    .map((r) => r.p);
  assert(remainingPlayers.length === 1 && remainingPlayers[0] === '01',
    `only player 01 should remain, got [${remainingPlayers.join(',')}]`);

  // --- 3. erasure destroys the bytes, not just the row (PRAGMA secure_delete) ---------
  insertTelemetry(fix({ id: SENTINEL, playerId: SENTINEL, sessionId: 'sx', serverTs: NOW - 3600_000 }));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // flush so the live bytes are in the main file
  assert(readFileSync(DB_PATH).includes(SENTINEL), 'sanity: sentinel should be in the DB file before erasure');
  assert((await purgePlayer(SENTINEL)) === 1, 'sentinel row should be erased');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // flush the secure_delete zeroing into the main file
  assert(!readFileSync(DB_PATH).includes(SENTINEL),
    'secure_delete must zero freed pages — the sentinel bytes must NOT survive erasure in the DB file');

  // --- 4. empty store -> age gauge resets to 0 ---------------------------------------
  await purgePlayer('01');
  assert(count() === 0, 'store should be empty after erasing player 01');
  refreshRetentionGauges(NOW);
  assert(metric('ft_oldest_raw_fix_age_seconds') === 0,
    'oldest-fix age should be 0 when the store is empty');

  // --- 4b. the sweep prunes roster sessions that outlived their telemetry (audit §4.5) --
  // Four sessions, one per rule. `live` has fixes; the rest have none. Only `stale` — no fixes AND a stamp
  // older than the window — may go. `upcoming` (stamped yesterday: a coach provisioning names before a
  // match) and `legacy` (no stamp at all: a pre-Phase-2b file) must SURVIVE; legacy gets stamped so it
  // becomes eligible one window later instead of living forever.
  // Two more from the checker pass: a stamp in the FUTURE (clock was wrong at `set` time) must be clamped
  // to now, not honoured for years; and a session literally named "__proto__" (only reachable by hand-editing
  // the file — roster-user.ts rejects it) must be stamped like any other instead of silently never pruning
  // and forcing a rewrite every sweep.
  const rosterBefore = {
    sessions: {
      live: [{ playerId: '01', displayName: 'Live One' }],
      stale: [{ playerId: '02', displayName: 'Stale Two' }],
      upcoming: [{ playerId: '03', displayName: 'Upcoming Three' }],
      legacy: [{ playerId: '04', displayName: 'Legacy Four' }],
      future: [{ playerId: '05', displayName: 'Future Five' }],
      ['__proto__']: [{ playerId: '06', displayName: 'Proto Six' }],
    },
    sessionMeta: {
      live: { updatedAt: NOW - 40 * DAY_MS },
      stale: { updatedAt: NOW - 31 * DAY_MS },
      upcoming: { updatedAt: NOW - 1 * DAY_MS },
      future: { updatedAt: NOW + 400 * DAY_MS },
    },
  };
  // The "has telemetry?" probe the sweep uses must be an indexed seek per roster session, not a DISTINCT
  // scan of the whole table (linear in rows — seconds at a 30-day store — on the live event loop).
  const { sessionHasTelemetry } = await import('../src/db');
  {
    const explain = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM telemetry WHERE session_id = ?1 LIMIT 1');
    const p = (explain.all() as { detail: string }[]).map((r) => r.detail).join(' | ');
    explain.finalize();
    assert(/SEARCH/.test(p) && /idx_telemetry_session_ts/.test(p) && !/SCAN/.test(p), `the per-session probe must SEARCH the session index, got: ${p}`);
  }
  // JSON.stringify of an object literal with a computed "__proto__" key DOES emit it as an own key.
  writeFileSync(ROSTER_FILE, JSON.stringify(rosterBefore, null, 2) + '\n', { mode: 0o600 });
  assert(readFileSync(ROSTER_FILE, 'utf8').includes('"__proto__"'), 'precondition: the file carries a literal __proto__ session');
  insertTelemetry(fix({ sessionId: 'live', playerId: '01', serverTs: NOW - DAY_MS }));
  assert(sessionHasTelemetry('live') && !sessionHasTelemetry('stale'), 'sessionHasTelemetry must see the live session only');
  const prunedBefore = metric('ft_retention_roster_sessions_pruned_total') ?? 0;
  await runRetention(NOW);
  const rosterAfter = JSON.parse(readFileSync(ROSTER_FILE, 'utf8')) as {
    sessions: Partial<typeof rosterBefore.sessions>;
    sessionMeta: Partial<Record<keyof typeof rosterBefore.sessions, { updatedAt?: number }>>;
  };
  assert(rosterAfter.sessions.stale === undefined, 'a roster session with no fixes left and a stamp older than the window must be pruned');
  assert(rosterAfter.sessionMeta.stale === undefined, 'the pruned session\'s stamp goes with it');
  assert(!readFileSync(ROSTER_FILE, 'utf8').includes('Stale Two'), 'the pruned name must be gone from the file');
  assert(JSON.stringify(rosterAfter.sessions.live) === JSON.stringify(rosterBefore.sessions.live), 'a session with fixes is kept');
  assert(JSON.stringify(rosterAfter.sessions.upcoming) === JSON.stringify(rosterBefore.sessions.upcoming),
    'a roster provisioned AHEAD of its match (no fixes yet, recent stamp) must be kept');
  assert(JSON.stringify(rosterAfter.sessions.legacy) === JSON.stringify(rosterBefore.sessions.legacy), 'an unstamped legacy session is kept');
  assert(rosterAfter.sessionMeta.legacy?.updatedAt === NOW, `an unstamped session must be stamped with the sweep time, got ${JSON.stringify(rosterAfter.sessionMeta.legacy)}`);
  assert(rosterAfter.sessionMeta.future?.updatedAt === NOW, `a FUTURE stamp must be clamped to the sweep time, got ${JSON.stringify(rosterAfter.sessionMeta.future)}`);
  assert(JSON.stringify(rosterAfter.sessions.future) === JSON.stringify(rosterBefore.sessions.future), 'a future-stamped session is kept (for now)');
  const metaOwn = Object.getOwnPropertyDescriptor(rosterAfter.sessionMeta, '__proto__')?.value as { updatedAt?: number } | undefined;
  assert(metaOwn?.updatedAt === NOW, `a "__proto__" session must get an OWN stamp like any other, got ${JSON.stringify(Object.getOwnPropertyNames(rosterAfter.sessionMeta))}`);
  assert((metric('ft_retention_roster_sessions_pruned_total') ?? 0) === prunedBefore + 1,
    'ft_retention_roster_sessions_pruned_total must count the pruned session');
  // A second sweep at the same instant is a no-op: nothing else crossed the window.
  await runRetention(NOW);
  assert(JSON.stringify(JSON.parse(readFileSync(ROSTER_FILE, 'utf8'))) === JSON.stringify(rosterAfter), 'an idempotent re-sweep must not change the file');
  await purgePlayer('01');

  // --- 5. a sweep that throws is caught + counted, never crashes ----------------------
  const failBefore = metric('ft_retention_sweep_failures_total') ?? 0;
  db.close(); // make every subsequent DB call throw
  let threw = false;
  let r = -1;
  try { r = await runRetention(NOW); } catch { threw = true; }
  assert(!threw, 'runRetention must not throw even when the DB is unusable');
  assert(r === 0, 'a failed sweep returns 0');
  // Two stages, two failures: the telemetry sweep throws, and the roster prune — which must NOT guess
  // which sessions still have fixes when it cannot ask the DB — throws too. Both are counted.
  assert((metric('ft_retention_sweep_failures_total') ?? 0) === failBefore + 2,
    `a failed sweep must increment ft_retention_sweep_failures_total once per failed stage (telemetry + roster), got +${(metric('ft_retention_sweep_failures_total') ?? 0) - failBefore}`);

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

  console.log('\n✅ RETENTION PASSED — purge correct & present-at-0, bytes erased, orphaned roster pruned, failures caught, env fails safe');
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ROSTER_FILE, '/tmp/ft-ret-garbage.db', '/tmp/ft-ret-garbage.db-wal', '/tmp/ft-ret-garbage.db-shm']) {
    rmSync(f, { force: true });
  }
  process.exit(0);
} catch (err) {
  console.error('\n❌ RETENTION TEST FAILED:', (err as Error).message);
  process.exit(1);
}
