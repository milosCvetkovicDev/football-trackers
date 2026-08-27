/**
 * Tactical event detection (Track A; ADR-0020, event-detection-contract.md) — an OFF-loop read over the stored
 * children's-location trace that builds a time-bucketed TEAM-SHAPE series and detects movement-derived phase
 * events (high_tempo / transition / stoppage). It is a bulk-export surface derived from minors' location and
 * inherits the ENTIRE history.ts posture (server.ts gates each request with §0.4 authz + this module's DoS
 * controls + an audit line + no-store + opaque errors), but is STRICTLY LESS identifying than history: the
 * result is TEAM-AGGREGATE — no playerId, no name, ever.
 *
 * THREAT MODEL: same as history.ts (a stolen 12h cookie could try to drain the store), plus a NEW scan shape —
 * group-by-time rather than group-by-player — so we re-prove the off-loop SLO (§5) independently. The scan is
 * streaming + keyset-paged + yields between pages; per-bucket geometry is bounded by a player cap (PM-2); the
 * INFLIGHT cap is the SHARED scanLoad slot (PM-1) so history + events together can't gang up on the loop.
 *
 * HONESTY (§0.5, ADR-0018 lineage): every event is a HEURISTIC over movement, never a confirmed ball event.
 * Each carries a confidence + the run's min player-count (PM-6), and the result ships the resolved speed AND
 * structural params it was scored against (PM-S6). The structural params are PROPOSED + UNVALIDATED on real
 * match data — env-tunable, never measurement truth.
 */

import { readFixesPage, type FixRow } from './db';
import { envNumber } from './env';
import { ageBandFor, thresholdsForSession } from './sessionConfig';
import type { DetectorParams, EventsResult, TacticalEvent, TeamShapeBucket } from './types';
import { acquireScanSlot, releaseScanSlot, newScanBudget, type ScanBudget } from './scanLoad';
import { metrics } from './metrics';

// ----- config (env) — bounds on the scan + the DoS controls (§1.5) -----------------------
/** Parse a positive-integer env knob, falling back to `def` on a missing / non-numeric / < 1 value. PB-N1: a
 * `Math.max(1, Number('6h'))` is NaN, and `span > NaN` is always false — silently voiding a security-critical
 * bound on a children's-location scan. So fall back instead of admitting NaN. */
const envCount = (name: string, def: number): number => envNumber(name, def, { min: 1 });
/** Max query window: a match + warmup is well under 6h, smaller than history's 24h (a tighter scan ceiling). */
const EVENTS_MAX_SPAN_MS = envCount('EVENTS_MAX_SPAN_MS', 21_600_000);
/** Rows per keyset page — same ~1–2 ms sync hold/page as history; we await-yield between pages. */
const EVENTS_SCAN_CHUNK = envCount('EVENTS_SCAN_CHUNK', 1000);
/** Bounds the RETURNED series length regardless of span (adaptive bucketing, §1.2). A NaN here would make
 * bucketMs NaN ⇒ every row its own bucket ⇒ unbounded series — hence the finite fallback above. */
const MAX_BUCKETS = envCount('EVENTS_MAX_BUCKETS', 5000);
/** Adaptive-bucket floor: never finer than 1 s (the data is 10 Hz; 1 s tactical snapshots are plenty). */
const MIN_BUCKET_MS = envCount('EVENTS_MIN_BUCKET_MS', 1000);
/** PM-2: per-bucket player cap (== the roster cap). The DB read path enforces no distinct-player cap, so this
 * bounds the per-bucket O(k²) spread + O(k log k) hull to ≤ ~4096 sync ops so a single bucket close can't stall
 * the loop. A NEW playerId beyond the cap in a bucket is dropped (an already-present one still updates). */
const EVENTS_MAX_PLAYERS_PER_BUCKET = envCount('EVENTS_MAX_PLAYERS_PER_BUCKET', 64);

// DoS: per-principal RATE bucket (this surface's own) + the SHARED scanLoad inflight slot (PM-1).
const EVENTS_RATE_BURST = envNumber('EVENTS_RATE_BURST', 20, { min: 1 });
const EVENTS_RATE_PER_MIN = envNumber('EVENTS_RATE_PER_MIN', 40, { min: 1 });
const RATE_WINDOW_MS = 60_000;

