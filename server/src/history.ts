/**
 * Review/replay history reads (ADR-0017, contract §3.1) — the most sensitive read in the
 * system: raw 10 Hz location of children, served OFF the shared live loop.
 *
 * THREAT MODEL: this is a bulk-export surface for minors' location. Everything here is
 * security-first and bounded — a stolen 12h cookie can be made to drain the store, so the
 * caller (server.ts) gates each request with the §0.4 authz posture + the two DoS controls
 * this module owns (`historyGate`: a per-principal token bucket + a global inflight cap) and
 * an audit log line. This module additionally bounds the READ itself: a span cap on the
 * window, keyset paging that yields the event loop between chunks (so a 540k-row match can't
 * freeze every live tablet mid-match — exactly the failure ADR-0017 exists to prevent), and
 * a hard cap on the raw-page size. NO child name appears in any param, result, log, or metric
 * (§0.1) — the trace is pseudonymous; the client joins the roster (§1.5) at render.
 *
 * Single-threaded keyset paging (ADR-0017 sanctioned) is chosen over a worker thread: WAL
 * already lets the one connection read concurrently with its own writes, and `history.ts` is
 * the boundary that keeps a future worker-thread swap local if the §5 SLO ever fails.
 */

import { readFixesPage, type FixRow } from './db';
import { envInt, envNumber } from './env';
import { ageBandFor, thresholdsForSession } from './sessionConfig';
import type { AgeBand, ZoneThresholds } from './types';
import { acquireScanSlot, releaseScanSlot, _scanInflight, newScanBudget, type ScanBudget } from './scanLoad';
import { metrics } from './metrics';
import { log } from './log';

// ----- config (env) — bounds on the scan + the DoS controls -----------------------------
const DAY_MS = 86_400_000;
/** Max query window: bounds how much of the raw trace one request can scan. Default 24h. */
const HISTORY_MAX_SPAN_MS = envNumber('HISTORY_MAX_SPAN_MS', DAY_MS, { min: 1, max: 7 * DAY_MS }); // max 7 d: the S-3 '10-year export'
/** Rows per keyset page. Default 1000 ≈ a ~1–2 ms synchronous hold ≈ the 50p×10Hz fan-out
 * interval, so a page never burst-starves live fan-out; we await-yield between pages. The §5
 * SLO test is the gate — if it fails, drop this further (env-overridable) or go to a worker. */
const HISTORY_SCAN_CHUNK = envInt('HISTORY_SCAN_CHUNK', 1000, { min: 1 });
/** Default + hard-max page size for a raw replay request (one page per call). */
const HISTORY_RAW_LIMIT_DEFAULT = 2000;
const HISTORY_RAW_LIMIT_MAX = 10_000;
/** Occupancy heatmap grid — bins only, NO per-bin identity (§3.1). */
const HEATMAP_COLS = 32;
const HEATMAP_ROWS = 20;

// DoS controls (mirror auth.ts: a global inflight cap + per-principal token buckets). PM-1: the inflight cap is
// now the SHARED scanLoad slot (history + events combined), so concurrent off-loop scans across BOTH surfaces
// can't gang up past the loop-protection bound. The per-principal RATE bucket below stays history-local.
const HISTORY_RATE_BURST = envNumber('HISTORY_RATE_BURST', 30, { min: 1 });
const HISTORY_RATE_PER_MIN = envNumber('HISTORY_RATE_PER_MIN', 60, { min: 1 });
const RATE_WINDOW_MS = 60_000; // the per-minute refill window the bucket measures against

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/; // playerId shares the session-id charset bound

// ----- Phase 4 coaching-metric constants (metric-definitions.md, contract §1) ------------
// These are domain rules, NOT tunables — transcribed from the spec, do NOT "round" them.
/** §2.1 distance gate: accumulate a step ONLY when v ≥ this walking floor (else GNSS jitter manufactures
 * phantom distance). Applies to base distanceM, every zoneDistanceM bin, AND sprintDistanceM — same base. */
const WALK_FLOOR_MPS = 0.4;
/** §2.1 distance gate: a step is dropped when pdop EXCEEDS this (poor geometry). pdop==null ⇒ pass (older
 * rows / unmetered). `fix ≥ 2` is the third gate clause but is guaranteed at ingest (fix<2 never persists),
 * so the server gate reduces to v≥0.4 AND pdop≤5 — equivalent to the client's three-clause live gate. */
const PDOP_MAX = 5;
/** §3.4 a sprint EFFORT must stay above the band's Sprint threshold for ≥ this many seconds (≥10 samples). */
const SPRINT_MIN_SECONDS = 1.0;
/** Float-sum tolerance for the duration/gap thresholds: durations accumulate Δt = Δms/1000, and a sum of
 *  0.1 s steps drifts (10 × 0.1 = 0.9999999999999999 < 1.0). Comparing against `MIN − EPS` makes the exact
 *  N-sample boundary count deterministically (a genuinely-short run — e.g. 9 samples = 0.8 s — is still well
 *  below `MIN − EPS`, so this never accepts a too-short effort). EPS ≪ one 10 Hz sample (0.1 s). */
