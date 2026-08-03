import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveTelemetry } from './useLiveTelemetry';
import { useAuth } from './useAuth';
import { useRoster } from './useRoster';
import { useSessionConfig } from './useSessionConfig';
import { Login } from './Login';
import { PitchCanvas } from './PitchCanvas';
import { A11yMirror } from './A11yMirror';
import { ReviewView } from './ReviewView';
import { ErrorBoundary } from './ErrorBoundary';
import { useReducedMotion } from './hooks/useReducedMotion';
import { useWakeLock } from './hooks/useWakeLock';
import { DEFAULT_SESSION, DROP_MS } from './config';
import { DEFAULT_THRESHOLDS } from './zones';
import { describeConnection } from './contracts';
import type { Principal } from './contracts';
import type { ZoneThresholds } from './types';

type Theme = 'normal' | 'outdoor';

/**
 * Root gate (Phase 2, ADR-0015/0008). Auth state decides what renders:
 *   - 'loading'   → a small centered placeholder while the initial /auth/me probe is in flight
 *   - 'anonymous' → the <Login> form (not signed in / cookie expired)
 *   - 'authed'    → the live shell: session selection, then the telemetry-driven <LiveView>
 *
 * `useAuth` is called unconditionally at the top (hooks rule). Theme + reduced-motion live here too so
 * they persist across the gate (Login is also outdoor-aware). The telemetry hook is deliberately NOT
 * called here — it lives inside <LiveView>, which only mounts once a session is selected, so that
 * useLiveTelemetry is unconditional within its own component and never runs before we're authorized.
 */
export function App() {
  const { auth, login, logout, refresh } = useAuth();
  const reducedMotion = useReducedMotion();
  const [theme, setTheme] = useState<Theme>('normal');

  if (auth.status === 'loading') {
    return (
      <Centered theme={theme}>
        <span style={{ opacity: 0.7, fontSize: 14 }}>connecting…</span>
      </Centered>
    );
  }

  if (auth.status === 'anonymous') {
    return <Login login={login} theme={theme} />;
  }

  return (
    <AuthedShell
      principal={auth.principal}
      theme={theme}
      setTheme={setTheme}
      reducedMotion={reducedMotion}
      logout={logout}
      refresh={refresh}
    />
  );
}

interface AuthedShellProps {
  principal: Principal;
  theme: Theme;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  reducedMotion: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
}

/**
 * Bounded re-arm budget for a transient 'unauthorized' WS close where the cookie is in fact still valid
 * (a proxy/transport blip, an accounts-reload race). We re-mount the live socket up to this many times per
 * session selection rather than leaving the feed silently dark — but cap it so a genuinely-broken auth path
 * can't become a tight reconnect loop (the very thing Phase 1's explicit failure states removed).
 */
const MAX_REARM = 3;

/**
 * The signed-in shell: header (with the session picker + sign-out) and, once a session is chosen, the
 * live view. Session selection is driven by the principal:
 *   - wildcard (admin)        → a free-text input prefilled with DEFAULT_SESSION + a "View" button
 *   - exactly one session     → auto-selected (no picker shown)
 *   - several sessions         → a <select> of the assigned sessions (anon uses ANON_SESSIONS the same way)
 */