// ----- domain constants (§1.5) — PROPOSED heuristics, NOT spec; env-tunable; UNVALIDATED on real match data --
/** PM-6: detectors ignore buckets with fewer than this many present players (a thin-data fabrication guard:
 * one dropped-out child's track must not become a max-confidence "team" event). Relates to MIN_PLAYERS_FOR_HULL. */
const MIN_PLAYERS_FOR_EVENTS = envNumber('EVENTS_MIN_PLAYERS', 3, { min: 1 });
/** Hull needs ≥3 distinct vertices for a non-zero area (PM-S2). */
const MIN_PLAYERS_FOR_HULL = 3;
/** high_tempo: a run of buckets with hsrFraction ≥ this. */
const HIGH_TEMPO_FRACTION = envNumber('EVENTS_HIGH_TEMPO_FRACTION', 0.3, { min: 0, max: 1 });
const HIGH_TEMPO_MIN_S = envNumber('EVENTS_HIGH_TEMPO_MIN_S', 3.0, { min: 0 });
/** transition: centroid net displacement ≥ this over a ≤ window with the team actually moving. */
const TRANSITION_M = envNumber('EVENTS_TRANSITION_M', 20, { min: 0 });
const TRANSITION_WINDOW_S = envNumber('EVENTS_TRANSITION_WINDOW_S', 5.0, { min: 0.001 });
const TRANSITION_MIN_MEAN_MPS = envNumber('EVENTS_TRANSITION_MIN_MEAN_MPS', 2.0, { min: 0 });
/** stoppage: a run where the team is near-stationary AND the centroid barely moves. */
const STOPPAGE_SPEED_MPS = envNumber('EVENTS_STOPPAGE_SPEED_MPS', 0.5, { min: 0 });
const STOPPAGE_CENTROID_MAX_M = envNumber('EVENTS_STOPPAGE_CENTROID_MAX_M', 5, { min: 0 });
const STOPPAGE_MIN_S = envNumber('EVENTS_STOPPAGE_MIN_S', 8.0, { min: 0 });
/** Float-sum tolerance for duration/span comparisons (mirrors history.ts: a sum of 0.x s steps drifts). */
const SECONDS_EPS = 1e-6;

/** The resolved structural params shipped for provenance (PM-S6). One frozen object (env read once at load). */
const DETECTOR_PARAMS: DetectorParams = {
  highTempoFraction: HIGH_TEMPO_FRACTION,
  highTempoMinS: HIGH_TEMPO_MIN_S,
  transitionM: TRANSITION_M,
  transitionWindowS: TRANSITION_WINDOW_S,
  transitionMinMeanMps: TRANSITION_MIN_MEAN_MPS,
  stoppageSpeedMps: STOPPAGE_SPEED_MPS,
  stoppageCentroidMaxM: STOPPAGE_CENTROID_MAX_M,
  stoppageMinS: STOPPAGE_MIN_S,
  minPlayersForEvents: MIN_PLAYERS_FOR_EVENTS,
};

// ----- params (fail closed) --------------------------------------------------------------
export interface EventsParams {
  sessionId: string;
  from: number;
  to: number;
}

/** Param-validation failure the caller maps to an OPAQUE 400 — `reason` is a fixed code for the server log
 * ONLY, never echoing a query value (a misconfigured client could pass a name; §0.4 opaque errors). */
export class EventsParamError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'EventsParamError';
  }
}

export function validateEventsParams(raw: { sessionId: string; from?: unknown; to?: unknown }): EventsParams {
  const from = Number(raw.from);
  const to = Number(raw.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new EventsParamError('bad_window');
  if (to <= from) throw new EventsParamError('bad_window'); // to > from required
  if (to - from > EVENTS_MAX_SPAN_MS) throw new EventsParamError('span_too_large');
  return { sessionId: raw.sessionId, from, to };
}

// ----- geometry --------------------------------------------------------------------------
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Equirectangular metres between two lat/lon — cheap + good at pitch / centroid-step scale (== history.ts). */
function stepMetres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const meanLat = (((aLat + bLat) / 2) * Math.PI) / 180;
  const dLon = (((bLon - aLon) * Math.PI) / 180) * Math.cos(meanLat);
  return Math.hypot(dLat, dLon) * R;
}