const SECONDS_EPS = 1e-6;
/** §4.1/§4.2 accel-decel bands (m/s²) on SMOOTHED v: |a| ≥ Mod / ≥ High, per direction. */
const ACCEL_MOD_MPS2 = 2.0;
const ACCEL_HIGH_MPS2 = 3.0;
/** §2.3 clamp: |a| beyond this is a GNSS artefact, not a human acceleration. */
const ACCEL_CLAMP_MPS2 = 8;
/** §4.2 an accel/decel effort must be sustained ≥ this (≥3 samples); efforts within this gap merge. */
const EFFORT_MIN_SECONDS = 0.3;
/** §4 trailing causal moving-average window for smoothing v (a centred filter needs lookahead the
 * forward-only keyset scan cannot provide; the trailing average is the standard GPS-streaming substitute). */
const SMOOTH_WINDOW = 5;

/**
 * Classify a speed (m/s) into a 1–5 speed zone via the §1 descending `>=` cascade. Half-open intervals: a
 * speed EXACTLY at a threshold lands in the HIGHER zone. This is the IDENTICAL cascade the client `speedZone`
 * uses, so the live colour and this review breakdown can never disagree at a boundary (a hard §1 requirement).
 */
function zoneOf(v: number, t: ZoneThresholds): 0 | 1 | 2 | 3 | 4 {
  // returns a 0-based bin index for zoneDistanceM[5]: 0=Z1 walk … 4=Z5 sprint
  if (v >= t.sprintMps) return 4;
  if (v >= t.hsrMps) return 3;
  if (v >= t.runMps) return 2;
  if (v >= t.jogMps) return 1;
  return 0;
}

// ----- params + result shapes -----------------------------------------------------------
export type HistoryMode = 'aggregate' | 'raw';

/** Validated, internal query params. `player`/`cursor*` only meaningful for mode=raw. */
export interface HistoryParams {
  sessionId: string;
  from: number;
  to: number;
  mode: HistoryMode;
  player?: string;
  cursorTs?: number;
  cursorRowid?: number;
  limit?: number;
}

/** Sprint efforts (§3.4): count of ≥1.0 s above-threshold runs, distance accumulated while above, peak speed. */
export interface SprintAgg {
  count: number;
  distanceM: number;
  maxSpeedMps: number;
}

/** Accel/decel effort counts (§4), per band per direction — GPS-derived, a trend estimate not lab-grade. */
export interface EffortAgg {
  accelMod: number;
  accelHigh: number;
  decelMod: number;
  decelHigh: number;
}

export interface PlayerAggregate {
  playerId: string;
  fixes: number;
  firstTs: number;
  lastTs: number;
  /** Total distance, GATED by §1 (v≥0.4 AND pdop≤5; fix≥2 guaranteed at ingest) — phantom-jitter-free. */
  distanceM: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  /** Distance per speed zone (m), index 0=Z1 walk … 4=Z5 sprint; Σ equals the gated distanceM. */
  zoneDistanceM: number[];
  /** Sprint efforts (§3.4). */
  sprint: SprintAgg;
  /** Accel/decel effort counts (§4). */
  effort: EffortAgg;
  /** distanceM / max(1, sessionMinutes) — volume rate over the GATED distance (§2.1 + per-min pattern). */
  distancePerMin: number;
}

export interface AggregateResult {
  sessionId: string;
  from: number;
  to: number;
  scannedRows: number;
  /** Provenance: the age band whose thresholds the zone/sprint metrics above were computed against (§1). */
  ageBand: AgeBand;
  players: PlayerAggregate[];
  /**
   * Occupancy counts only — a lat/lon grid scaled to `bbox` (the scan's overall extent), so the client can
   * map each bin back to GPS → pixels. `bbox` is null for an empty / degenerate (single-point) scan, in which
   * case the all-zero grid is drawn as nothing. NO names, NO per-bin playerId.
   */
  heatmap: {
    cols: number;
    rows: number;
    bins: number[];
    bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  };
}

export interface RawFix {
  serverTs: number;
  lat: number;
  lon: number;
  spd: number | null;
  hdg: number | null;
}

export interface RawResult {
  sessionId: string;
  playerId: string;
  from: number;
  to: number;
  scannedRows: number;
  fixes: RawFix[];
  /** Composite resume cursor; null on the last page (fewer than `limit` rows). */
  nextCursor: { serverTs: number; rowid: number } | null;
}

/**
 * Param-validation failure the caller (server.ts) maps to 400 `{error:'bad_params'}`. The
 * `reason` is for the server's OWN structured log only and is a fixed code — it MUST NOT carry
 * the offending value (a misconfigured client could pass a name as `player`; §3.1 opaque errors).
 */
export class HistoryParamError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'HistoryParamError';
  }
}

