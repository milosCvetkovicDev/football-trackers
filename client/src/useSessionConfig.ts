import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './config';
import type { AgeBand, SessionConfig, ZoneThresholds } from './types';

/**
 * Phase 4 (ADR-0019): resolve a session's age band + speed-zone thresholds from the server config store.
 *
 * Modelled EXACTLY on `useRoster` — fetch GET /sessions/:id/config (`credentials:'same-origin'` so the
 * HttpOnly session cookie rides along), an AbortController + `disposed` flag on cleanup, and a synchronous
 * reset-to-null at the START of the effect so a new session never renders with the previous session's band
 * while the request is in flight. Like the roster, the config is an ENHANCEMENT for the live render, never a
 * gate: `null` until the first successful load, and the caller falls back to U14 `DEFAULT_THRESHOLDS`
 * client-side while null so zones still render (graceful degradation). It is NEVER persisted (no
 * localStorage/sessionStorage/IndexedDB/Cache) — only component memory.
 *
 * Transient-failure retention (§3.2 / pre-mortem provenance gap): keep the last successfully-fetched config
 * for THIS session in a ref, and on a later non-abort fetch error return that last-good config rather than
 * snapping back to null. A configured session that hits a network blip therefore keeps its REAL band live —
 * otherwise the live zones would silently degrade to U14 while the review path still uses the real band, and
 * the two would disagree. On a session CHANGE the ref is reset FIRST (mirroring the roster stale guard) so a
 * stale config can never bleed across sessions.
 *
 * @param sessionId  the match session whose config to fetch. Falsy → null, no fetch (idle).
 * @returns          the SessionConfig once loaded, the last-good config on a transient failure, else null.
 */
export function useSessionConfig(sessionId: string): SessionConfig | null {
  const [config, setConfig] = useState<SessionConfig | null>(null);
  // Last successfully-fetched config for THIS session — survives a transient (non-abort) failure so a
  // configured session keeps its real band on a blip. Reset on session change BEFORE any fetch (below).
  const lastGood = useRef<SessionConfig | null>(null);

  useEffect(() => {
    // Reset synchronously at the START of the effect so the new session never renders with the old session's
    // band while the fetch below is in flight, and so a transient failure on the NEW session can't fall back
    // to the OLD session's last-good config (the cross-session belt — mirrors the useRoster stale guard).
    lastGood.current = null;
    setConfig(null);

    // Falsy sessionId (e.g. admin hasn't chosen one yet) → no config, no request.
    if (!sessionId) return;

    // Abort the in-flight fetch on cleanup; the `disposed` flag makes any late resolve a no-op so a slow
    // session-A response can't configure a session-B view after we've switched.
    const controller = new AbortController();
    let disposed = false;

    void (async () => {
      try {
        const res = await fetch(apiUrl(`/sessions/${encodeURIComponent(sessionId)}/config`), {
          method: 'GET',
          credentials: 'same-origin', // send the HttpOnly session cookie (same-origin transport, ADR-0015)
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) {
          // 401/403/404/429/5xx → keep the last-good band if we have one (transient-failure retention),
          // else stay null so the caller falls back to U14 DEFAULT_THRESHOLDS.
          if (!disposed && lastGood.current) setConfig(lastGood.current);
          return;
        }
        const body = (await res.json()) as {
          sessionId?: string;
          ageBand?: AgeBand;
          thresholds?: ZoneThresholds;
        };
        if (disposed) return; // a newer session won the race — drop this stale result
        // Build defensively: only a well-shaped {ageBand, thresholds:{4 numbers}} is accepted; anything else
        // is treated as a failure (retain last-good / stay null) rather than rendering a malformed config.
        const t = body?.thresholds;
        if (
          body &&
          typeof body.ageBand === 'string' &&
          t &&
          typeof t.jogMps === 'number' &&
          typeof t.runMps === 'number' &&
          typeof t.hsrMps === 'number' &&
          typeof t.sprintMps === 'number'
        ) {
          const next: SessionConfig = {
            ageBand: body.ageBand,
            thresholds: { jogMps: t.jogMps, runMps: t.runMps, hsrMps: t.hsrMps, sprintMps: t.sprintMps },
          };
          lastGood.current = next;
          setConfig(next);
        } else if (lastGood.current) {
          setConfig(lastGood.current);
        }
      } catch {
        // Abort (session switch) or network/parse failure: keep the last-good band if we have one so a
        // configured session survives a blip; otherwise stay null (caller uses U14 defaults). Never throw.
        if (!disposed && lastGood.current) setConfig(lastGood.current);
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [sessionId]);

  return config;
}