/** Convex-hull area (m²) of local-plane points via monotone chain + |shoelace|/2 (PM-S2/S3). Returns 0 for
 * < 3 input points OR a degenerate (collinear/coincident) hull with < 3 distinct vertices. */
function hullArea(pts: Array<[number, number]>): number {
  if (pts.length < MIN_PLAYERS_FOR_HULL) return 0;
  // sort by x then y, drop exact duplicates (coincident players → fewer unique points).
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uniq: Array<[number, number]> = [];
  for (const p of sorted) {
    const last = uniq[uniq.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length < 3) return 0; // all coincident / only 2 distinct points
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  // drop each list's last point (it's the first of the other); collinear input → < 3 hull vertices → 0.
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return 0;
  let twiceSigned = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    twiceSigned += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceSigned) / 2; // absolute → winding-independent, never negative
}

interface BucketFix {
  lat: number;
  lon: number;
  spd: number;
}

/** Fold one bucket's present-player fixes into a TeamShapeBucket. n ≥ 1 (the caller only finalises non-empty
 * buckets) and ≤ EVENTS_MAX_PLAYERS_PER_BUCKET (PM-2), so the O(n²) spread is bounded. */
function finalizeBucket(ts: number, players: Map<string, BucketFix>, hsrMps: number): TeamShapeBucket {
  const n = players.size;
  let sumLat = 0;
  let sumLon = 0;
  let sumSpd = 0;
  let hsrN = 0;
  for (const f of players.values()) {
    sumLat += f.lat;
    sumLon += f.lon;
    sumSpd += f.spd;
    if (f.spd >= hsrMps) hsrN += 1;
  }
  const cLat = sumLat / n;
  const cLon = sumLon / n;
  // Project each player to local metres about the centroid (orientation-independent; no pitch-corner dep).
  const R = 6_371_000;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const local: Array<[number, number]> = [];
  for (const f of players.values()) {
    const x = (((f.lon - cLon) * Math.PI) / 180) * cosLat * R; // east metres
    const y = (((f.lat - cLat) * Math.PI) / 180) * R; // north metres
    local.push([x, y]);
  }
  let stretch = 0;
  for (const [x, y] of local) stretch += Math.hypot(x, y); // centroid is the local origin
  stretch /= n;
  let spread = 0;
  for (let i = 0; i < local.length; i++) {
    for (let j = i + 1; j < local.length; j++) {
      const d = Math.hypot(local[i][0] - local[j][0], local[i][1] - local[j][1]);
      if (d > spread) spread = d;
    }
  }
  return {
    ts,
    count: n,
    centroid: { lat: cLat, lon: cLon },
    stretchM: stretch,
    surfaceAreaM2: hullArea(local),
    spreadM: spread,
    meanSpeedMps: sumSpd / n,
    hsrFraction: hsrN / n,
  };
}

// ----- the read --------------------------------------------------------------------------
/** Yield between pages AND give the scan its one chance to stop (see history.ts's copy for the why). */
const yieldLoop = async (scan: ScanBudget): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  scan.check();
};

/**
 * Read a session's tactical events for the validated window, OFF the live loop: keyset-page over the raw trace
 * in EVENTS_SCAN_CHUNK pages, bucketing into adaptive time buckets and folding each into a bounded team-shape
 * series, `await`-yielding between pages. Then run the detectors over the bounded series (a cheap synchronous
 * post-pass, O(buckets) ≤ MAX_BUCKETS). NO playerId/name anywhere in the result.
 */