// ----- param validation (fail closed; reject out-of-range with a typed error) -----------
/**
 * Validate + normalise raw query params into HistoryParams, THROWING HistoryParamError on any
 * out-of-range input. The caller has already validated `sessionId` shape via authz, but we
 * re-bound everything else here so history.ts is safe to unit-test in isolation. NO value is
 * echoed back in the thrown reason — only fixed codes (§3.1).
 */
export function validateHistoryParams(raw: {
  sessionId: string;
  from?: unknown;
  to?: unknown;
  mode?: unknown;
  player?: unknown;
  cursor_ts?: unknown;
  cursor_rowid?: unknown;
  limit?: unknown;
}): HistoryParams {
  const from = Number(raw.from);
  const to = Number(raw.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new HistoryParamError('bad_window');
  if (to <= from) throw new HistoryParamError('bad_window'); // to > from required
  if (to - from > HISTORY_MAX_SPAN_MS) throw new HistoryParamError('span_too_large');

  const mode: HistoryMode =
    raw.mode === undefined || raw.mode === 'aggregate'
      ? 'aggregate'
      : raw.mode === 'raw'
        ? 'raw'
        : (() => {
            throw new HistoryParamError('bad_mode');
          })();

  if (mode === 'aggregate') {
    return { sessionId: raw.sessionId, from, to, mode };
  }

  // mode=raw: a single playerId is REQUIRED; cursor params are composite (both-or-neither).
  if (typeof raw.player !== 'string' || !SESSION_ID_RE.test(raw.player)) {
    throw new HistoryParamError('bad_player');
  }
  const hasTs = raw.cursor_ts !== undefined && raw.cursor_ts !== '';
  const hasRowid = raw.cursor_rowid !== undefined && raw.cursor_rowid !== '';
  if (hasTs !== hasRowid) throw new HistoryParamError('bad_cursor'); // both-or-neither (§3.1)
  let cursorTs: number | undefined;
  let cursorRowid: number | undefined;
  if (hasTs) {
    cursorTs = Number(raw.cursor_ts);
    cursorRowid = Number(raw.cursor_rowid);
    if (!Number.isFinite(cursorTs) || !Number.isInteger(cursorRowid) || cursorRowid < 0) {
      throw new HistoryParamError('bad_cursor');
    }
  }
  let limit = HISTORY_RAW_LIMIT_DEFAULT;
  if (raw.limit !== undefined && raw.limit !== '') {
    const n = Number(raw.limit);
    if (!Number.isInteger(n) || n < 1) throw new HistoryParamError('bad_limit');
    limit = Math.min(n, HISTORY_RAW_LIMIT_MAX); // clamp to the hard max, don't reject
  }
  return { sessionId: raw.sessionId, from, to, mode, player: raw.player, cursorTs, cursorRowid, limit };
}

// ----- the read --------------------------------------------------------------------------
/**
 * Surrender the loop between pages — AND, since Phase 6, the one place a scan can be told to stop.
 * The check lives inside the yield helper deliberately: every paged loop here already has to call it,
 * so cancellation cannot be forgotten at a new loop the way a separate `if (aborted) break` would be.
 */
const yieldLoop = async (scan: ScanBudget): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  scan.check(); // throws ScanAborted: client gone, wall-clock budget spent, or the server is shutting down
};

/** Equirectangular metres between two lat/lon — cheap + good enough for a pitch-scale step. */
function stepMetres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const meanLat = (((aLat + bLat) / 2) * Math.PI) / 180;
  const dLon = (((bLon - aLon) * Math.PI) / 180) * Math.cos(meanLat);
  return Math.hypot(dLat, dLon) * R;
}

/**
 * Read a session's history for the validated window, OFF the live loop: keyset-page over the
 * raw trace in HISTORY_SCAN_CHUNK-sized pages, accumulating in JS and `await`-yielding between
 * pages (like retention.purgeOlderThan) so live ingest/fan-out is never frozen.
 *
 * `mode=aggregate` → per-player stats + an occupancy heatmap (small, age-appropriate default).
 * `mode=raw`       → ONE page of fixes + a composite nextCursor (raw replay, on demand).
 *
 * Observes ft_history_read_seconds{mode} + ft_history_rows_scanned_total{mode}. NO displayName
 * anywhere in the result (pseudonymous; client joins the roster at render).
 */
export async function readHistory(
  p: HistoryParams,
  scan?: ScanBudget,
): Promise<AggregateResult | RawResult> {
  // A caller that passes no budget still gets one (the wall-clock bound is not optional) — but WE own it
  // and WE release it. As a default parameter it registered itself in scanLoad's live set and nothing
  // ever removed it, so every such call leaked an entry and `_liveScanBudgets()` — the seam whose whole
  // purpose is leak detection — could never be used as a guard, because the tests leaked into it.
  const own = scan === undefined ? newScanBudget() : null;
  const budget = scan ?? own!;
  const t0 = performance.now();
  try {
    return p.mode === 'raw' ? await readRaw(p, budget) : await readAggregate(p, budget);
  } finally {
    own?.release();
    metrics.historyReadSeconds.observe({ mode: p.mode }, (performance.now() - t0) / 1000);
  }
}