function AuthedShell({
  principal,
  theme,
  setTheme,
  reducedMotion,
  logout,
  refresh,
}: AuthedShellProps) {
  // Initial selection: admins start on the prefill; a single-session coach auto-selects; otherwise the
  // operator must pick (empty until they choose). Memoised on the principal so it's stable per identity.
  // Auto-select the first assigned session (single OR multi) so a multi-session coach's <select value> always
  // matches a real <option> — an empty value matching no option leaves the picker visually on option 0 while
  // nothing renders (a controlled-component desync + React warning). The <select> drives setSession on change.
  const initialSession = useMemo(() => {
    if (principal.wildcard) return DEFAULT_SESSION; // admins type a session into the free-text picker
    if (principal.sessions.length >= 1) return principal.sessions[0];
    return ''; // a coach assigned NO sessions has nothing to view
  }, [principal]);

  const [session, setSession] = useState(initialSession);
  // Admins type a session before viewing; this holds the in-progress text until they press "View".
  const [draft, setDraft] = useState(initialSession);

  // Live ⇄ Review mode (Phase 3, ADR-0017). One renderer family, two data sources; the toggle shows only
  // once a session is selected. Mode is intentionally NOT reset on session change — reviewing a freshly
  // picked session is valid (ReviewView is keyed on session, so it refetches).
  const [mode, setMode] = useState<'live' | 'review'>('live');

  // Player names for THIS session (ADR-0016): an authenticated, in-memory-only roster fetched once per
  // session. The map is the render-only playerId→displayName join passed to the canvas + mirror + review;
  // it is NEVER written into the pseudonymous telemetry store and NEVER persisted. Empty ⇒ ids-only.
  const roster = useRoster(session);

  // Speed-zone thresholds for THIS session (Phase 4, ADR-0019): resolved from GET /sessions/:id/config.
  // Like the roster it's an ENHANCEMENT, never a gate — `null` until the first load (or on a pre-Phase-4
  // server / config failure), so we fall back to U14 DEFAULT_THRESHOLDS client-side and zones still render
  // (graceful degradation). The same thresholds drive the live colour (canvas + mirror) AND the review
  // panel header, so live and review classify a speed identically. Called unconditionally here, alongside
  // useRoster, so hook order is stable across the live/review toggle below.
  const sessionConfig = useSessionConfig(session);
  const thresholds: ZoneThresholds = sessionConfig?.thresholds ?? DEFAULT_THRESHOLDS;

  // Re-arm machinery for a transient 'unauthorized' WS close (see MAX_REARM). connEpoch is part of the
  // <LiveView> key, so bumping it remounts the socket; rearms is the per-session-selection budget.
  const [connEpoch, setConnEpoch] = useState(0);
  const rearms = useRef(0);
  useEffect(() => {
    rearms.current = 0;
  }, [session]);

  // On a 1008 'unauthorized' close: re-check the cookie. If it's truly gone, refresh() flips auth→anonymous
  // and this whole shell unmounts to <Login>. If it's STILL valid (transient blip), re-arm the socket a
  // bounded number of times instead of leaving the children's feed silently dark with no recovery.
  const onUnauthorized = useCallback(async () => {
    const stillAuthed = await refresh();
    if (stillAuthed && rearms.current < MAX_REARM) {
      rearms.current += 1;
      setConnEpoch((e) => e + 1);
    }
  }, [refresh]);

  const outdoor = theme === 'outdoor';
  const showPicker = principal.wildcard || principal.sessions.length > 1;
  const showSignOut = !principal.anonymous;

  return (
    <div style={shellStyle(theme)}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: 0.3 }}>football-trackers · live</h1>

        {session ? (
          <span style={{ opacity: 0.6, fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>
            session: {session}
          </span>
        ) : null}

        {principal.username ? (
          <span style={{ opacity: 0.6, fontSize: 13 }}>signed in as {principal.username}</span>
        ) : null}

        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'outdoor' ? 'normal' : 'outdoor'))}
          aria-pressed={outdoor}
          style={toggleStyle(outdoor)}
        >
          {outdoor ? 'Standard view' : 'Outdoor mode'}
        </button>

        {showSignOut ? (
          <button type="button" onClick={() => void logout()} style={toggleStyle(false)}>
            Sign out
          </button>
        ) : null}
      </header>

      {/* Session picker — only for admins (wildcard) and multi-session coaches; a single-session
          coach (and the anon principal) auto-selects, so no picker is shown for them. */}
      {showPicker ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSession(draft.trim());
          }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
        >
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Session</span>
            {principal.wildcard ? (
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={pickerInputStyle(theme)}
                aria-label="Session id to view"
              />
            ) : (
              <select
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSession(e.target.value);
                }}
                style={pickerInputStyle(theme)}
                aria-label="Session to view"
              >
                {principal.sessions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
          </label>
          {principal.wildcard ? (
            <button type="submit" style={toggleStyle(outdoor)}>
              View
            </button>
          ) : null}
        </form>
      ) : null}

      {session ? (
        <>
          <div role="group" aria-label="View mode" style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setMode('live')}
              aria-pressed={mode === 'live'}
              style={toggleStyle(mode === 'live')}
            >
              Live
            </button>
            <button
              type="button"
              onClick={() => setMode('review')}
              aria-pressed={mode === 'review'}
              style={toggleStyle(mode === 'review')}
            >
              Review
            </button>
          </div>
          {mode === 'live' ? (
            <LiveView
              key={`${session}:${connEpoch}`}
              session={session}
              theme={theme}
              reducedMotion={reducedMotion}
              roster={roster}
              thresholds={thresholds}
              onUnauthorized={onUnauthorized}
            />
          ) : (
            <ReviewView
              session={session}
              roster={roster}
              thresholds={thresholds}
              theme={theme}
              reducedMotion={reducedMotion}
            />
          )}
        </>
      ) : (
        <p style={{ opacity: 0.6, fontSize: 14 }}>Choose a session to view its live pitch.</p>
      )}

      <p style={{ opacity: 0.5, fontSize: 12, maxWidth: 640, textAlign: 'center' }}>
        Positions update at the device rate; dots freeze to a hollow &ldquo;last known&rdquo; ring
        when a fix is &gt;2&nbsp;s old and drop after 10&nbsp;s. Edit <code>src/config.ts</code> with
        your pitch&apos;s four GPS corners.
      </p>
    </div>
  );
}

