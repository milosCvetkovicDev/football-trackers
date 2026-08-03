/**
 * events.ts — module correctness for tactical event detection (ADR-0020, event-detection-contract §4).
 *
 * Two layers:
 *   1. PURE detector tests on hand-built team-shape series (no DB) — exact boundary cases for each detector and
 *      every pre-mortem fix: high_tempo duration boundary (PM-4), the participation floor (PM-6), the run-break
 *      across a data gap (PM-5), the transition ≥2-step guard (PM-S4), the stoppage duration boundary.
 *   2. DB-backed readEvents over seeded fixtures — bucketing, team-shape geometry (centroid/stretch/spread/hull),
 *      the per-bucket player cap (PM-2), cross-page accumulation (tiny scan chunk), the final-bucket flush (PM-3),
 *      adaptive bucketMs + bounded/sparse series (§1.2), and param validation.
 *
 *   bun run test/events.ts        — exits 0 on success, 1 on any failed assertion.
 */

const DB_PATH = '/tmp/ft-events-test.db';
process.env.DB_PATH = DB_PATH;
process.env.LOG_LEVEL = 'error';
process.env.EVENTS_SCAN_CHUNK = '4'; // tiny chunk so paging genuinely loops + a bucket spans page boundaries

import { existsSync, rmSync } from 'node:fs';
import type { Telemetry } from '../src/types';
import type { TeamShapeBucket } from '../src/types';

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) rmSync(f);

const { db, insertTelemetry } = await import('../src/db');
const {
  readEvents,
  detectEvents,
  validateEventsParams,
  EventsParamError,
  EVENTS_MAX_SPAN_MS,
  EVENTS_MAX_PLAYERS_PER_BUCKET,
} = await import('../src/events');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
const near = (a: number, b: number, tol: number, msg: string) =>
  assert(Math.abs(a - b) <= tol, `${msg}: expected ~${b} (±${tol}), got ${a}`);

// ----- geometry helpers (mirror events.ts projection so fixtures are self-consistent) -----
const R = 6_371_000;
const C_LAT = 44.8125;
const C_LON = 20.4612;
const dLatOf = (m: number): number => ((m / R) * 180) / Math.PI;
const dLonOf = (m: number): number => ((m / (R * Math.cos((C_LAT * Math.PI) / 180))) * 180) / Math.PI;

const BASE = 1_700_000_000_000; // a fixed epoch ms so bucket math is deterministic

function fix(session: string, player: string, serverTs: number, lat: number, lon: number, spd: number): void {
  const t: Telemetry = {
    id: `trk-${player}`,
    pl: player,
    playerId: player,
    sessionId: session,
    ts: serverTs,
    serverTs,
    lat,
    lon,
    spd,
    hdg: 0,
    fix: 3,
    sats: 11,
    pdop: 1.0,
  };
  insertTelemetry(t);
}

/** Build a synthetic team-shape bucket for the pure detector tests. */
function bucket(ts: number, over: Partial<TeamShapeBucket>): TeamShapeBucket {
  return {
    ts,
    count: 3,
    centroid: { lat: C_LAT, lon: C_LON },
    stretchM: 0,
    surfaceAreaM2: 0,
    spreadM: 0,
    meanSpeedMps: 0,
    hsrFraction: 0,
    ...over,
  };
}