/** mode=raw: one bounded page resumed by the composite cursor; never `.all()` a match. */
async function readRaw(p: HistoryParams, scan: ScanBudget): Promise<RawResult> {
  const player = p.player as string;
  const limit = p.limit ?? HISTORY_RAW_LIMIT_DEFAULT;
  // First page: start strictly before the window so no real fix is skipped. Subsequent pages
  // resume after the caller's composite cursor (server.ts threads cursor_ts/cursor_rowid back in).
  let afterTs = p.cursorTs ?? p.from - 1;
  let afterRowid = p.cursorRowid ?? 0;

  const fixes: RawFix[] = [];
  // We carry the (serverTs, rowid) of the LAST kept fix so the resume cursor is exact — the DB
  // rowid, never a guessed 0 — so the next page can never dup or skip a row that shares an ms.
  let lastKeptTs = 0;
  let lastKeptRowid = 0;
  let scanned = 0;
  let windowExhausted = false;

  // Page over the index in HISTORY_SCAN_CHUNK steps until we have `limit` of THIS player's rows
  // or the window runs out. The WHERE has no player predicate (the index leads on session_id), so
  // we filter player-side here and keep paging — at fix-row granularity the cursor stays exact.
  while (fixes.length < limit) {
    const rows = readFixesPage(p.sessionId, p.from, p.to, afterTs, afterRowid, HISTORY_SCAN_CHUNK);
    scanned += rows.length;
    scan.noteRows(rows.length); // so an abort can still be audited for volume
    if (rows.length === 0) {
      windowExhausted = true; // no more rows in the window at all
      break;
    }
    for (const r of rows) {
      if (r.playerId !== player) continue;
      if (fixes.length >= limit) break; // full — stop keeping, the cursor is the last kept row
      fixes.push({ serverTs: r.serverTs, lat: r.lat, lon: r.lon, spd: r.spd, hdg: r.hdg });
      lastKeptTs = r.serverTs;
      lastKeptRowid = r.rowid;
    }
    const last = rows[rows.length - 1];
    afterTs = last.serverTs;
    afterRowid = last.rowid;
    if (rows.length < HISTORY_SCAN_CHUNK) {
      windowExhausted = true; // a short page is the last page of the window — we're done, no need to yield
      break;
    }
    // Yield AFTER every full page — including a page-aligned final page — BEFORE the limit-break, so a
    // page-aligned tail can never run a full synchronous page without surrendering the loop (matches the
    // aggregate scan + buildHeatmapPaged; keeps the ~1–2 ms/page SLO honest).
    await yieldLoop(scan);
    if (fixes.length >= limit) break; // page boundary and we already have a full page of fixes
  }

  metrics.historyRowsScanned.inc({ mode: 'raw' }, scanned);
  // nextCursor is null IFF we exhausted the window without filling the page — i.e. there is no
  // further row for this player. Otherwise it is the exact (serverTs, rowid) of the last kept fix,
  // so `?cursor_ts=&cursor_rowid=` resumes UNAMBIGUOUSLY (a scalar ts cursor would dup/skip ties).
  const nextCursor =
    windowExhausted && fixes.length < limit
      ? null
      : fixes.length > 0
        ? { serverTs: lastKeptTs, rowid: lastKeptRowid }
        : null;
  return { sessionId: p.sessionId, playerId: player, from: p.from, to: p.to, scannedRows: scanned, fixes, nextCursor };
}

/**
 * Per-band accel/decel effort detector (§4) — one per {direction × band} so a single sustained crossing of a
 * nested band trips both its detectors independently (the metric-definitions example reports moderate + high as
 * nested counts). State machine on the SMOOTHED-velocity acceleration stream, using REAL Δt so dropped fixes
 * don't fabricate a sustained run: an effort counts once its in-band duration reaches EFFORT_MIN_SECONDS; a dip
 * out of band shorter than EFFORT_MIN_SECONDS MERGES (same effort, no recount), a longer dip closes it.
 */
interface BandDetector {
  inBand: boolean; // was the previous sample in this band's |a| range
  runDur: number; // seconds of accumulated in-band time for the current (possibly merged) effort
  gapDur: number; // seconds out of band since leaving it (for the <0.3 s merge window)
  counted: boolean; // has the current effort already incremented the counter (don't double-count on merge)
  count: number; // efforts counted for this {direction × band}
}
function newBand(): BandDetector {
  return { inBand: false, runDur: 0, gapDur: 0, counted: false, count: 0 };
}

/** First-pass per-player accumulator. The per-player effort state machines live HERE (keyed by playerId) so the
 * globally-interleaved scan order never mixes one player's velocity ring / run state into another's (§1/§4). */
