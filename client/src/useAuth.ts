import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthState, Principal, Role, UseAuth } from './contracts';
import { apiUrl } from './config';

/**
 * Phase 2 (ADR-0015/0008): named operator login over a SAME-ORIGIN HttpOnly session cookie.
 * This hook is the single owner of the auth lifecycle the rest of the SPA reads through `UseAuth`:
 * an initial `/auth/me` probe on mount, `login`, `logout`, and a `refresh` the live view triggers
 * when its WS upgrade is closed `'unauthorized'` (cookie expired/revoked mid-session).
 *
 * Security posture: the client NEVER holds the session token — it lives only in the HttpOnly cookie
 * the browser attaches to same-origin requests. We keep only the principal (operator username, role,
 * authorized sessions, and the CSRF synchronizer token) in memory. No credential is persisted beyond
 * the in-flight POST body. No child names ever pass through here — only operator usernames + session ids.
 */

/** The /auth/me success body. Mirrors §3 of the frozen contract (a superset of /auth/login's body). */
interface AuthMeOk {
  authenticated: true;
  username: string | null;
  role: Role;
  sessions: string[];
  wildcard: boolean;
  anonymous?: boolean;
  csrf: string;
}

/** Map a confirmed /auth/me body into the in-memory principal the gate renders against. */
function principalFromMe(me: AuthMeOk): Principal {
  return {
    username: me.username,
    role: me.role,
    sessions: Array.isArray(me.sessions) ? me.sessions : [],
    wildcard: me.wildcard === true,
    anonymous: me.anonymous === true,
    csrf: typeof me.csrf === 'string' ? me.csrf : '',
  };
}

/** Friendly, non-leaky message per login failure status (never reveals unknown-user vs bad-pw — §3). */
function loginErrorFor(status: number): string {
  switch (status) {
    case 401:
      return 'Incorrect username or password.';
    case 429:
      return 'Too many attempts — wait a moment and try again.';
    case 503:
      return 'Server busy — try again.';
    default:
      return 'Could not sign in. Please try again.';
  }
}

export function useAuth(): UseAuth {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  // One in-flight `/auth/me` guard so React 19 StrictMode's double-mount (and an overlapping refresh)
  // can't race two probes into conflicting setStates. We don't abort the fetch — we just ignore a
  // result once a newer probe has started or the component has unmounted.
  const meSeq = useRef(0);
  const mounted = useRef(true);

  // GET /auth/me, then commit the result IFF this probe is still the latest and we're still mounted.
  // Returns the resolved state so callers (login) can act on the same fetch without a second round-trip.
  const probeMe = useCallback(async (): Promise<AuthState> => {
    const seq = ++meSeq.current;
    let next: AuthState;
    try {
      const res = await fetch(apiUrl('/auth/me'), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const me = (await res.json()) as AuthMeOk;
        next = { status: 'authed', principal: principalFromMe(me) };
      } else {
        // 401 (or anything non-2xx) → not authenticated. Show <Login>.
        next = { status: 'anonymous' };
      }
    } catch {
      // Network/parse failure on the probe → treat as not authenticated (fail closed to the login gate).
      next = { status: 'anonymous' };
    }
    if (mounted.current && seq === meSeq.current) setAuth(next);
    return next;
  }, []);

  // Initial probe on mount. The seq guard makes the StrictMode double-invoke harmless.
  useEffect(() => {
    mounted.current = true;
    void probeMe();
    return () => {
      mounted.current = false;
    };
  }, [probeMe]);

  const login = useCallback<UseAuth['login']>(
    async (username, password) => {
      let res: Response;
      try {
        res = await fetch(apiUrl('/auth/login'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username, password }),
        });
      } catch {
        return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
      }
      if (!res.ok) return { ok: false, error: loginErrorFor(res.status) };

      // 200 doesn't mean the cookie stuck: a non-Secure cookie over a LAN-IP origin (or any non-secure
      // context that isn't localhost) is silently dropped by the browser. Immediately confirm via
      // /auth/me — the contract's cookie-not-stored guard — instead of optimistically trusting login.
      const confirmed = await probeMe();
      if (confirmed.status !== 'authed') {
        // Stay anonymous (probeMe already set it) and surface the actionable diagnostic.
        return {
          ok: false,
          error:
            'Signed in, but the session cookie was not stored — open this app over https:// or ' +
            'http://localhost (in dev, set AUTH_COOKIE_SECURE=false).',
        };
      }
      return { ok: true };
    },
    [probeMe],
  );

  const logout = useCallback<UseAuth['logout']>(async () => {
    // The CSRF synchronizer token is required by the server (§3/§4); read it from the live principal.
    const csrf = auth.status === 'authed' ? auth.principal.csrf : '';
    try {
      await fetch(apiUrl('/auth/logout'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrf },
      });
    } catch {
      // Best-effort: even if the network call fails, we drop the local principal below so the UI
      // returns to the login gate. (The server token may linger until its TTL, but the client forgets it.)
    }
    // Flip to anonymous regardless of the server result, and bump the seq so a late /auth/me probe
    // that was in flight can't resurrect the authed state after we've intentionally signed out.
    meSeq.current++;
    if (mounted.current) setAuth({ status: 'anonymous' });
  }, [auth]);

  const refresh = useCallback<UseAuth['refresh']>(async () => {
    // Re-check /auth/me: 200 → authed, 401 → anonymous (cookie expired/revoked mid-session → <Login>).
    // Resolve whether we're still authed so the caller can re-arm a transiently-rejected socket vs. bounce.
    const next = await probeMe();
    return next.status === 'authed';
  }, [probeMe]);

  return { auth, login, logout, refresh };
}