interface LiveViewProps {
  session: string;
  theme: Theme;
  reducedMotion: boolean;
  /** Render-only playerId→displayName join (ADR-0016); empty ⇒ ids-only. Never written into the store. */
  roster: Map<string, string>;
  /** Session speed-zone thresholds (Phase 4) — the fetched config or U14 defaults; drive zone colour. */
  thresholds: ZoneThresholds;
  /** Called when the WS upgrade is closed 'unauthorized' — App re-checks /auth/me (→ <Login>). */
  onUnauthorized: () => void;
}

/**
 * The telemetry-bound subtree, mounted only once a session is selected so its useLiveTelemetry hook is
 * unconditional within it. Holds the visible connection banner, the canvas + accessible mirror, and the
 * 1 Hz active-player count. The wake-lock lives here because it is driven by the live connection phase.
 */
function LiveView({ session, theme, reducedMotion, roster, thresholds, onUnauthorized }: LiveViewProps) {
  const { store, health, dist, conn } = useLiveTelemetry(session, onUnauthorized);

  // Keep the pitch-side tablet awake while the feed is live or recovering; release it once the
  // connection is terminally dead — no point burning the screen on a state a coach must go fix.
  // 'forbidden' and 'unauthorized' are terminal authz failures, 'error' a terminal network/config one.
  useWakeLock(
    conn.phase !== 'error' && conn.phase !== 'unauthorized' && conn.phase !== 'forbidden',
  );

  // A lightweight 1 Hz count of players with a recent fix — just enough to label the visible status
  // banner ("live · N players" vs "connected · waiting for players"). The canvas owns the rAF hot
  // loop; this never touches it. Counts non-lost players to match the accessible table below.
  const [active, setActive] = useState(0);
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      let n = 0;
      for (const t of store.current.values()) if (now - t.serverTs <= DROP_MS) n++;
      setActive(n);
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [store]);

  // The canvas draws its own HUD, but that text is pixels an assistive tool / e2e can't read. This
  // visible DOM banner carries the same connection label so failure states (forbidden, unauthorized,
  // gave-up) are real text on the page. The single polite live region lives in A11yMirror, so this is
  // NOT a live region — it would otherwise double-announce.
  const { label, tone } = describeConnection(conn, active);
  const toneColor = tone === 'ok' ? '#3ddc84' : tone === 'warn' ? '#ffd23f' : '#ff5d5d';

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          opacity: 0.9,
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 10, height: 10, borderRadius: '50%', background: toneColor }}
        />
        <span>{label}</span>
      </div>

      <ErrorBoundary>
        <PitchCanvas
          store={store}
          health={health}
          dist={dist}
          conn={conn}
          theme={theme}
          reducedMotion={reducedMotion}
          roster={roster}
          thresholds={thresholds}
        />
        <A11yMirror
          store={store}
          health={health}
          dist={dist}
          conn={conn}
          roster={roster}
          thresholds={thresholds}
        />
      </ErrorBoundary>
    </>
  );
}

// --- Shared layout / control styling (matches the dark / outdoor-high-contrast palette) ---

function shellStyle(theme: Theme): React.CSSProperties {
  return {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
    padding: 24,
    background: theme === 'outdoor' ? '#000' : '#0e0f12',
    color: '#e8e8e8',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  };
}

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    cursor: 'pointer',
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid #2a2d33',
    background: active ? '#ffdf2b' : '#16181d',
    color: active ? '#000' : '#e8e8e8',
  };
}

function pickerInputStyle(theme: Theme): React.CSSProperties {
  return {
    fontSize: 13,
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid #2a2d33',
    background: theme === 'outdoor' ? '#111' : '#0e0f12',
    color: '#e8e8e8',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  };
}

/** Full-viewport centered container reused by the loading placeholder. */
function Centered({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: theme === 'outdoor' ? '#000' : '#0e0f12',
        color: '#e8e8e8',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      {children}
    </div>
  );
}
