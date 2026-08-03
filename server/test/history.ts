/**
 * History read unit test (ADR-0017, contract §3.1 + §5) — no broker, no HTTP, deterministic.
 *
 * Proves the module-level review/replay read against a seeded temp DB:
 *   1. mode=aggregate correctness on a KNOWN seeded set — fixes/distance/bbox/heatmap sums;
 *   2. mode=raw paging walks the whole window EXACTLY ONCE (no dup, no gap), INCLUDING a fixture
 *      with ≥2 rows sharing one server_ts — proving the composite (serverTs,rowid) cursor neither
 *      dups nor skips colliding rows (a scalar ts cursor would);
 *   3. param validation — span cap, to>from, mode, raw-requires-player, cursor both-or-neither;
 *   4. historyGate DoS controls — per-principal token bucket (burst then rate_limited), bucket
 *      isolation, and the global inflight cap (busy);
 *   5. NO `displayName` (or any name field) appears in ANY result row (§0.1);
 *   6. Phase 4 (contract §4.1) coaching aggregates on a hand-built seed — the §1 distance gate
 *      (v≥0.4 AND pdop≤5 drop), the zone-distance split (descending `>=` cascade), sprint efforts
 *      (counted ≥1.0 s run, NOT-counted <1.0 s run, and a scan-end flush), an accel effort count,
 *      distancePerMin over the gated distance, the top-level ageBand provenance, and no name leak.
 *
 *   bun run test/history.ts      (or: bun run test:history)
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

export {}; // module scope so top-level await is allowed

const DB_PATH = `/tmp/ft-hist-${process.pid}.db`;

// Must be set before importing db.ts (opens the DB on import) / history.ts (reads its env caps).
process.env.DB_PATH = DB_PATH;
process.env.LOG_LEVEL = 'error';
// Small caps so the DoS-gate assertions are fast + deterministic (not the prod defaults).
process.env.HISTORY_RATE_BURST = '3';
process.env.HISTORY_RATE_PER_MIN = '6';
process.env.OFFLOOP_MAX_INFLIGHT = '2'; // PM-1: inflight cap is now the SHARED history+events scanLoad slot
process.env.HISTORY_SCAN_CHUNK = '4'; // tiny chunk so paging genuinely loops over the fixture
process.env.HISTORY_MAX_SPAN_MS = String(86_400_000); // 24h

import { existsSync, rmSync } from 'node:fs';
import type { Telemetry } from '../src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
function approx(a: number, b: number, eps: number, msg: string): void {
  assert(Math.abs(a - b) <= eps, `${msg} (got ${a}, expected ~${b})`);
}

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (existsSync(f)) rmSync(f);
}

try {
  const { insertTelemetry, db } = await import('../src/db');
  const {
    readHistory,
    validateHistoryParams,
    historyGate,
    releaseInflight,
    _inflightCount,
    HistoryParamError,
  } = await import('../src/history');

  const SESSION = 's-hist';
  const T0 = 1_700_000_000_000; // base server_ts for the seed

  const fix = (over: Partial<Telemetry>): Telemetry => ({
    id: 'trk', pl: '01', ts: 1, lat: 44.8000, lon: 20.4000, spd: 1, hdg: 0,
    fix: 3, sats: 10, pdop: 1, sessionId: SESSION, playerId: '01', serverTs: T0, ...over,
  });

  // --- seed a KNOWN set ---------------------------------------------------------------
  // player 01: 3 fixes walking due-north 0.0001° lat steps (≈11.13 m each → ~22.25 m total),
  //            speeds [1, 2, 3] → avg 2, max 3.
  insertTelemetry(fix({ playerId: '01', serverTs: T0 + 0, lat: 44.8000, lon: 20.4000, spd: 1 }));
  insertTelemetry(fix({ playerId: '01', serverTs: T0 + 100, lat: 44.8001, lon: 20.4000, spd: 2 }));
  insertTelemetry(fix({ playerId: '01', serverTs: T0 + 200, lat: 44.8002, lon: 20.4000, spd: 3 }));
  // player 02: 2 fixes at the same spot (0 distance), speeds [5, 5] → avg 5, max 5.
  insertTelemetry(fix({ playerId: '02', serverTs: T0 + 50, lat: 44.8010, lon: 20.4010, spd: 5 }));
  insertTelemetry(fix({ playerId: '02', serverTs: T0 + 150, lat: 44.8010, lon: 20.4010, spd: 5 }));
  // COLLISION fixture: two player-01 rows sharing ONE server_ts (T0+300) — the composite-cursor
  // proof. At 10 Hz Date.now() collides constantly; a scalar ts cursor would dup or skip these.
  insertTelemetry(fix({ playerId: '01', serverTs: T0 + 300, lat: 44.8003, lon: 20.4000, spd: 4 }));
  insertTelemetry(fix({ playerId: '01', serverTs: T0 + 300, lat: 44.8004, lon: 20.4000, spd: 4 }));

  const totalRows = (db.query('SELECT COUNT(*) AS c FROM telemetry').get() as { c: number }).c;
  assert(totalRows === 7, `expected 7 seeded rows, got ${totalRows}`);

  const FROM = T0 - 1;
  const TO = T0 + 10_000;

  // === 1. AGGREGATE CORRECTNESS =======================================================
  const agg = (await readHistory({ sessionId: SESSION, from: FROM, to: TO, mode: 'aggregate' })) as Awaited<
    ReturnType<typeof readHistory>
  > & { ageBand: string; players: { playerId: string; fixes: number; distanceM: number; avgSpeedMps: number; maxSpeedMps: number; bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }; firstTs: number; lastTs: number; zoneDistanceM: number[]; sprint: { count: number; distanceM: number; maxSpeedMps: number }; effort: { accelMod: number; accelHigh: number; decelMod: number; decelHigh: number }; distancePerMin: number }[]; heatmap: { cols: number; rows: number; bins: number[] }; scannedRows: number };

  assert(agg.scannedRows === 7, `aggregate should scan all 7 rows, scanned ${agg.scannedRows}`);
  assert(agg.players.length === 2, `expected 2 players in the aggregate, got ${agg.players.length}`);

  const p01 = agg.players.find((p) => p.playerId === '01');
  const p02 = agg.players.find((p) => p.playerId === '02');
  assert(p01 && p02, 'both players 01 and 02 must appear');

  assert(p01!.fixes === 5, `player 01 should have 5 fixes (3 + 2 collision), got ${p01!.fixes}`);
  assert(p02!.fixes === 2, `player 02 should have 2 fixes, got ${p02!.fixes}`);

  // distance: 4 northward steps of ~11.13 m (44.80→44.8001→…→44.8004) = ~44.5 m for player 01 (collision rows
  // continue the chain). player 02 is stationary → 0. Under the Phase-4 §1 gate this is UNCHANGED: every seed
  // speed (1,2,3,4,4 and 5,5) is ≥ 0.4 m/s and every pdop is 1 ≤ 5, so no step is gated out here. (The gate's
  // DROP behaviour — v<0.4 / pdop>5 — is proven on a dedicated fixture in section 6 below.)
  approx(p01!.distanceM, 44.5, 3, 'player 01 total distance (gate passes all seed speeds)');
  approx(p02!.distanceM, 0, 0.01, 'player 02 distance (stationary)');

  // Phase-4 fields now ride on the aggregate; sanity-check provenance + Σ zoneDistanceM == gated distanceM here.
  assert(agg.ageBand === 'U14', `unconfigured session must default to U14, got ${agg.ageBand}`);
  const zSum01 = p01!.zoneDistanceM.reduce((s, x) => s + x, 0);
  approx(zSum01, p01!.distanceM, 1e-6, 'Σ player 01 zoneDistanceM must equal its gated distanceM');

  approx(p01!.avgSpeedMps, (1 + 2 + 3 + 4 + 4) / 5, 0.001, 'player 01 avg speed');
  assert(p01!.maxSpeedMps === 4, `player 01 max speed should be 4, got ${p01!.maxSpeedMps}`);
  assert(p02!.avgSpeedMps === 5 && p02!.maxSpeedMps === 5, 'player 02 avg+max speed should be 5');

  assert(p01!.firstTs === T0 + 0 && p01!.lastTs === T0 + 300, 'player 01 first/last ts');
  approx(p01!.bbox.minLat, 44.8000, 1e-9, 'player 01 bbox minLat');
  approx(p01!.bbox.maxLat, 44.8004, 1e-9, 'player 01 bbox maxLat');

  // heatmap: occupancy counts, grid scaled to the SCAN bbox; total bin count == total rows.
  assert(agg.heatmap.cols === 32 && agg.heatmap.rows === 20, 'heatmap default grid is 32×20');
  const binSum = agg.heatmap.bins.reduce((a, b) => a + b, 0);
  assert(binSum === 7, `heatmap bins must sum to the 7 scanned points, got ${binSum}`);
  assert(agg.heatmap.bins.length === 32 * 20, 'heatmap bins length == cols*rows');

  // === 2. RAW PAGING — whole window exactly once, composite cursor across a ts tie ======
  // Page player 01 with limit=2 so we MUST paginate (5 rows incl. the T0+300 collision pair).
  const seen: { serverTs: number; rowid?: number; lat: number }[] = [];
  let cursorTs: number | undefined;
  let cursorRowid: number | undefined;
  let pages = 0;
  for (;;) {
    pages += 1;
    assert(pages <= 20, 'raw paging did not terminate — possible cursor stall');
    const page = (await readHistory({
      sessionId: SESSION,
      from: FROM,
      to: TO,
      mode: 'raw',
      player: '01',
      cursorTs,
      cursorRowid,
      limit: 2,
    })) as { fixes: { serverTs: number; lat: number }[]; nextCursor: { serverTs: number; rowid: number } | null };
    for (const f of page.fixes) seen.push({ serverTs: f.serverTs, lat: f.lat });
    if (!page.nextCursor) break;
    cursorTs = page.nextCursor.serverTs;
    cursorRowid = page.nextCursor.rowid;
  }
  // EXACTLY the 5 player-01 fixes, each once, in order — including BOTH T0+300 collision rows.
  assert(seen.length === 5, `raw paging should return all 5 player-01 fixes exactly once, got ${seen.length}`);
  const tsSeq = seen.map((s) => s.serverTs);
  assert(
    JSON.stringify(tsSeq) === JSON.stringify([T0 + 0, T0 + 100, T0 + 200, T0 + 300, T0 + 300]),
    `raw ts sequence wrong (dup/skip?): ${JSON.stringify(tsSeq)}`,
  );
  // The two T0+300 rows are DISTINCT (different lat) — proves the cursor neither duped nor skipped.
  const collisionLats = seen.filter((s) => s.serverTs === T0 + 300).map((s) => s.lat).sort();
  assert(
    collisionLats.length === 2 && collisionLats[0] !== collisionLats[1],
    `the two ts-colliding rows must both appear, distinct: ${JSON.stringify(collisionLats)}`,
  );

  // A raw read of a player with no rows in the window → empty page, null cursor (no crash).
  const empty = (await readHistory({
    sessionId: SESSION, from: FROM, to: TO, mode: 'raw', player: '99',
  })) as { fixes: unknown[]; nextCursor: unknown };
  assert(empty.fixes.length === 0 && empty.nextCursor === null, 'unknown player → empty page, null cursor');

  // === 3. PARAM VALIDATION (typed errors mapped to 400 by the caller) ==================
  const throws = (fn: () => unknown, reason: string, label: string): void => {
    let err: unknown;
    try { fn(); } catch (e) { err = e; }
    assert(err instanceof HistoryParamError, `${label}: should throw HistoryParamError`);
    assert((err as InstanceType<typeof HistoryParamError>).reason === reason,
      `${label}: reason should be '${reason}', got '${(err as InstanceType<typeof HistoryParamError>).reason}'`);
  };
  throws(() => validateHistoryParams({ sessionId: SESSION, from: 100, to: 50 }), 'bad_window', 'to <= from');
  throws(() => validateHistoryParams({ sessionId: SESSION, from: NaN, to: 100 }), 'bad_window', 'non-finite from');
  throws(() => validateHistoryParams({ sessionId: SESSION, from: 0, to: 86_400_000 + 1 }), 'span_too_large', 'span > cap');
  throws(() => validateHistoryParams({ sessionId: SESSION, from: 0, to: 100, mode: 'nope' }), 'bad_mode', 'bad mode');
  throws(() => validateHistoryParams({ sessionId: SESSION, from: 0, to: 100, mode: 'raw' }), 'bad_player', 'raw requires player');
  throws(
    () => validateHistoryParams({ sessionId: SESSION, from: 0, to: 100, mode: 'raw', player: '01', cursor_ts: '5' }),
    'bad_cursor', 'cursor_ts without cursor_rowid (both-or-neither)',
  );
  throws(
    () => validateHistoryParams({ sessionId: SESSION, from: 0, to: 100, mode: 'raw', player: '01', cursor_rowid: '5' }),
    'bad_cursor', 'cursor_rowid without cursor_ts (both-or-neither)',
  );
  // Valid: aggregate default + raw with a full composite cursor + clamped limit.
  const okAgg = validateHistoryParams({ sessionId: SESSION, from: 0, to: 100 });
  assert(okAgg.mode === 'aggregate', 'mode defaults to aggregate');
  const okRaw = validateHistoryParams({
    sessionId: SESSION, from: 0, to: 100, mode: 'raw', player: '07', cursor_ts: '5', cursor_rowid: '9', limit: '99999',
  });
  assert(okRaw.mode === 'raw' && okRaw.player === '07' && okRaw.cursorTs === 5 && okRaw.cursorRowid === 9,
    'valid raw params parse the composite cursor');
  assert(okRaw.limit === 10_000, `limit should clamp to the hard max 10000, got ${okRaw.limit}`);

  // === 4. DoS GATE — token bucket (burst → rate_limited) + isolation + inflight cap ====
  // BURST=3: three OKs, then the fourth from the SAME principal is rate_limited. (gate increments
  // inflight on ok, so release each to isolate the bucket assertion from the cap.)
  for (let i = 0; i < 3; i++) {
    const g = historyGate('coach-A');
    assert(g.ok, `coach-A request ${i + 1} should pass the burst`);
    releaseInflight();
  }
  const limited = historyGate('coach-A');
  assert(!limited.ok && limited.result === 'rate_limited', 'coach-A 4th rapid request → rate_limited');
  // Bucket isolation: a DIFFERENT principal is unaffected by coach-A draining its bucket.
  const other = historyGate('coach-B');
  assert(other.ok, 'coach-B has its own bucket — not starved by coach-A');
  releaseInflight();

  // Inflight cap (MAX_INFLIGHT=2): hold two slots (fresh principals so the bucket allows it),
  // the third concurrent → busy; releasing one frees a slot.
  const g1 = historyGate('coach-C');
  const g2 = historyGate('coach-D');
  assert(g1.ok && g2.ok, 'two concurrent reads occupy the two inflight slots');
  assert(_inflightCount() === 2, `inflight should be 2, got ${_inflightCount()}`);
  const g3 = historyGate('coach-E');
  assert(!g3.ok && g3.result === 'busy', 'a third concurrent read → busy (inflight cap)');
  releaseInflight(); // free one slot
  assert(_inflightCount() === 1, `inflight should drop to 1 after release, got ${_inflightCount()}`);
  const g4 = historyGate('coach-F');
  assert(g4.ok, 'a slot freed → the next read is admitted');
  releaseInflight();
  releaseInflight();

  // === 5. NO NAME FIELD IN ANY RESULT ROW (§0.1) ======================================
  // Scan every aggregate player + raw fix object for a name-shaped key. The structural guarantee:
  // the result types have no such field, but assert at runtime so a future refactor can't leak one.
  const NAME_KEYS = ['displayName', 'name', 'playerName', 'childName'];
  const hasNameKey = (o: object): boolean => NAME_KEYS.some((k) => k in o);
  for (const p of agg.players) {
    assert(!hasNameKey(p), `aggregate player row must carry NO name field: ${JSON.stringify(Object.keys(p))}`);
    assert(!hasNameKey(p.bbox), 'bbox must carry no name field');
  }
  const rawForName = (await readHistory({
    sessionId: SESSION, from: FROM, to: TO, mode: 'raw', player: '01', limit: 10,
  })) as { fixes: object[] };
  for (const f of rawForName.fixes) {
    assert(!hasNameKey(f), `raw fix row must carry NO name field: ${JSON.stringify(Object.keys(f))}`);
  }
  // Belt: serialise the whole aggregate + raw payloads and assert none of the name keys appear.
  const blob = JSON.stringify(agg) + JSON.stringify(rawForName);
  for (const k of NAME_KEYS) {
    assert(!blob.includes(`"${k}"`), `serialised history payload must not contain a "${k}" field`);
  }

  // === 6. PHASE 4 COACHING AGGREGATES (contract §4.1, metric-definitions §2/§3/§4) =====
  // A SEPARATE session ('s-metrics', unconfigured → U14 thresholds: jog2.0 run4.0 HSR4.86 SPRINT5.83) with one
  // dedicated player per metric so each assertion is isolated. ~0.0001° lat steps ≈ 11.12 m; samples 100 ms apart
  // so durations are exact. Distinct serverTs bases per player (no cross-player ts collision to reason about).
  const MSESSION = 's-metrics';
  const STEP = 0.0001; // ° lat ≈ 11.12 m
  const STEP_M = STEP * 111195; // ≈ 11.12 m per northward step
  const mfix = (over: Partial<Telemetry>): Telemetry => ({
    id: 'trk', pl: '00', ts: 1, lat: 44.8, lon: 20.4, spd: 1, hdg: 0,
    fix: 3, sats: 10, pdop: 1, sessionId: MSESSION, playerId: '00', serverTs: T0, ...over,
  });
  // Seed a player as a sequence of (spd, pdop?) samples 100 ms apart, each 1 STEP north of the previous.
  const seedPlayer = (player: string, base: number, samples: { spd: number; pdop?: number }[]): void => {
    for (let i = 0; i < samples.length; i++) {
      insertTelemetry(
        mfix({ playerId: player, serverTs: base + i * 100, lat: 44.8 + i * STEP, lon: 20.4, spd: samples[i].spd, pdop: samples[i].pdop ?? 1 }),
      );
    }
  };

  // Z — zone split: each ARRIVING sample's speed bins its incoming step into a distinct U14 zone.
  // steps: walk(1.0)→Z1, jog(3.0)→Z2, run(4.5)→Z3, HSR(5.0)→Z4, sprint(6.0)→Z5 = one ~11.12 m step each.
  seedPlayer('Z', T0 + 1_000, [{ spd: 1.0 }, { spd: 1.0 }, { spd: 3.0 }, { spd: 4.5 }, { spd: 5.0 }, { spd: 6.0 }]);
  // SP — a sprint that IS counted: 12 consecutive ≥5.83 samples (dur 1.1 s ≥ 1.0 s), then a sub-threshold close.
  seedPlayer('SP', T0 + 100_000, [{ spd: 1.0 }, ...Array(12).fill({ spd: 6.0 }), { spd: 1.0 }]);
  // SS — a sprint TOO SHORT: 5 consecutive ≥5.83 samples (dur 0.4 s < 1.0 s), then close → NOT counted.
  seedPlayer('SS', T0 + 200_000, [{ spd: 1.0 }, ...Array(5).fill({ spd: 6.0 }), { spd: 1.0 }]);
  // SF — scan-end flush: 12 consecutive ≥5.83 samples that run to the window's end (no closing sample) → counted.
  seedPlayer('SF', T0 + 300_000, [{ spd: 1.0 }, ...Array(12).fill({ spd: 6.0 })]);
  // SB — the 1.0 s BOUNDARY (off-by-one guard): EXACTLY 10 above-threshold samples. With the entry interval
  // counted, 10 samples @100 ms span exactly 1.0 s → counted. (Pre-fix this measured 0.9 s and was dropped.)
  seedPlayer('SB', T0 + 350_000, [{ spd: 1.0 }, ...Array(10).fill({ spd: 6.0 }), { spd: 1.0 }]);
  // SM — the MERGE rule (§3.4 cl.3): two ≥1.0 s runs separated by a BRIEF 0.2 s sub-threshold dip (< 1.0 s) →
  // ONE effort, not two. (Pre-fix the dip closed the first run and the second opened fresh → wrongly counted 2.)
  seedPlayer('SM', T0 + 450_000, [{ spd: 1.0 }, ...Array(12).fill({ spd: 6.0 }), { spd: 4.0 }, { spd: 4.0 }, ...Array(12).fill({ spd: 6.0 }), { spd: 1.0 }]);
  // SS2 — the SEPARATOR rule: the same two runs separated by a 1.0 s dip (10 sub-threshold samples ≥ the
  // separator) → genuinely TWO efforts.
  seedPlayer('SS2', T0 + 550_000, [{ spd: 1.0 }, ...Array(12).fill({ spd: 6.0 }), ...Array(10).fill({ spd: 4.0 }), ...Array(12).fill({ spd: 6.0 }), { spd: 1.0 }]);
  // AC — accel effort: low-speed prefix, then a monotone +0.25 m/s per 100 ms ramp (steady smoothed a = 2.5 m/s²:
  // Moderate, below High), then flat. One sustained Mod accel effort; no High, no decel.
  seedPlayer('AC', T0 + 400_000, [
    { spd: 1.0 }, { spd: 1.0 }, { spd: 1.0 }, { spd: 1.0 },
    ...Array.from({ length: 20 }, (_, i) => ({ spd: 1.0 + 0.25 * (i + 1) })), // 1.25 … 6.0 ramp
    { spd: 6.0 }, { spd: 6.0 }, { spd: 6.0 }, { spd: 6.0 }, { spd: 6.0 }, // flat tail (MA settles, no decel)
  ]);
  // DM — distancePerMin: two fixes 2 minutes apart, ~100 m apart (9 STEPs), both spd≥0.4 → distance/2 ≈ 50 m/min.
  insertTelemetry(mfix({ playerId: 'DM', serverTs: T0 + 500_000, lat: 44.8, lon: 20.4, spd: 1.0 }));
  insertTelemetry(mfix({ playerId: 'DM', serverTs: T0 + 500_000 + 120_000, lat: 44.8 + 9 * STEP, lon: 20.4, spd: 1.0 }));
  // GT — distance gate DROP: only the final step (spd≥0.4, pdop≤5) counts; the v<0.4 and the pdop>5 steps drop.
  seedPlayer('GT', T0 + 800_000, [{ spd: 1.0 }, { spd: 0.2 }, { spd: 1.0, pdop: 9 }, { spd: 1.0, pdop: 1 }]);

  const MFROM = T0 - 1;
  const MTO = T0 + 2_000_000;
  const magg = (await readHistory({ sessionId: MSESSION, from: MFROM, to: MTO, mode: 'aggregate' })) as {
    ageBand: string;
    players: {
      playerId: string;
      distanceM: number;
      zoneDistanceM: number[];
      sprint: { count: number; distanceM: number; maxSpeedMps: number };
      effort: { accelMod: number; accelHigh: number; decelMod: number; decelHigh: number };
      distancePerMin: number;
    }[];
  };
  const mp = (id: string) => {
    const p = magg.players.find((x) => x.playerId === id);
    assert(p, `metrics player ${id} must appear`);
    return p!;
  };

  assert(magg.ageBand === 'U14', `s-metrics is unconfigured → U14 default, got ${magg.ageBand}`);

  // Zone split: 5 steps, one per zone, each ~STEP_M. zoneDistanceM ≈ [STEP_M ×5]; Σ == gated distanceM.
  const Z = mp('Z');
  for (let z = 0; z < 5; z++) approx(Z.zoneDistanceM[z], STEP_M, 0.5, `player Z zone ${z + 1} distance`);
  approx(Z.zoneDistanceM.reduce((s, x) => s + x, 0), Z.distanceM, 1e-6, 'player Z Σ zoneDistanceM == distanceM');

  // Sprint counted: exactly 1 effort, peak 6.0, distance = the gated steps accrued while above threshold (12).
  const SP = mp('SP');
  assert(SP.sprint.count === 1, `player SP should count exactly 1 sprint (1.1 s run), got ${SP.sprint.count}`);
  approx(SP.sprint.maxSpeedMps, 6.0, 1e-9, 'player SP sprint max speed');
  approx(SP.sprint.distanceM, 12 * STEP_M, 1.0, 'player SP sprint distance (12 above-threshold steps)');

  // Sprint too short: a 0.4 s run is below the 1.0 s floor → 0 efforts, 0 distance.
  const SS = mp('SS');
  assert(SS.sprint.count === 0, `player SS should count 0 sprints (0.4 s run < 1.0 s), got ${SS.sprint.count}`);
  approx(SS.sprint.distanceM, 0, 1e-9, 'player SS sprint distance is 0 (no counted run)');

  // Scan-end flush: a ≥1.0 s run open at the window edge must be flushed-counted post-loop.
  const SF = mp('SF');
  assert(SF.sprint.count === 1, `player SF scan-end flush should count the open ≥1.0 s run, got ${SF.sprint.count}`);

  // 1.0 s BOUNDARY (off-by-one guard): exactly 10 above-threshold samples span exactly 1.0 s → counted.
  const SB = mp('SB');
  assert(SB.sprint.count === 1, `player SB: 10 samples = exactly 1.0 s must count (off-by-one guard), got ${SB.sprint.count}`);

  // MERGE (§3.4 cl.3): two runs split by a 0.2 s dip (< 1.0 s) are ONE effort; sprint distance spans both
  // above-threshold halves (24 steps). A pre-fix immediate-close would have counted 2.
  const SM = mp('SM');
  assert(SM.sprint.count === 1, `player SM: a <1.0 s dip must MERGE the two runs into 1 effort, got ${SM.sprint.count}`);
  approx(SM.sprint.distanceM, 24 * STEP_M, 1.0, 'player SM merged sprint distance (24 above-threshold steps)');

  // SEPARATOR: the same two runs split by a 1.0 s dip (≥ the separator) are genuinely TWO efforts.
  const SS2 = mp('SS2');
  assert(SS2.sprint.count === 2, `player SS2: a ≥1.0 s dip must SEPARATE the runs into 2 efforts, got ${SS2.sprint.count}`);

  // Accel effort: one sustained Moderate accel; the steady 2.5 m/s² never reaches the High band; no decel.
  const AC = mp('AC');
  assert(AC.effort.accelMod === 1, `player AC should count exactly 1 moderate accel effort, got ${AC.effort.accelMod}`);
  assert(AC.effort.accelHigh === 0, `player AC steady 2.5 m/s² is below the High band → 0, got ${AC.effort.accelHigh}`);
  assert(AC.effort.decelMod === 0 && AC.effort.decelHigh === 0, `player AC monotone-up ramp → no decel efforts, got ${AC.effort.decelMod}/${AC.effort.decelHigh}`);

  // distancePerMin over the GATED distance: ~100 m over 2 min → ~50 m/min.
  const DM = mp('DM');
  approx(DM.distanceM, 9 * STEP_M, 0.5, 'player DM gated distance (~100 m)');
  approx(DM.distancePerMin, (9 * STEP_M) / 2, 0.5, 'player DM distancePerMin == distance / 2 min');

  // Distance gate DROP: of GT's 3 candidate steps, the v<0.4 one and the pdop>5 one are gated out; only 1 counts.
  const GT = mp('GT');
  approx(GT.distanceM, STEP_M, 0.5, 'player GT distance: only the v≥0.4 & pdop≤5 step counts (others gated)');

  // No name leak on the extended aggregate either (belt + structural).
  for (const p of magg.players) {
    assert(!hasNameKey(p), `metrics aggregate player must carry NO name field: ${JSON.stringify(Object.keys(p))}`);
  }
  const mblob = JSON.stringify(magg);
  for (const k of NAME_KEYS) {
    assert(!mblob.includes(`"${k}"`), `serialised Phase-4 aggregate must not contain a "${k}" field`);
  }

  console.log('\n✅ HISTORY PASSED — aggregate correct (incl. Phase-4 zone/sprint/accel/distancePerMin gate), composite-cursor paging exact across ts ties, params validated, DoS gate bounds, no name leak');
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) rmSync(f, { force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ HISTORY TEST FAILED:', (err as Error).message);
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) rmSync(f, { force: true });
  process.exit(1);
}