try {
  // =====================================================================================================
  // 1. PURE detector tests (no DB) — exact boundaries.
  // =====================================================================================================
  const BMS = 1000;

  // --- 1a. high_tempo: exactly 3×1s qualifying buckets → fires at 3.0s (PM-4 duration boundary). ----------
  {
    const series = [0, 1000, 2000].map((ts) => bucket(BASE + ts, { hsrFraction: 1.0, count: 3 }));
    const ev = detectEvents(series, BMS).filter((e) => e.type === 'high_tempo');
    assert(ev.length === 1, `3×1s tempo buckets should fire exactly 1 high_tempo, got ${ev.length}`);
    assert(ev[0].fromTs === BASE && ev[0].toTs === BASE + 3000, 'high_tempo span should be [from, from+3000]');
    near(ev[0].confidence, 1.0, 1e-9, 'high_tempo confidence == peak hsrFraction');
    assert(ev[0].minCount === 3, `high_tempo minCount should be 3, got ${ev[0].minCount}`);
  }
  // --- 1b. high_tempo: only 2 qualifying buckets (2.0s < 3.0s) → no fire. --------------------------------
  {
    const series = [0, 1000].map((ts) => bucket(BASE + ts, { hsrFraction: 1.0, count: 3 }));
    const ev = detectEvents(series, BMS).filter((e) => e.type === 'high_tempo');
    assert(ev.length === 0, `2×1s tempo buckets (2.0s) must NOT fire high_tempo, got ${ev.length}`);
  }
  // --- 1c. PM-6 participation floor: 3 qualifying buckets but count=2 (< MIN_PLAYERS_FOR_EVENTS) → no fire. -
  {
    const series = [0, 1000, 2000].map((ts) => bucket(BASE + ts, { hsrFraction: 1.0, count: 2 }));
    const ev = detectEvents(series, BMS).filter((e) => e.type === 'high_tempo');
    assert(ev.length === 0, `thin-data buckets (count 2) must NOT fabricate a high_tempo event, got ${ev.length}`);
  }
  // --- 1d. PM-5 run-break: 4 qualifying buckets split by a 1-bucket gap into two 2-bucket runs → 0 events. -
  // Without the gap-break this would be read as one 4-bucket (4.0s) run and FALSELY fire.
  {
    const series = [0, 1000, 3000, 4000].map((ts) => bucket(BASE + ts, { hsrFraction: 1.0, count: 3 }));
    const ev = detectEvents(series, BMS).filter((e) => e.type === 'high_tempo');
    assert(ev.length === 0, `a data gap must break the run (two 2s runs, no fire); got ${ev.length} — run spanned the hole`);
  }

  // --- 1e. transition: centroid moves ~22m over 2 steps with the team moving → fires once. ----------------
  {
    const series = [0, 1000, 2000, 3000].map((ts, k) =>
      bucket(BASE + ts, { count: 3, meanSpeedMps: 3.0, centroid: { lat: C_LAT + k * dLatOf(11), lon: C_LON } }),
    );
    const ev = detectEvents(series, BMS).filter((e) => e.type === 'transition');
    assert(ev.length === 1, `a 22m/2-step centroid shift should fire exactly 1 transition, got ${ev.length}`);
    near(ev[0].centroidShiftM ?? -1, 22, 1.0, 'transition centroidShiftM ~22m');
    near(ev[0].confidence, 22 / 40, 0.05, 'transition confidence ~ shift/(2*TRANSITION_M)');
    assert(ev[0].fromTs === BASE && ev[0].toTs === BASE + 3000, 'transition span [from, from+3000]');
  }
  // --- 1f. PM-S4: a SINGLE-step 30m centroid jump (only 2 buckets) must NOT fire (noise guard). -----------
  {
    const series = [0, 1000].map((ts, k) =>
      bucket(BASE + ts, { count: 3, meanSpeedMps: 3.0, centroid: { lat: C_LAT + k * dLatOf(30), lon: C_LON } }),
    );
    const ev = detectEvents(series, BMS).filter((e) => e.type === 'transition');
    assert(ev.length === 0, `a single-step centroid jump must NOT fire a transition (PM-S4), got ${ev.length}`);
  }

  // --- 1g. stoppage duration boundary (PB-3): EXACTLY 8 buckets (8.0s == STOPPAGE_MIN_S) fires — exercising the
  // `>= MIN − SECONDS_EPS` comparator AT the threshold; EXACTLY 7 (7.0s) does NOT. (A 9-vs-7 pair would straddle
  // the boundary and a `>=`→`>` off-by-one that drops legitimate exactly-8s stoppages would ship green.)
  {
    const eight = Array.from({ length: 8 }, (_, k) => bucket(BASE + k * 1000, { count: 3, meanSpeedMps: 0.1 }));
    const ev8 = detectEvents(eight, BMS).filter((e) => e.type === 'stoppage');
    assert(ev8.length === 1, `8×1s still buckets (exactly 8.0s) must fire 1 stoppage at the boundary, got ${ev8.length}`);
    near(ev8[0].confidence, 0.8, 1e-6, 'stoppage confidence == 1 - meanSpeed/threshold');
    assert(ev8[0].minCount === 3, 'stoppage minCount 3');

    const seven = Array.from({ length: 7 }, (_, k) => bucket(BASE + k * 1000, { count: 3, meanSpeedMps: 0.1 }));
    const ev7 = detectEvents(seven, BMS).filter((e) => e.type === 'stoppage');
    assert(ev7.length === 0, `7×1s still buckets (7.0s < 8.0s) must NOT fire stoppage, got ${ev7.length}`);
  }
  // --- 1h. stoppage centroid-move break: still speed but the centroid jumps > max between two buckets. ----
  {
    const s = Array.from({ length: 9 }, (_, k) =>
      bucket(BASE + k * 1000, {
        count: 3,
        meanSpeedMps: 0.1,
        // bucket 4 sits 50m north of the rest → the per-step move at k=4 and k=5 exceeds STOPPAGE_CENTROID_MAX_M
        centroid: { lat: C_LAT + (k === 4 ? dLatOf(50) : 0), lon: C_LON },
      }),
    );
    const ev = detectEvents(s, BMS).filter((e) => e.type === 'stoppage');
    // The big centroid steps at k=4 split the run; neither side is ≥ 8s, so no stoppage fires.
    assert(ev.length === 0, `a >max centroid jump must break the stoppage run; got ${ev.length}`);
  }
  console.log('[pure] detector boundaries OK (PM-4/PM-5/PM-6/PM-S4 + stoppage duration/centroid-break)');

  // =====================================================================================================
  // 2. DB-backed readEvents — bucketing, geometry, caps, paging, adaptivity, validation.
  // =====================================================================================================

  // --- 2a. team-shape geometry: a 4-player 10m-half-side square in one bucket. ----------------------------
  const GEO = 'geo';
  fix(GEO, 'p1', BASE + 10, C_LAT + dLatOf(10), C_LON + dLonOf(10), 5.0); // NE, sprinting
  fix(GEO, 'p2', BASE + 20, C_LAT + dLatOf(10), C_LON - dLonOf(10), 1.0); // NW
  fix(GEO, 'p3', BASE + 30, C_LAT - dLatOf(10), C_LON + dLonOf(10), 1.0); // SE
  fix(GEO, 'p4', BASE + 40, C_LAT - dLatOf(10), C_LON - dLonOf(10), 1.0); // SW
  {
    const r = await readEvents({ sessionId: GEO, from: BASE, to: BASE + 1000 });
    assert(r.bucketMs === 1000, `small window → 1000ms buckets, got ${r.bucketMs}`);
    assert(r.series.length === 1, `the square should form exactly 1 bucket, got ${r.series.length}`);
    const b = r.series[0];
    assert(b.count === 4, `bucket count should be 4, got ${b.count}`);
    near(b.centroid.lat, C_LAT, 1e-7, 'centroid lat == mean (symmetric square)');
    near(b.centroid.lon, C_LON, 1e-7, 'centroid lon == mean (symmetric square)');
    near(b.stretchM, 10 * Math.SQRT2, 0.5, 'stretch == mean dist from centroid (d√2)');
    near(b.spreadM, 20 * Math.SQRT2, 1.0, 'spread == diagonal (2d√2)');
    near(b.surfaceAreaM2, 400, 6, 'hull area == (2d)² = 400 m²');
    near(b.hsrFraction, 0.25, 1e-9, 'hsrFraction == 1 of 4 above HSR (U14 default 4.86)');
    near(b.meanSpeedMps, 2.0, 1e-9, 'meanSpeed == (5+1+1+1)/4');
    assert(r.ageBand === 'U14', `unconfigured session → U14 provenance, got ${r.ageBand}`);
    assert(r.detectorParams.minPlayersForEvents === 3, 'detectorParams shipped (provenance, PM-S6)');
  }

  // --- 2b. PM-S2/S3 hull degeneracy: 3 collinear players → area 0; 3 coincident → area 0. -----------------
  const LINE = 'line';
  fix(LINE, 'a', BASE + 1, C_LAT - dLatOf(10), C_LON, 1.0);
  fix(LINE, 'b', BASE + 2, C_LAT, C_LON, 1.0);
  fix(LINE, 'c', BASE + 3, C_LAT + dLatOf(10), C_LON, 1.0); // all on the same meridian → collinear
  {
    const r = await readEvents({ sessionId: LINE, from: BASE, to: BASE + 1000 });
    near(r.series[0].surfaceAreaM2, 0, 1e-6, 'collinear players → hull area 0 (PM-S2)');
    assert(r.series[0].spreadM > 0, 'collinear players still have a non-zero spread');
  }
  const DOT = 'dot';
  fix(DOT, 'a', BASE + 1, C_LAT, C_LON, 1.0);
  fix(DOT, 'b', BASE + 2, C_LAT, C_LON, 1.0);
  fix(DOT, 'c', BASE + 3, C_LAT, C_LON, 1.0); // identical position
  {
    const r = await readEvents({ sessionId: DOT, from: BASE, to: BASE + 1000 });
    near(r.series[0].surfaceAreaM2, 0, 1e-6, 'coincident players → hull area 0');
    near(r.series[0].spreadM, 0, 1e-6, 'coincident players → spread 0');
    near(r.series[0].stretchM, 0, 1e-6, 'coincident players → stretch 0');
  }

  // --- 2c. PM-2 per-bucket player cap: 70 distinct players in one bucket → count clamped to the cap. ------
  const CAP = 'cap';
  for (let i = 0; i < 70; i++) {
    const pid = `p${String(i).padStart(2, '0')}`;
    fix(CAP, pid, BASE + i, C_LAT + dLatOf(i % 10), C_LON + dLonOf(Math.floor(i / 10)), 1.0);
  }
  {
    const r = await readEvents({ sessionId: CAP, from: BASE, to: BASE + 1000 });
    assert(
      r.series[0].count === EVENTS_MAX_PLAYERS_PER_BUCKET,
      `70 players in one bucket must clamp to the cap (${EVENTS_MAX_PLAYERS_PER_BUCKET}), got ${r.series[0].count}`,
    );
  }

  // --- 2d. PM-3 final-bucket flush + cross-page accumulation: 3 players × 3 consecutive buckets, all
  // sprinting → the LAST bucket must be emitted for the 3.0s high_tempo to fire (proves the flush). The
  // tiny EVENTS_SCAN_CHUNK=4 forces several pages, so buckets accumulate across page boundaries. -----------
  const TEMPO = 'tempo';
  for (let k = 0; k < 3; k++) {
    fix(TEMPO, 'p1', BASE + k * 1000 + 1, C_LAT, C_LON + dLonOf(0), 5.0);
    fix(TEMPO, 'p2', BASE + k * 1000 + 2, C_LAT, C_LON + dLonOf(5), 5.0);
    fix(TEMPO, 'p3', BASE + k * 1000 + 3, C_LAT, C_LON + dLonOf(10), 5.0);
  }
  {
    const r = await readEvents({ sessionId: TEMPO, from: BASE, to: BASE + 3000 });
    assert(r.series.length === 3, `expected 3 buckets incl. the flushed final one (PM-3), got ${r.series.length}`);
    const ht = r.events.filter((e) => e.type === 'high_tempo');
    assert(ht.length === 1, `the 3rd (final) bucket must be flushed for the 3.0s high_tempo to fire, got ${ht.length}`);
    assert(ht[0].toTs === BASE + 3000, 'high_tempo covers all 3 buckets (final flush included)');
  }

  // --- 2e. §1.2 adaptive bucketMs + sparse series: a ~2.78h span with two far-apart fixes → bucketMs
  // coarsens above the floor and only the 2 occupied buckets materialise (empty ones skipped). ------------
  const SPARSE = 'sparse';
  const FAR = 10_000_000; // span well under EVENTS_MAX_SPAN_MS (21.6e6) but ≫ MAX_BUCKETS*MIN_BUCKET_MS
  fix(SPARSE, 'p1', BASE, C_LAT, C_LON, 1.0);
  fix(SPARSE, 'p1', BASE + FAR - 1000, C_LAT, C_LON, 1.0);
  {
    const r = await readEvents({ sessionId: SPARSE, from: BASE, to: BASE + FAR });
    assert(r.bucketMs === 2000, `bucketMs should coarsen to ceil(${FAR}/5000)=2000, got ${r.bucketMs}`);
    assert(r.series.length === 2, `only the 2 occupied buckets should materialise (empties skipped), got ${r.series.length}`);
    assert(r.series.length <= 5000, 'series is bounded by MAX_BUCKETS');
  }

  // --- 2f. empty window → empty result (fail-closed on the client). --------------------------------------
  {
    const r = await readEvents({ sessionId: 'nope', from: BASE, to: BASE + 1000 });
    assert(r.series.length === 0 && r.events.length === 0, 'an empty window returns empty series + events');
  }

  // --- 2g. param validation (opaque, fail-closed). -------------------------------------------------------
  const expectErr = (raw: { sessionId: string; from?: unknown; to?: unknown }, reason: string) => {
    try {
      validateEventsParams(raw);
      assert(false, `expected EventsParamError(${reason}) for ${JSON.stringify(raw)}`);
    } catch (e) {
      assert(e instanceof EventsParamError && e.reason === reason, `expected reason '${reason}', got ${(e as Error).message}`);
    }
  };
  expectErr({ sessionId: 's', from: 100, to: 50 }, 'bad_window'); // to < from
  expectErr({ sessionId: 's', from: 100, to: 100 }, 'bad_window'); // to == from
  expectErr({ sessionId: 's', from: 'x', to: 1 }, 'bad_window'); // non-finite
  expectErr({ sessionId: 's', from: 0, to: EVENTS_MAX_SPAN_MS + 1 }, 'span_too_large');
  const okp = validateEventsParams({ sessionId: 's', from: 0, to: 1000 });
  assert(okp.from === 0 && okp.to === 1000 && okp.sessionId === 's', 'valid params pass through');

  console.log('[db] bucketing/geometry/cap/flush/adaptive/validation OK');
  console.log('\n✅ EVENTS PASSED — detectors (boundaries + PM fixes) + readEvents (team-shape, player cap, final flush, adaptive bucketing, opaque params)');
  db.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) rmSync(f);
  process.exit(0);
} catch (err) {
  console.error('\n❌ EVENTS FAILED:', (err as Error).message);
  try {
    db.close();
  } catch {
    /* noop */
  }
  process.exit(1);
}