export async function readEvents(p: EventsParams, scan?: ScanBudget): Promise<EventsResult> {
  // Same ownership rule as readHistory: a budget we created is a budget we release (see its note).
  const own = scan === undefined ? newScanBudget() : null;
  const budget = scan ?? own!;
  const t0 = performance.now();
  try {
    const thresholds = thresholdsForSession(p.sessionId);
    const hsrMps = thresholds.hsrMps;
    const span = p.to - p.from;
    // Adaptive bucket size bounds the returned series to ≤ MAX_BUCKETS for ANY span (§1.2). Known up front.
    const bucketMs = Math.max(MIN_BUCKET_MS, Math.ceil(span / MAX_BUCKETS));

    const series: TeamShapeBucket[] = [];
    let scanned = 0;
    let curIdx = -1;
    let curTs = 0;
    let curMap: Map<string, BucketFix> | null = null;

    const closeBucket = (): void => {
      if (curMap && curMap.size > 0) series.push(finalizeBucket(curTs, curMap, hsrMps));
    };

    let afterTs = p.from - 1;
    let afterRowid = 0;
    for (;;) {
      const rows = readFixesPage(p.sessionId, p.from, p.to, afterTs, afterRowid, EVENTS_SCAN_CHUNK);
      if (rows.length === 0) break;
      scanned += rows.length;
      budget.noteRows(rows.length); // so an abort can still be audited for volume
      for (const r of rows) {
        // Rows ascend by (server_ts, rowid), so bucket index is monotonic non-decreasing: a higher index
        // closes the open bucket. Empty intermediate buckets are simply never created (skipped).
        const idx = Math.floor((r.serverTs - p.from) / bucketMs);
        if (idx !== curIdx) {
          closeBucket();
          curIdx = idx;
          curTs = p.from + idx * bucketMs;
          curMap = new Map();
        }
        const m = curMap as Map<string, BucketFix>;
        // PM-2: bound the per-bucket player map. A NEW playerId beyond the cap is dropped; an already-present
        // one still updates to its latest fix (last-write-wins == latest, since rows ascend in time).
        if (!m.has(r.playerId) && m.size >= EVENTS_MAX_PLAYERS_PER_BUCKET) continue;
        const spd = typeof r.spd === 'number' ? r.spd : 0; // PM-N2: stored rows always have spd; coerce defensively
        m.set(r.playerId, { lat: r.lat, lon: r.lon, spd });
      }
      const last = rows[rows.length - 1];
      afterTs = last.serverTs;
      afterRowid = last.rowid;
      if (rows.length < EVENTS_SCAN_CHUNK) break;
      await yieldLoop(budget); // yield the live loop between pages (the §5 SLO depends on this)
    }
    // PM-3: flush the final open bucket — close-on-index-advance never closes the last one (mirrors the
    // history.ts scan-end flush). Without this the end-of-window bucket is silently dropped.
    closeBucket();

    metrics.eventsRowsScanned.inc({}, scanned);
    const events = detectEvents(series, bucketMs);
    return {
      sessionId: p.sessionId,
      from: p.from,
      to: p.to,
      scannedRows: scanned,
      bucketMs,
      ageBand: ageBandFor(p.sessionId),
      thresholds: { hsrMps: thresholds.hsrMps, sprintMps: thresholds.sprintMps },
      detectorParams: DETECTOR_PARAMS,
      series,
      events,
    };
  } finally {
    metrics.eventsReadSeconds.observe({}, (performance.now() - t0) / 1000);
  }
}

// ----- detectors (over the bounded in-memory series; O(buckets)) -------------------------
/** A bucket can be a detector INPUT only if ≥ MIN_PLAYERS_FOR_EVENTS players are present (PM-6). */
const participates = (b: TeamShapeBucket): boolean => b.count >= MIN_PLAYERS_FOR_EVENTS;
/** Two emitted buckets are consecutive iff exactly one bucketMs apart — a skipped (empty) bucket breaks a run
 * (PM-5) so an event never spans a data hole. */
const consecutive = (prev: TeamShapeBucket, cur: TeamShapeBucket, bucketMs: number): boolean =>
  cur.ts - prev.ts === bucketMs;

export function detectEvents(series: TeamShapeBucket[], bucketMs: number): TacticalEvent[] {
  const out = [
    ...detectHighTempo(series, bucketMs),
    ...detectTransition(series, bucketMs),
    ...detectStoppage(series, bucketMs),
  ];
  out.sort((a, b) => a.fromTs - b.fromTs);
  return out;
}

/** Generic "run of consecutive participating buckets that all qualify" → an event when the run is ≥2 buckets
 * AND spans ≥ minS (PM-4: durationS = runLength · bucketMs / 1000; each qualifying bucket contributes its full
 * width, so 3×1 s buckets = 3.0 s). Used by high_tempo (stoppage adds a centroid-step continuity rule). */
