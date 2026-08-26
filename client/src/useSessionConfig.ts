import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './config';
import { fetchWithDeadline } from './fetchDeadline';
import { parsePitchCorners } from './pitchFrame';
import type { AgeBand, SessionConfig, ZoneThresholds } from './types';

/**
 * Phase 4 (ADR-0019) + Phase 5: resolve a session's setup from the server — the age band that selects
 * youth speed-zone thresholds, and (since Phase 5) the four measured pitch corners.
 *
 * Modelled on `useRoster` — fetch GET /sessions/:id/config (`credentials:'same-origin'` so the HttpOnly
 * session cookie rides along), an AbortController + `disposed` flag on cleanup, and a synchronous reset at
 * the START of the effect so a new session never renders with the previous session's band while the request
 * is in flight. Like the roster, this is an ENHANCEMENT for the live render, never a gate: the caller falls
 * back to U14 `DEFAULT_THRESHOLDS` and the built-in `PITCH_CORNERS` while unresolved, so the pitch always
 * renders. It is NEVER persisted (no localStorage/sessionStorage/IndexedDB/Cache) — only component memory.
 *
 * WHY THIS RETRIES (Phase 5 checker finding). The original version fetched exactly once per session and
 * folded every failure into "stay null", which the caller cannot distinguish from "this session has no
 * measured pitch". One blip at page load — a 429, a 5xx, a restart with no graceful shutdown, a hit deadline
 * — therefore stranded the coach for the WHOLE MATCH on U14 defaults and the built-in placeholder rectangle,
 * with the footer positively asserting that no pitch was configured. Two changes fix that:
 *   - a bounded retry with backoff, so a transient failure recovers on its own;
 *   - an explicit `status`, so the UI can say "couldn't load this session's setup" instead of stating a
 *     falsehood about the pitch.
 * (The previous "last-good retention" branch was removed: with exactly one fetch per session, `lastGood` was
 * provably null at every read site — a mechanism the doc described at length and that could never fire.)
 *
 * @param sessionId  the match session whose config to fetch. Falsy → idle, no fetch.
 */

/** Retry schedule for a transient failure. Short enough to recover before kick-off, bounded so a genuinely
 *  misconfigured server doesn't become a request loop against a children's-location endpoint. */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

export type SessionConfigStatus = 'idle' | 'loading' | 'ok' | 'error';

export interface SessionConfigState {
  /** The resolved config, or null while loading / after giving up. */
  config: SessionConfig | null;
  /**
   * 'ok' means the server ANSWERED — so an absent `pitchCorners` genuinely means "no pitch measured for
   * this session". 'error' means we could not ask, and the caller must not claim anything about the pitch.
   */
  status: SessionConfigStatus;
}

export function useSessionConfig(sessionId: string): SessionConfigState {
  const [state, setState] = useState<SessionConfigState>({ config: null, status: 'idle' });
  // Bumping this re-runs the whole fetch+retry sequence. The bounded retry above eventually gives up
  // (~12 s), and without this the session would stay stranded on default zones and the placeholder
  // pitch for the rest of the match — the very failure the retry was added to remove, just later. The
  // browser regaining an interface is the one signal that reliably means "ask again now".
  const [reloadNonce, setReloadNonce] = useState(0);
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  useEffect(() => {
    const onOnline = () => {
      if (statusRef.current === 'error') setReloadNonce((n) => n + 1);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  useEffect(() => {
    // Reset synchronously at the START of the effect so the new session never renders with the old
    // session's band while the fetch below is in flight (mirrors the useRoster stale guard).
    setState({ config: null, status: sessionId ? 'loading' : 'idle' });

    // Falsy sessionId (e.g. admin hasn't chosen one yet) → no config, no request.
    if (!sessionId) return;

    // Abort the in-flight fetch on cleanup; the `disposed` flag makes any late resolve a no-op so a slow
    // session-A response can't configure a session-B view after we've switched.
    const controller = new AbortController();
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    /** One attempt. Returns true when the config resolved; false for a retryable failure. */
    const attempt = async (): Promise<boolean> => {
      // Deadline (Phase 5): a half-open socket would otherwise leave the band unresolved forever, and
      // with it the pitch corners — the view would silently run on U14 defaults and the built-in
      // outline with nothing on screen to say why.
      const res = await fetchWithDeadline(apiUrl(`/sessions/${encodeURIComponent(sessionId)}/config`), {
        method: 'GET',
        credentials: 'same-origin', // send the HttpOnly session cookie (same-origin transport, ADR-0015)
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      // 401/403 are ANSWERS, not blips: this principal will not be allowed to read this session's config
      // however many times we ask, so retrying is pure noise against an access-controlled endpoint.
      if (res.status === 401 || res.status === 403) {
        if (!disposed) setState({ config: null, status: 'error' });
        return true; // "settled" — stop retrying
      }
      if (!res.ok) return false; // 404/429/5xx → retryable

      const body = (await res.json()) as {
        sessionId?: string;
        ageBand?: AgeBand;
        thresholds?: ZoneThresholds;
        pitch?: { corners?: unknown };
      };
      if (disposed) return true; // a newer session won the race — drop this stale result
      // Build defensively: only a well-shaped {ageBand, thresholds:{4 numbers}} is accepted; anything else
      // is treated as a failure rather than rendering a malformed config.
      const t = body?.thresholds;
      if (
        !body ||
        typeof body.ageBand !== 'string' ||
        !t ||
        typeof t.jogMps !== 'number' ||
        typeof t.runMps !== 'number' ||
        typeof t.hsrMps !== 'number' ||
        typeof t.sprintMps !== 'number'
      ) {
        return false; // a malformed body is as good as no answer — retry, then report error
      }
      // Phase 5: the pitch is OPTIONAL and independently validated. The server already refused a
      // degenerate quad, but nothing off the wire is trusted here either — an unusable one is dropped
      // (the caller keeps the built-in corners) rather than reaching a homography solve that throws
      // mid-match.
      const corners = body.pitch ? parsePitchCorners(body.pitch.corners) : null;
      setState({
        config: {
          ageBand: body.ageBand,
          thresholds: { jogMps: t.jogMps, runMps: t.runMps, hsrMps: t.hsrMps, sprintMps: t.sprintMps },
          ...(corners ? { pitchCorners: corners } : {}),
        },
        status: 'ok',
      });
      return true;
    };

    const run = async (tries = 0): Promise<void> => {
      let settled = false;
      try {
        settled = await attempt();
      } catch (err) {
        // An abort (session switch / unmount) is expected and owns nothing: the next effect run takes
        // over. Anything else — network, deadline, parse — is a retryable failure.
        if (disposed || (err instanceof DOMException && err.name === 'AbortError')) return;
        settled = false;
      }
      if (disposed || settled) return;
      if (tries >= RETRY_DELAYS_MS.length) {
        // Out of attempts: say so, rather than letting the UI assert the session has no pitch.
        setState({ config: null, status: 'error' });
        return;
      }
      retryTimer = setTimeout(() => void run(tries + 1), RETRY_DELAYS_MS[tries]);
    };

    void run();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
    };
    // reloadNonce is a dep so an `online` event re-runs the whole sequence from scratch.
  }, [sessionId, reloadNonce]);

  return state;
}