interface Acc {
  fixes: number;
  firstTs: number;
  lastTs: number;
  distanceM: number; // GATED total distance
  speedSum: number;
  speedN: number;
  maxSpeedMps: number;
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
  prevLat: number | null;
  prevLon: number | null;
  prevTs: number | null; // serverTs of the previous row, for real Δt
  zoneDistanceM: number[]; // [5] — distance per zone, same gated step as distanceM
  // sprint run state (§3.4)
  sprintInRun: boolean;
  sprintRunDur: number; // Σ Δt while above threshold in the current run
  sprintRunDist: number; // gated distance accumulated while above threshold in the current run
  sprintRunMax: number; // peak speed in the current run
  sprintGapDur: number; // Σ Δt of sub-threshold samples since the last above-threshold one (the merge gap, §3.4 cl.3)
  sprintCount: number;
  sprintDistanceM: number; // total over all counted runs
  sprintMaxSpeedMps: number; // peak over all counted runs
  // accel/decel state (§4): trailing velocity ring + smoothed-accel band detectors
  ring: number[]; // trailing ≤SMOOTH_WINDOW raw speeds (oldest→newest)
  prevSmoothed: number | null; // ṽ of the previous row
  accelMod: BandDetector;
  accelHigh: BandDetector;
  decelMod: BandDetector;
  decelHigh: BandDetector;
}

/** mode=aggregate: scan the whole window once, fold into per-player stats + an occupancy grid. */
async function readAggregate(p: HistoryParams, scan: ScanBudget): Promise<AggregateResult> {
  // The session's resolved youth thresholds (§3.2) — the SAME band the live colour uses, fetched ONCE for the
  // whole scan (the band can't change mid-scan; a periodic reload only affects the NEXT request). Zone + sprint
  // metrics classify against these, so the review breakdown can never disagree with the live colour at a boundary.
  const thresholds = thresholdsForSession(p.sessionId);
  const sprintMps = thresholds.sprintMps;
  // First pass accumulator per player; bbox of the whole scan drives the heatmap grid scaling.
  const accs = new Map<string, Acc>();
  let scanned = 0;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  // The heatmap needs the final scan bbox to scale its grid, which is only known AFTER the scan. Rather than
  // buffer every (lat,lon) (O(total_rows) memory + a synchronous binning hold that could reach hundreds of MB
  // / hundreds of ms at the 24h span cap — defeating the very SLO the paging protects), we do a SECOND paged
  // pass below (buildHeatmapPaged) that re-reads + bins with the same yields. O(1) extra memory, unbiased.
  let afterTs = p.from - 1;
  let afterRowid = 0;
  for (;;) {
    const rows = readFixesPage(p.sessionId, p.from, p.to, afterTs, afterRowid, HISTORY_SCAN_CHUNK);
    if (rows.length === 0) break;
    scanned += rows.length;
    scan.noteRows(rows.length); // so an abort can still be audited for volume
    for (const r of rows) {
      foldRow(accs, r, thresholds, sprintMps);
      if (r.lat < minLat) minLat = r.lat;
      if (r.lat > maxLat) maxLat = r.lat;
      if (r.lon < minLon) minLon = r.lon;
      if (r.lon > maxLon) maxLon = r.lon;
    }
    const last = rows[rows.length - 1];
    afterTs = last.serverTs;
    afterRowid = last.rowid;
    if (rows.length < HISTORY_SCAN_CHUNK) break;
    await yieldLoop(scan); // yield the live loop between pages
  }

  // Scan-end flush (§4.1, REQUIRED): a player sprinting through the window's end has an in-progress run that
  // never saw its closing sub-threshold sample. Flush every Acc's in-progress run, counting it IFF its
  // accumulated above-threshold duration already reached SPRINT_MIN_SECONDS. (Accel/decel needs no flush: an
  // open band-run is only ever counted ONCE the moment it reaches EFFORT_MIN_SECONDS — already done in-loop.)
  for (const a of accs.values()) flushSprint(a);

  const players: PlayerAggregate[] = [];
  for (const [playerId, a] of accs) {
    // distancePerMin over the GATED distanceM; max(1, minutes) guards a single-fix / sub-minute window from
    // dividing by ~0 and producing a meaningless spike (§2.1 + the per-min pattern).
    const minutes = Math.max(1, (a.lastTs - a.firstTs) / 60_000);
    players.push({
      playerId,
      fixes: a.fixes,
      firstTs: a.firstTs,
      lastTs: a.lastTs,
      distanceM: a.distanceM,
      avgSpeedMps: a.speedN > 0 ? a.speedSum / a.speedN : 0,
      maxSpeedMps: a.maxSpeedMps,
      bbox: { minLat: a.minLat, minLon: a.minLon, maxLat: a.maxLat, maxLon: a.maxLon },
      zoneDistanceM: a.zoneDistanceM,
      sprint: { count: a.sprintCount, distanceM: a.sprintDistanceM, maxSpeedMps: a.sprintMaxSpeedMps },
      effort: {
        accelMod: a.accelMod.count,
        accelHigh: a.accelHigh.count,
        decelMod: a.decelMod.count,
        decelHigh: a.decelHigh.count,
      },
      distancePerMin: a.distanceM / minutes,
    });
  }

  const heatmap = await buildHeatmapPaged(p, minLat, minLon, maxLat, maxLon, scan);
  metrics.historyRowsScanned.inc({ mode: 'aggregate' }, scanned);
  // Top-level ageBand is the SAME provenance the thresholds came from (band-or-U14-default) — so the client
  // can show which thresholds the metrics were scored against (§4.1/§4.2). NO names anywhere in this result.
  return {
    sessionId: p.sessionId,
    from: p.from,
    to: p.to,
    scannedRows: scanned,
    ageBand: ageBandFor(p.sessionId),
    players,
    heatmap,
  };
}

