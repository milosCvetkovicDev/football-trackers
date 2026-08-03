import { useEffect, useState } from 'react';
import { apiUrl } from './config';

/**
 * Phase 3 (ADR-0016): resolve a session's pseudonymous playerIds → coach-facing display names.
 *
 * Names are an ENHANCEMENT, not a gate: a missing/failed/empty roster simply yields an empty map and
 * the views fall back to ids-only (`displayName ?? playerId` at render). We therefore NEVER surface an
 * error from here and NEVER block on it — an ids-only live view is a fully valid posture.
 *
 * Security posture (§0.1 / §1.5): the returned map lives ONLY in component memory (useState). It is
 * NEVER persisted (no localStorage/sessionStorage/IndexedDB/Cache) and is NEVER written into the
 * telemetry `store` Map — the store stays pseudonymous and the name join is render-only. Child names
 * exist in exactly two client-side places: this in-memory map and the on-screen render of it.
 *
 * Stale-roster guard (§1.5 / §8 Q6 — must never paint session A's name on a session B dot):
 *   (a) the effect synchronously resets the map to empty BEFORE the fetch, so a new session can never
 *       render with the previous session's names while the request is in flight; and
 *   (b) it aborts the in-flight fetch and sets a `disposed` flag on cleanup so a late resolve from the
 *       old session is a no-op — the same defensive pattern as `useLiveTelemetry`.
 *
 * @param sessionId  the match session whose roster to fetch. Falsy → empty map, no fetch (idle).
 * @returns          a playerId → displayName Map (empty when there's no roster / on any failure).
 */
export function useRoster(sessionId: string): Map<string, string> {
  const [roster, setRoster] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    // (a) Reset synchronously at the START of the effect body so the new session never renders with the
    // old session's names while the fetch below is in flight (the stale-name belt — §1.5).
    setRoster(new Map());

    // Falsy sessionId (e.g. admin hasn't chosen one yet) → ids-only, no request.
    if (!sessionId) return;

    // (b) Abort the in-flight fetch on cleanup; the `disposed` flag makes any late resolve a no-op so a
    // slow session-A response can't name a session-B dot after we've switched.
    const controller = new AbortController();
    let disposed = false;

    void (async () => {
      try {
        const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}/roster`), {
          method: 'GET',
          credentials: 'same-origin', // send the HttpOnly session cookie (same-origin transport, ADR-0015)
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) return; // 401/403/404/429/5xx → ids-only; names are not a gate, surface nothing
        const body = (await res.json()) as {
          sessionId: string;
          roster: { playerId: string; displayName: string }[];
        };
        if (disposed) return; // a newer session won the race — drop this stale result
        // Build the map defensively: only well-shaped {playerId, displayName} string pairs are kept.
        const next = new Map<string, string>();
        if (Array.isArray(body?.roster)) {
          for (const e of body.roster) {
            if (e && typeof e.playerId === 'string' && typeof e.displayName === 'string') {
              next.set(e.playerId, e.displayName);
            }
          }
        }
        if (!disposed) setRoster(next);
      } catch {
        // Abort (session switch) or network/parse failure → ids-only. Fail closed to no names; never throw.
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [sessionId]);

  return roster;
}
