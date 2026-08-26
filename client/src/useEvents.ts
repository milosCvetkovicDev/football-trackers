import { useEffect, useState } from 'react';
import { apiUrl } from './config';
import { fetchWithDeadline, isTimeoutError, SCAN_DEADLINE_MS } from './fetchDeadline';
import { sendBeacon } from './beacon';
import type { EventsResult } from './types';

/**
 * Track A (ADR-0020): fetch a session's tactical-event timeline for the review surface — a team-shape series +
 * movement-derived phase events (high_tempo / transition / stoppage), computed server-side OFF the live loop.
 *
 * Security posture (event-detection-contract §0.1/§0.2, PM-S5): the response carries the team CENTROID over
 * time — child-derived location. We hold it ONLY in component memory (useState); it is NEVER persisted (no
 * localStorage/sessionStorage/IndexedDB/Cache), matching the server's `Cache-Control: no-store`, so it cannot
 * survive logout. The response is team-AGGREGATE — it carries NO playerId or name at all.
 *
 * Fail closed (§0.2): like `useHistory`, ANY non-2xx or network/parse failure surfaces an explicit `'error'`
 * (never a misleading blank), distinct from `'empty'` (a successful read with no data in the window). The
 * effect aborts the prior request and a `disposed` flag drops any late resolve from a superseded query.
 */
export type EventsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'ok'; data: EventsResult };

/**
 * @param reloadNonce Phase 5 (audit §6 "Client": *the "try again" copy is misleading because
 *   re-pressing Apply is a no-op*). Re-applying the SAME window changed no dependency, so nothing
 *   re-fetched and the failure looked permanent. Bumping this nonce re-runs the read with identical
 *   parameters — which is exactly what "try again" has to mean after a transient failure.
 */
export function useEvents(
  sessionId: string,
  window: { from: number; to: number } | null,
  reloadNonce = 0,
): EventsState {
  const [state, setState] = useState<EventsState>({ status: 'loading' });

  // Depend on primitives (not the object identity) so a caller rebuilding an equal window object each render
  // doesn't loop.
  const from = window?.from;
  const to = window?.to;

  useEffect(() => {
    if (!sessionId || from === undefined || to === undefined) {
      setState({ status: 'empty' });
      return;
    }
    setState({ status: 'loading' }); // never show the previous window's events while a new query is in flight

    const controller = new AbortController();
    let disposed = false;
    const params = new URLSearchParams({ from: String(from), to: String(to) });

    void (async () => {
      try {
        const res = await fetchWithDeadline(
          apiUrl(`/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`),
          {
            method: 'GET',
            credentials: 'same-origin', // send the HttpOnly session cookie (same-origin transport, ADR-0015)
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          },
          SCAN_DEADLINE_MS, // an events read is a scan, like /history — see fetchDeadline.ts
        );
        // Fail closed: any non-2xx (401/403/404/429/503/400/5xx) is an explicit error, never a silent blank.
        if (!res.ok) {
          if (!disposed) setState({ status: 'error' });
          return;
        }
        const body = (await res.json()) as EventsResult;
        if (disposed) return; // a newer query won the race
        if (body.series.length === 0 && body.events.length === 0) {
          setState({ status: 'empty' });
        } else {
          setState({ status: 'ok', data: body });
        }
      } catch (err) {
        if (disposed || (err instanceof DOMException && err.name === 'AbortError')) return;
        // A DEADLINE is worth reporting: it is the failure mode that used to hang forever with no
        // trace on either side. Kind only — never the URL or the error text.
        if (isTimeoutError(err)) sendBeacon('fetch_timeout', sessionId);
        setState({ status: 'error' });
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [sessionId, from, to, reloadNonce]);

  return state;
}