function detectRun(
  series: TeamShapeBucket[],
  bucketMs: number,
  qualifies: (b: TeamShapeBucket) => boolean,
  minS: number,
  make: (run: TeamShapeBucket[]) => TacticalEvent,
): TacticalEvent[] {
  const out: TacticalEvent[] = [];
  let run: TeamShapeBucket[] = [];
  const flush = (): void => {
    if (run.length >= 2 && (run.length * bucketMs) / 1000 >= minS - SECONDS_EPS) out.push(make(run));
    run = [];
  };
  for (const b of series) {
    if (!participates(b) || !qualifies(b)) {
      flush();
      continue;
    }
    if (run.length === 0 || consecutive(run[run.length - 1], b, bucketMs)) {
      run.push(b);
    } else {
      flush(); // a data gap broke the run (PM-5); this bucket starts a fresh one
      run = [b];
    }
  }
  flush();
  return out;
}

function detectHighTempo(series: TeamShapeBucket[], bucketMs: number): TacticalEvent[] {
  return detectRun(
    series,
    bucketMs,
    (b) => b.hsrFraction >= HIGH_TEMPO_FRACTION,
    HIGH_TEMPO_MIN_S,
    (run) => {
      let peak = 0;
      let minCount = Infinity;
      for (const b of run) {
        if (b.hsrFraction > peak) peak = b.hsrFraction;
        if (b.count < minCount) minCount = b.count;
      }
      return {
        type: 'high_tempo',
        fromTs: run[0].ts,
        toTs: run[run.length - 1].ts + bucketMs,
        confidence: clamp01(peak),
        minCount,
        peakHsrFraction: peak,
      };
    },
  );
}

/** stoppage: a run where the team is near-stationary AND its centroid barely moves between CONSECUTIVE buckets
 * (PM-5: a gap OR a too-large centroid step breaks the run). Gated by the participation floor (PM-6/PM-S7). */
function detectStoppage(series: TeamShapeBucket[], bucketMs: number): TacticalEvent[] {
  const out: TacticalEvent[] = [];
  let run: TeamShapeBucket[] = [];
  const flush = (): void => {
    if (run.length >= 2 && (run.length * bucketMs) / 1000 >= STOPPAGE_MIN_S - SECONDS_EPS) {
      let spdSum = 0;
      let minCount = Infinity;
      for (const b of run) {
        spdSum += b.meanSpeedMps;
        if (b.count < minCount) minCount = b.count;
      }
      const meanSpd = spdSum / run.length;
      out.push({
        type: 'stoppage',
        fromTs: run[0].ts,
        toTs: run[run.length - 1].ts + bucketMs,
        confidence: clamp01(1 - meanSpd / STOPPAGE_SPEED_MPS),
        minCount,
        meanSpeedMps: meanSpd,
      });
    }
    run = [];
  };
  for (const b of series) {
    if (!participates(b) || b.meanSpeedMps >= STOPPAGE_SPEED_MPS) {
      flush();
      continue;
    }
    if (run.length === 0) {
      run = [b];
      continue;
    }
    const prev = run[run.length - 1];
    const centroidStep = stepMetres(prev.centroid.lat, prev.centroid.lon, b.centroid.lat, b.centroid.lon);
    if (consecutive(prev, b, bucketMs) && centroidStep < STOPPAGE_CENTROID_MAX_M) {
      run.push(b);
    } else {
      flush(); // a data gap OR the centroid moved too far → this isn't one continuous stoppage
      run = [b];
    }
  }
  flush();
  return out;
}

/** transition: within a maximal consecutive participating segment, a sliding ≤ TRANSITION_WINDOW_S window whose
 * centroid net displacement ≥ TRANSITION_M with the team actually moving (window-mean speed ≥ the floor) and
 * spanning ≥ 2 buckets (PM-S4). Non-overlapping: after emitting at i, the window restarts past i. */
