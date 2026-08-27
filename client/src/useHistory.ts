import { useEffect, useState } from 'react';
import { apiUrl } from './config';
import { fetchWithDeadline, isTimeoutError, SCAN_DEADLINE_MS } from './fetchDeadline';
import { sendBeacon } from './beacon';
import type { AgeBand } from './types';

/**
 * Phase 3 (ADR-0017): fetch a session's recorded telemetry for the review/replay surface.
 *
 * Two modes, mirrored from the server's `GET /sessions/:id/history` response shapes (contract §3.1):
 *   - `aggregate` (default): per-player distance/speed summaries + an occupancy heatmap for the window.
 *   - `raw`: a single keyset page of one player's fixes, walked via the composite (serverTs, rowid)
 *     cursor for on-demand replay scrubbing. The caller pages by passing the previous `nextCursor`.
 *
 * Security posture (§0.1 / §0.2): the response carries children's recorded location — the most
 * sensitive read in the system. We hold it only in component memory (useState); it is NEVER persisted
 * (no localStorage/sessionStorage/IndexedDB/Cache) and carries NO child name (the server response is
 * pseudonymous — names are joined from the roster at render only, ADR-0016).
 *
 * Fail closed (§0.2): UNLIKE `useRoster` (where names are a non-gating enhancement), a history read is
 * the whole point of the review surface — a failed read MUST surface an explicit `'error'` status so the
 * coach sees text, never a misleading empty pitch that reads as "the player never moved". `'empty'` (a
 * successful read that returned no fixes) is distinct from `'error'` (the read itself failed) so the UI
 * can tell "no data in this window" from "we couldn't load it".
 *
 * Stale-result guard (mirrors `useRoster` / `useLiveTelemetry`): the effect resets to `'loading'` at the
 * start, creates an `AbortController`, passes `.signal` to fetch, and a `disposed` flag makes any late
 * resolve from a superseded query a no-op — so a slow session-A / window-A response can never paint over
 * a session-B / window-B view after the params changed.
 */

/** Sprint-effort summary for one player (Phase 4, §4.1) — review-only, never on the live wire. */
export interface SprintSummary {
  count: number;
  distanceM: number;
  maxSpeedMps: number;
}

/** Accel/decel effort counts for one player (Phase 4, §4) — GPS-derived trend estimate, review-only. */
export interface EffortSummary {
  accelMod: number;
  accelHigh: number;
  decelMod: number;
  decelHigh: number;
}

/**
 * One player's summary over the queried window — mirrors the server aggregate row (§3.1 + Phase-4 §4.1).
 * NO name (the server response is pseudonymous; names join from the roster at render only, ADR-0016).
 *
 * The Phase-4 fields are OPTIONAL so this UI degrades gracefully against a pre-Phase-4 server response
 * (an older server simply omits them; `ReviewView` renders each new cell only when present):
 *   - zoneDistanceM: per-zone gated distance, number[5] (idx 0=Z1 walk … 4=Z5 sprint; Σ == distanceM).
 *   - sprint:        sprint-effort count / distance / max speed.
 *   - effort:        accel/decel effort counts (moderate/high, per direction) — a GPS trend estimate.
 *   - distancePerMin: gated distanceM per active minute (a volume rate).
 */
export interface AggregatePlayer {
  playerId: string;
  fixes: number;
  firstTs: number;
  lastTs: number;
  distanceM: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  // --- Phase 4 (ADR-0019) — OPTIONAL for graceful degradation vs a pre-Phase-4 server. ---
  zoneDistanceM?: number[];
  sprint?: SprintSummary;
  effort?: EffortSummary;
  distancePerMin?: number;
}

/** Occupancy grid for the window — counts only, NO per-bin identity (§3.1). Scaled to the scan's bbox. */
export interface Heatmap {
  cols: number;
  rows: number;
  bins: number[]; // length cols*rows, row-major occupancy counts
  // GPS extent the grid is scaled to (the scan's overall bbox), so the client maps bin → lat/lon → pixels.
  // null for an empty / degenerate (single-point) scan, in which case the all-zero grid is drawn as nothing.
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
}

/** `mode=aggregate` response body — mirrors the server (§3.1 + Phase-4 §4.1). */
export interface AggregateResult {
  sessionId: string;
  from: number;
  to: number;
  scannedRows: number;
  players: AggregatePlayer[];
  heatmap: Heatmap;
  // Top-level age-band provenance (Phase 4, §4.1) — which band's thresholds the zone breakdown used.
  // OPTIONAL so a pre-Phase-4 server response (which omits it) still narrows to AggregateResult.
  ageBand?: AgeBand;
}

/** One recorded fix in a raw page — the minimised replay shape (§3.1). NO name, NO device internals. */
export interface RawFix {
  serverTs: number;
  lat: number;
  lon: number;
  spd: number;
  hdg: number;
}

/** Composite keyset cursor — resume UNAMBIGUOUSLY past rows sharing a `serverTs` ms (§3.1). */
export interface HistoryCursor {
  serverTs: number;
  rowid: number;
}

/** `mode=raw` response body — mirrors the server (§3.1). `nextCursor` null on the last page. */
export interface RawResult {
  sessionId: string;
  playerId: string;
  from: number;
  to: number;
  fixes: RawFix[];
  nextCursor: HistoryCursor | null;
}

/** Query the hook resolves. `player` is required by the server for `mode:'raw'`; `cursor` pages raw. */
export interface HistoryQuery {
  from: number;
  to: number;
  mode: 'aggregate' | 'raw';
  player?: string;
  cursor?: HistoryCursor;
}