/**
 * Fold one raw row into its player's running aggregate. O(1) per row (a fixed-size ring + a handful of scalar
 * state machines) so the existing single paged scan stays within the §3 loop budget — no second scan, no extra
 * synchronous hold. Rows arrive globally in (server_ts, rowid) order, so within ANY one playerId they are in
 * order too (the per-player state is keyed in `accs`, never crossed between players).
 *
 * Computes ONE gated `step` per row, reused by both distanceM and the zone bin so distancePerMin and Σ
 * zoneDistanceM agree exactly. Drives the sprint run state machine (§3.4) and the accel/decel band detectors
 * (§4) on a trailing-causal smoothed velocity, all with REAL Δt from serverTs (a dropped fix must not inflate
 * speed/accel — §0/§2).
 */
function foldRow(accs: Map<string, Acc>, r: FixRow, t: ZoneThresholds, sprintMps: number): void {
  let a = accs.get(r.playerId);
  if (!a) {
    a = {
      fixes: 0,
      firstTs: r.serverTs,
      lastTs: r.serverTs,
      distanceM: 0,
      speedSum: 0,
      speedN: 0,
      maxSpeedMps: 0,
      minLat: r.lat,
      minLon: r.lon,
      maxLat: r.lat,
      maxLon: r.lon,
      prevLat: null,
      prevLon: null,
      prevTs: null,
      zoneDistanceM: [0, 0, 0, 0, 0],
      sprintInRun: false,
      sprintRunDur: 0,
      sprintRunDist: 0,
      sprintRunMax: 0,
      sprintGapDur: 0,
      sprintCount: 0,
      sprintDistanceM: 0,
      sprintMaxSpeedMps: 0,
      ring: [],
      prevSmoothed: null,
      accelMod: newBand(),
      accelHigh: newBand(),
      decelMod: newBand(),
      decelHigh: newBand(),
    };
    accs.set(r.playerId, a);
  }
  a.fixes += 1;
  const v = typeof r.spd === 'number' ? r.spd : 0; // a fix that survives ingest always has a real spd; 0 is safe
  // Real Δt from serverTs (s). null on the first row of a player; rows are monotone so dt ≥ 0.
  const dt = a.prevTs !== null ? (r.serverTs - a.prevTs) / 1000 : null;

  // --- gated step: ONE value reused by distanceM AND zoneDistanceM[zone] (so they can never disagree). §1/§2.1.
  // fix ≥ 2 is guaranteed (ingest drops fix<2 before persist), so the server gate is v≥0.4 AND pdop≤5; this is
  // EQUIVALENT to the client's three-clause live gate (the live + review distances must not diverge).
  let step = 0;
  if (a.prevLat !== null && a.prevLon !== null && v >= WALK_FLOOR_MPS && (r.pdop == null || r.pdop <= PDOP_MAX)) {
    step = stepMetres(a.prevLat, a.prevLon, r.lat, r.lon);
  }
  a.distanceM += step;
  a.zoneDistanceM[zoneOf(v, t)] += step;

  // --- sprint efforts (§3.4): a run of consecutive samples with v ≥ Sprint. Per clause 3 a sub-threshold DIP
  // only separates two efforts if it lasts ≥ SPRINT_MIN_SECONDS; a BRIEFER dip merges (one effort, not two).
  // So we do NOT close on the first sub-threshold sample — we accumulate a merge gap and flush only once the
  // gap reaches the separator length (or at scan-end). Duration counts the ENTRY interval so 10 in-run samples
  // @10 Hz span 1.0 s (not 0.9 s). distance = gated step while above threshold; max = peak in the merged run.
  // (This mirrors feedBand's gap/merge + dt-on-entry, with SPRINT_MIN_SECONDS as the separator.)
  if (v >= sprintMps) {
    if (!a.sprintInRun) {
      a.sprintInRun = true;
      a.sprintRunDur = dt ?? 0; // entry interval counts toward the run (off-by-one fix)
      a.sprintRunDist = step;
      a.sprintRunMax = v;
    } else {
      if (dt !== null) a.sprintRunDur += dt; // includes the re-entry interval when merging across a brief dip
      a.sprintRunDist += step;
      if (v > a.sprintRunMax) a.sprintRunMax = v;
    }
    a.sprintGapDur = 0; // back above threshold → the dip did not separate; reset the merge gap
  } else if (a.sprintInRun) {
    if (dt !== null) a.sprintGapDur += dt;
    // Only a dip ≥ SPRINT_MIN_SECONDS separates efforts → flush (count if its above-threshold span qualified).
    // A briefer dip leaves the run open so the next above-threshold sample merges into the SAME effort.
    if (a.sprintGapDur >= SPRINT_MIN_SECONDS - SECONDS_EPS) flushSprint(a);
  }

  // --- accel/decel efforts (§4): trailing causal moving average ṽ over ≤SMOOTH_WINDOW raw speeds, then
  // a = Δṽ/Δt with real Δt, clamped to ±ACCEL_CLAMP. Band detectors are fed per-direction.
  a.ring.push(v);
  if (a.ring.length > SMOOTH_WINDOW) a.ring.shift();
  let smoothed = 0;
  for (const s of a.ring) smoothed += s;
  smoothed /= a.ring.length;
  if (a.prevSmoothed !== null && dt !== null && dt > 0) {
    let acc = (smoothed - a.prevSmoothed) / dt;
    if (acc > ACCEL_CLAMP_MPS2) acc = ACCEL_CLAMP_MPS2;
    else if (acc < -ACCEL_CLAMP_MPS2) acc = -ACCEL_CLAMP_MPS2;
    // accel direction (a>0): nested Mod (≥2.0) and High (≥3.0) detectors fire independently.
    feedBand(a.accelMod, acc >= ACCEL_MOD_MPS2, dt);
    feedBand(a.accelHigh, acc >= ACCEL_HIGH_MPS2, dt);
    // decel direction (a<0): same magnitude bands on the negative side.
    feedBand(a.decelMod, acc <= -ACCEL_MOD_MPS2, dt);
    feedBand(a.decelHigh, acc <= -ACCEL_HIGH_MPS2, dt);
  }
  a.prevSmoothed = smoothed;

  // --- base aggregates (unchanged shape) ---
  a.lastTs = r.serverTs; // monotone; firstTs set at create
  a.prevLat = r.lat;
  a.prevLon = r.lon;
  a.prevTs = r.serverTs;
  if (typeof r.spd === 'number') {
    a.speedSum += r.spd;
    a.speedN += 1;
    if (r.spd > a.maxSpeedMps) a.maxSpeedMps = r.spd;
  }
  if (r.lat < a.minLat) a.minLat = r.lat;
  if (r.lat > a.maxLat) a.maxLat = r.lat;
  if (r.lon < a.minLon) a.minLon = r.lon;
  if (r.lon > a.maxLon) a.maxLon = r.lon;
}