function detectTransition(series: TeamShapeBucket[], bucketMs: number): TacticalEvent[] {
  const out: TacticalEvent[] = [];

  const scanSegment = (s: TeamShapeBucket[]): void => {
    let j = 0;
    for (let i = 1; i < s.length; i++) {
      // shrink the window from the left to keep its span ≤ TRANSITION_WINDOW_S
      while (j < i && s[i].ts - s[j].ts > TRANSITION_WINDOW_S * 1000 + SECONDS_EPS) j++;
      // PM-S4: the displacement must accrue over ≥ 2 consecutive bucket STEPS (≥ 3 buckets), so a single noisy
      // 1-step centroid jump (a couple of players' fixes momentarily diverging) can never emit a transition.
      if (i - j < 2) continue;
      const shift = stepMetres(s[j].centroid.lat, s[j].centroid.lon, s[i].centroid.lat, s[i].centroid.lon);
      if (shift < TRANSITION_M) continue;
      let spdSum = 0;
      let minCount = Infinity;
      for (let k = j; k <= i; k++) {
        spdSum += s[k].meanSpeedMps;
        if (s[k].count < minCount) minCount = s[k].count;
      }
      if (spdSum / (i - j + 1) < TRANSITION_MIN_MEAN_MPS) continue; // the team must actually be moving
      out.push({
        type: 'transition',
        fromTs: s[j].ts,
        toTs: s[i].ts + bucketMs,
        confidence: clamp01(shift / (2 * TRANSITION_M)),
        minCount,
        centroidShiftM: shift,
      });
      j = i + 1; // non-overlapping: restart the window after this transition
    }
  };

  // Split the series into maximal runs of consecutive participating buckets, then scan each for transitions.
  let seg: TeamShapeBucket[] = [];
  const flushSeg = (): void => {
    if (seg.length >= 2) scanSegment(seg);
    seg = [];
  };
  for (const b of series) {
    if (!participates(b)) {
      flushSeg();
      continue;
    }
    if (seg.length === 0 || consecutive(seg[seg.length - 1], b, bucketMs)) {
      seg.push(b);
    } else {
      flushSeg(); // PM-5: a data gap ends the segment
      seg = [b];
    }
  }
  flushSeg();
  return out;
}

// ----- DoS gate: per-principal token bucket + the SHARED inflight slot (PM-1) -------------
const principalBuckets = new Map<string, { tokens: number; last: number }>();

function sweepBuckets(now: number): void {
  for (const [k, b] of principalBuckets) {
    if (now - b.last > 2 * RATE_WINDOW_MS) principalBuckets.delete(k);
  }
}

function rateOk(principalKey: string): boolean {
  const now = Date.now();
  if (principalBuckets.size > 0 && Math.random() < 0.01) sweepBuckets(now);
  let b = principalBuckets.get(principalKey);
  if (!b) {
    b = { tokens: EVENTS_RATE_BURST, last: now };
    principalBuckets.set(principalKey, b);
  }
  b.tokens = Math.min(EVENTS_RATE_BURST, b.tokens + ((now - b.last) / RATE_WINDOW_MS) * EVENTS_RATE_PER_MIN);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export type GateResult = { ok: true } | { ok: false; result: 'rate_limited' | 'busy' };

/**
 * Admission control, run by server.ts AFTER authz and BEFORE any DB work. Per-principal rate bucket FIRST
 * (a throttled client doesn't even take a scan slot), then the SHARED scanLoad inflight slot (PM-1) so history
 * + events together can't exceed the loop-protection bound. On ok the caller MUST releaseEventsInflight() in a
 * `finally`. Keyed on the principal (or anon-IP) so one caller can never starve another.
 */
export function eventsGate(principalKey: string): GateResult {
  if (!rateOk(principalKey)) return { ok: false, result: 'rate_limited' };
  // Same two bounds as /history — they share the counter (PM-1) and the per-principal share.
  if (!acquireScanSlot(principalKey)) return { ok: false, result: 'busy' };
  return { ok: true };
}

/** Release the shared scan slot taken by a successful eventsGate(). Pair in a `finally`. */
export function releaseEventsInflight(principalKey: string): void {
  releaseScanSlot(principalKey);
}

export { EVENTS_MAX_SPAN_MS, EVENTS_SCAN_CHUNK, MAX_BUCKETS, MIN_BUCKET_MS, EVENTS_MAX_PLAYERS_PER_BUCKET, MIN_PLAYERS_FOR_EVENTS };