/**
 * Discriminated result the view renders against. `data` is present only on `'ok'`; its concrete shape
 * follows `query.mode`, so callers narrow on the mode they asked for (the aggregate table reads
 * `AggregateResult`, the replay reads `RawResult`).
 */
export type HistoryResult<T extends AggregateResult | RawResult = AggregateResult | RawResult> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'ok'; data: T };

/** True when a successful response carried no usable rows — drives the `'empty'` (vs `'error'`) state. */
function isEmptyResponse(mode: 'aggregate' | 'raw', body: AggregateResult | RawResult): boolean {
  return mode === 'aggregate'
    ? (body as AggregateResult).players.length === 0
    : (body as RawResult).fixes.length === 0;
}

/**
 * Fetch `GET /sessions/:id/history` for one (sessionId, query) and expose an explicit loading/error/
 * empty/ok state. Re-fetches whenever the session or any query field changes; aborts the prior request.
 *
 * @param sessionId  the match session to read. Falsy → idle `'empty'` (no request).
 * @param query      window + mode (+ player/cursor for raw). A null/undefined query → idle `'empty'`.
 * @param reloadNonce Phase 5 (audit §6 "Client": *the "try again" copy is misleading because
 *   re-pressing Apply is a no-op*). Re-applying the SAME window changed no dependency below, so the
 *   read never re-ran and a transient failure looked permanent. Bumping this nonce repeats the read
 *   with identical parameters — which is what "try again" has to mean.
 */
export function useHistory(
  sessionId: string,
  query: HistoryQuery | null,
  reloadNonce = 0,
): HistoryResult {
  const [result, setResult] = useState<HistoryResult>({ status: 'loading' });

  // Depend on the primitive query fields (not the object identity) so a caller that rebuilds the query
  // object each render — without changing its values — doesn't trigger an endless re-fetch loop.
  const mode = query?.mode;
  const from = query?.from;
  const to = query?.to;
  const player = query?.player;
  const cursorTs = query?.cursor?.serverTs;
  const cursorRowid = query?.cursor?.rowid;

  useEffect(() => {
    // Nothing to fetch (no session / no query) → settle to idle-empty, no request.
    if (!sessionId || from === undefined || to === undefined || mode === undefined) {
      setResult({ status: 'empty' });
      return;
    }

    // Reset to loading at the START so a new query never shows the previous window's data while in flight.
    setResult({ status: 'loading' });

    // Abort the in-flight request on cleanup; `disposed` makes any late resolve a no-op so a superseded
    // query can't paint over the current view (same defensive pattern as useRoster / useLiveTelemetry).
    const controller = new AbortController();
    let disposed = false;

    // Build the query string. NB: `player` is sent verbatim because the server validates it (charset +
    // session scope); we never reflect it back into an error message here, mirroring the server's opaque
    // error posture (§3.1) — a misconfigured caller passing a name as `player` must not see it echoed.
    const params = new URLSearchParams({ mode, from: String(from), to: String(to) });
    if (mode === 'raw') {
      if (player) params.set('player', player);
      // Composite cursor is both-or-neither (the server 400s a half cursor) — only send when both present.
      if (cursorTs !== undefined && cursorRowid !== undefined) {
        params.set('cursor_ts', String(cursorTs));
        params.set('cursor_rowid', String(cursorRowid));
      }
    }

    void (async () => {
      try {
        // Deadline (Phase 5): a history read is the slowest thing this client asks for, and the one a
        // half-open socket strands most visibly — "Loading match summary…" with no end and no error.
        const res = await fetchWithDeadline(
          apiUrl(`/sessions/${encodeURIComponent(sessionId)}/history?${params.toString()}`),
          {
            method: 'GET',
            credentials: 'same-origin', // send the HttpOnly session cookie (same-origin transport, ADR-0015)
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          },
          // The SCAN deadline, not the small-read one: /history pages over the raw fix table. It is set
          // LONGER than the server's own SCAN_BUDGET_MS so the server gives up first and answers an
          // honest, retryable 503 — aborting a legitimate long scan here would instead show the coach a
          // failure that every retry reproduces. (Since Phase 6 an abandoned read does release its
          // shared off-loop slot, but being the one to give up first is still the better answer.)
          SCAN_DEADLINE_MS,
        );
        // Fail closed: ANY non-2xx (401/403/404/429/503/400/5xx) is an explicit error, never a silent
        // empty pitch — the coach must be told the read failed (§0.2). Error bodies are opaque codes we
        // deliberately do not parse or surface (no leaked query value).
        if (!res.ok) {
          if (!disposed) setResult({ status: 'error' });
          return;
        }
        const body = (await res.json()) as AggregateResult | RawResult;
        if (disposed) return; // a newer query won the race — drop this stale result
        if (isEmptyResponse(mode, body)) {
          setResult({ status: 'empty' });
        } else {
          setResult({ status: 'ok', data: body });
        }
      } catch (err) {
        // An abort (param change / unmount) is expected — don't flip to error, the next effect run owns
        // the state. Any OTHER failure (network/parse) fails closed to an explicit error.
        if (disposed || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (isTimeoutError(err)) sendBeacon('fetch_timeout', sessionId); // kind only — never the URL/text
        setResult({ status: 'error' });
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
    // Primitive deps ONLY (the `query` object identity is intentionally excluded) so a caller that rebuilds
    // an equal-valued query each render doesn't trigger an endless re-fetch loop. The effect body reads only
    // these primitives (the redundant `!query` guard was dropped — undefined from/to/mode already cover it).
  }, [sessionId, mode, from, to, player, cursorTs, cursorRowid, reloadNonce]);

  return result;
}