/** Close the current sprint run, counting it IFF its above-threshold duration reached SPRINT_MIN_SECONDS, and
 * reset the run state. Called on a sub-threshold sample AND once per player at scan-end (the §4.1 flush). */
function flushSprint(a: Acc): void {
  if (!a.sprintInRun) return;
  if (a.sprintRunDur >= SPRINT_MIN_SECONDS - SECONDS_EPS) {
    a.sprintCount += 1;
    a.sprintDistanceM += a.sprintRunDist;
    if (a.sprintRunMax > a.sprintMaxSpeedMps) a.sprintMaxSpeedMps = a.sprintRunMax;
  }
  a.sprintInRun = false;
  a.sprintRunDur = 0;
  a.sprintRunDist = 0;
  a.sprintRunMax = 0;
  a.sprintGapDur = 0;
}

/**
 * Advance one band detector with this sample's in-band boolean + real Δt. An effort counts ONCE its in-band
 * duration reaches EFFORT_MIN_SECONDS (≥0.3 s ≈ ≥3 samples). Leaving the band starts a merge gap: re-entering
 * within EFFORT_MIN_SECONDS resumes the SAME effort (no recount); a longer gap closes it so the next entry is a
 * fresh effort. Uses REAL Δt so a dropped fix can't fabricate (or break) a sustained run.
 */
function feedBand(d: BandDetector, inBand: boolean, dt: number): void {
  if (inBand) {
    if (!d.inBand && d.gapDur >= EFFORT_MIN_SECONDS - SECONDS_EPS) {
      // gap exceeded the merge window → previous effort is fully closed; this is a new effort.
      d.runDur = 0;
      d.counted = false;
    }
    d.runDur += dt;
    d.gapDur = 0;
    d.inBand = true;
    if (!d.counted && d.runDur >= EFFORT_MIN_SECONDS - SECONDS_EPS) {
      d.count += 1;
      d.counted = true;
    }
  } else {
    if (d.inBand) d.gapDur = 0; // just left the band; start measuring the merge gap from 0
    d.gapDur += dt;
    d.inBand = false;
  }
}

/**
 * Occupancy heatmap, built in a SECOND paged pass over the same window (the bbox is only known after pass 1).
 * Re-reads in HISTORY_SCAN_CHUNK keyset pages and bins each (lat,lon) into a COLS×ROWS grid scaled to the
 * scan bbox, yielding the live loop between pages exactly like pass 1 — so it cannot starve ingest/fan-out
 * and uses O(1) extra memory (no per-row buffer) regardless of span. Counts only — NO per-bin playerId/name
 * (§3.1). An empty / degenerate (single-point, zero-span) scan returns an all-zero grid + null bbox so the
 * client draws nothing.
 */
async function buildHeatmapPaged(
  p: HistoryParams,
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
  scan: ScanBudget,
): Promise<{ cols: number; rows: number; bins: number[]; bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null }> {
  const bins = new Array(HEATMAP_COLS * HEATMAP_ROWS).fill(0);
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;
  if (!(latSpan > 0) || !(lonSpan > 0)) {
    // Empty or degenerate (single point / zero-span) scan → all-zero grid + null bbox; client draws nothing.
    return { cols: HEATMAP_COLS, rows: HEATMAP_ROWS, bins, bbox: null };
  }
  let afterTs = p.from - 1;
  let afterRowid = 0;
  for (;;) {
    const rows = readFixesPage(p.sessionId, p.from, p.to, afterTs, afterRowid, HISTORY_SCAN_CHUNK);
    if (rows.length === 0) break;
    scan.noteRows(rows.length); // pass 2 reads the window again — an abort here has read it twice
    for (const r of rows) {
      // Clamp the top/right edge into the last bin (a value at max maps to index COLS, off-grid).
      const col = Math.min(HEATMAP_COLS - 1, Math.floor(((r.lon - minLon) / lonSpan) * HEATMAP_COLS));
      const row = Math.min(HEATMAP_ROWS - 1, Math.floor(((r.lat - minLat) / latSpan) * HEATMAP_ROWS));
      bins[row * HEATMAP_COLS + col] += 1;
    }
    const last = rows[rows.length - 1];
    afterTs = last.serverTs;
    afterRowid = last.rowid;
    if (rows.length < HISTORY_SCAN_CHUNK) break;
    await yieldLoop(scan); // yield the live loop between pages, same as pass 1
  }
  // Ship the grid's GPS extent so the client maps bin (col,row) → lat/lon → pixels (ADR-0017 one-renderer).
  return { cols: HEATMAP_COLS, rows: HEATMAP_ROWS, bins, bbox: { minLat, minLon, maxLat, maxLon } };
}

// ----- DoS gate: per-principal token bucket + the SHARED global inflight cap (PM-1) ------
const principalBuckets = new Map<string, { tokens: number; last: number }>();

/** Sweep idle buckets so the map can't grow unbounded over a long run (mirror auth.ts.sweep). */
function sweepBuckets(now: number): void {
  for (const [k, b] of principalBuckets) {
    if (now - b.last > 2 * RATE_WINDOW_MS) principalBuckets.delete(k);
  }
}

/** Per-principal token bucket: HISTORY_RATE_BURST capacity, refilling HISTORY_RATE_PER_MIN/min. */
function rateOk(principalKey: string): boolean {
  const now = Date.now();
  if (principalBuckets.size > 0 && Math.random() < 0.01) sweepBuckets(now); // cheap occasional GC
  let b = principalBuckets.get(principalKey);
  if (!b) {
    b = { tokens: HISTORY_RATE_BURST, last: now };
    principalBuckets.set(principalKey, b);
  }
  b.tokens = Math.min(
    HISTORY_RATE_BURST,
    b.tokens + ((now - b.last) / RATE_WINDOW_MS) * HISTORY_RATE_PER_MIN,
  );
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export type GateResult = { ok: true } | { ok: false; result: 'rate_limited' | 'busy' };

/**
 * Admission control for a history request, run by server.ts AFTER authz and BEFORE any DB work.
 * Two overlapping bounds on a children's-location bulk-export surface:
 *   - per-principal token bucket  → 'rate_limited' (429): one coach can't iterate the store tight;
 *     keyed on the principal so one principal can never starve another (bucket isolation).
 *   - global inflight cap         → 'busy' (503): bounds worst-case interleaved synchronous scan
 *     steps between event-loop yields to HISTORY_MAX_INFLIGHT×, so concurrent reads can't gang up
 *     to freeze the live loop.
 * On ok the inflight counter is INCREMENTED here; the caller MUST call releaseInflight() in a
 * `finally` (the bucket is consumed regardless — a rate-limited request never reaches the cap).
 * Order matches auth.ts (bucket BEFORE inflight) so a throttled client doesn't even occupy a slot.
 */
export function historyGate(principalKey: string): GateResult {
  if (!rateOk(principalKey)) return { ok: false, result: 'rate_limited' };
  // PM-1: the shared history+events inflight cap, PLUS this principal's share of it (Phase 6) —
  // the global cap is loop protection; without a per-principal share one caller can hold every slot.
  if (!acquireScanSlot(principalKey)) return { ok: false, result: 'busy' };
  return { ok: true };
}

/** Release one inflight slot. The caller pairs this with a successful historyGate() in `finally`. */
export function releaseInflight(principalKey: string): void {
  releaseScanSlot(principalKey);
}

/** Test-only: current COMBINED inflight count (history + events), so a unit test can assert the cap. */
export function _inflightCount(): number {
  return _scanInflight();
}

export { HISTORY_MAX_SPAN_MS, HISTORY_SCAN_CHUNK, HISTORY_RATE_BURST };
