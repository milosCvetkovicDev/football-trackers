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
import { DEFAULT_SESSION, DROP_MS, PITCH_CORNERS } from './config';
import { DEFAULT_THRESHOLDS } from './zones';
import { describeConnection, shouldOfferReconnect } from './contracts';
import { serverNow } from './serverClock';
import type { Principal } from './contracts';
import type { ZoneThresholds } from './types';
import type { LatLon } from './geo';

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
  // Anon-stack opt-in login (Phase 2, audit §4.1). On the isolated-LAN stack /auth/me answers 200 with
  // the anonymous principal, so the gate below never shows <Login> and there would be no way to reach a
  // named account at all — while names and Review now REQUIRE one. This flag is how the shell asks for
  // the form; it is irrelevant everywhere else, because a non-anon deployment starts at 'anonymous'.
  const [wantLogin, setWantLogin] = useState(false);

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

  // Signing in is OPTIONAL here (the live pitch already works), so this form gets a way back out.
  if (auth.principal.anonymous && wantLogin) {
    return <Login login={login} theme={theme} onCancel={() => setWantLogin(false)} />;
  }

  return (
    <AuthedShell
      principal={auth.principal}
      theme={theme}
      setTheme={setTheme}
      reducedMotion={reducedMotion}
      // Clear the "show me the form" flag as part of signing out. Without this it survives the whole
      // session — a coach who signed in via the form and then signed out on the anon stack would land
      // straight back on the login form instead of the ids-only pitch they asked to return to.
      logout={async () => {
        setWantLogin(false);
        await logout();
      }}
      refresh={refresh}
      onRequestLogin={() => setWantLogin(true)}
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
  /** Show the login form (anon stack only — signing in there buys names + Review, ADR-0016/0017). */
  onRequestLogin: () => void;
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
  onRequestLogin,
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
  // (session, identity). The map is the render-only playerId→displayName join passed to the canvas +
  // mirror + review; it is NEVER written into the pseudonymous telemetry store and NEVER persisted.
  // Empty ⇒ ids-only. The identity half matters because signing out on the anon stack does not unmount
  // this shell — without it the previous coach's names stayed on the pitch for the anonymous principal.
  const roster = useRoster(session, principal.username ?? 'anon');

  // Speed-zone thresholds for THIS session (Phase 4, ADR-0019): resolved from GET /sessions/:id/config.
  // Like the roster it's an ENHANCEMENT, never a gate — `null` until the first load (or on a pre-Phase-4
  // server / config failure), so we fall back to U14 DEFAULT_THRESHOLDS client-side and zones still render
  // (graceful degradation). The same thresholds drive the live colour (canvas + mirror) AND the review
  // panel header, so live and review classify a speed identically. Called unconditionally here, alongside
  // useRoster, so hook order is stable across the live/review toggle below.
  const { config: sessionConfig, status: configStatus } = useSessionConfig(session);
  const thresholds: ZoneThresholds = sessionConfig?.thresholds ?? DEFAULT_THRESHOLDS;
  // Phase 5 (audit §6 "Client"): the pitch's four GPS corners come from the SAME session config. Until
  // it resolves — or when this session has no measured pitch — we fall back to the built-in corners, so
  // the view always renders something. Before Phase 5 the built-in corners were the only option, and
  // the committed value pointed at a bench in Belgrade, so every real pitch mapped to the wrong box.
  const corners: LatLon[] = sessionConfig?.pitchCorners ?? PITCH_CORNERS;
  // A pitch change must rebuild the render geometry, and must also clear any boundary the previous
  // (bad) geometry tripped — hence this key, which is part of both the canvas key and the boundaries'.
  const pitchKey = corners.map((c) => `${c.lat},${c.lon}`).join(';');

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
  // Review is a REAL-LOGIN surface (Phase 2, audit §4.1): it reads /sessions/:id/history, a bulk export of
  // raw child location, and the server now answers 403 login_required for the anonymous principal. Hiding
  // the toggle rather than letting it 403 keeps the UI honest — an offered control that always fails reads
  // as a broken app. Anon keeps the live pitch, which is the whole reason the bypass exists.
  const showReview = !principal.anonymous;

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
          style={controlStyle(outdoor)}
        >
          {outdoor ? 'Standard view' : 'Outdoor mode'}
        </button>

        {showSignOut ? (
          <button type="button" onClick={() => void logout()} style={controlStyle(false)}>
            Sign out
          </button>
        ) : (
          // Anonymous principal: the live pitch already works without a login, so this is an OFFER, not
          // a gate. It is the only route to the surfaces that now need a named account — the label says
          // which ones, so nobody has to discover it by finding the Review toggle missing.
          <button type="button" onClick={onRequestLogin} style={controlStyle(false)}>
            Sign in for names &amp; review
          </button>
        )}
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
            <button type="submit" style={controlStyle(outdoor)}>
              View
            </button>
          ) : null}
        </form>
      ) : null}

      {session ? (
        <>
          {showReview ? (
            <div role="group" aria-label="View mode" style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setMode('live')}
                aria-pressed={mode === 'live'}
                style={controlStyle(mode === 'live')}
              >
                Live
              </button>
              <button
                type="button"
                onClick={() => setMode('review')}
                aria-pressed={mode === 'review'}
                style={controlStyle(mode === 'review')}
              >
                Review
              </button>
            </div>
          ) : null}
          {mode === 'live' || !showReview ? (
            <LiveView
              key={`${session}:${connEpoch}`}
              session={session}
              theme={theme}
              reducedMotion={reducedMotion}
              roster={roster}
              thresholds={thresholds}
              corners={corners}
              pitchKey={pitchKey}
              onUnauthorized={onUnauthorized}
            />
          ) : (
            // Review gets its OWN boundary (Phase 5, audit §6): a throw in here used to reach the root
            // and replace the entire page, leaving reload as the only exit. Scoped, the shell survives
            // and "Back to live" is one press away — the live pitch is the thing a coach actually needs.
            <ErrorBoundary
              title="Match review couldn't be shown"
              resetLabel="Back to live"
              onReset={() => setMode('live')}
              sessionId={session}
              resetKey={`${session}:${pitchKey}`}
            >
              <ReviewView
                session={session}
                roster={roster}
                thresholds={thresholds}
                corners={corners}
                theme={theme}
                reducedMotion={reducedMotion}
              />
            </ErrorBoundary>
          )}
        </>
      ) : (
        <p style={{ opacity: 0.6, fontSize: 14 }}>Choose a session to view its live pitch.</p>
      )}

      <p style={{ opacity: 0.5, fontSize: 12, maxWidth: 640, textAlign: 'center' }}>
        Positions update at the device rate; dots freeze to a hollow &ldquo;last known&rdquo; ring
        when a fix is &gt;2&nbsp;s old and drop after 10&nbsp;s.{' '}
        {/* Three states, not two (Phase 5 checker): a FAILED config read must not be reported as
            "this session has no measured pitch" — that is a positive claim we cannot make while the
            coach is looking at children drawn on a placeholder rectangle. */}
        {configStatus === 'error'
          ? 'Couldn’t load this session’s setup — showing the default pitch outline and U14 speed zones.'
          : sessionConfig?.pitchCorners
            ? 'The pitch outline is this session’s measured corners.'
            : configStatus === 'ok'
              ? 'No measured pitch for this session yet — showing the default outline (set it with session-config.ts set-pitch).'
              : 'Loading this session’s pitch and speed zones…'}
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
  /** The pitch's four GPS corners (Phase 5) — this session's measured ones, else the built-in fallback. */
  corners: LatLon[];
  /** Identity of `corners`, used to re-key the canvas + boundary when the pitch changes. */
  pitchKey: string;
  /** Called when the WS upgrade is closed 'unauthorized' — App re-checks /auth/me (→ <Login>). */
  onUnauthorized: () => void;
}

/**
 * The telemetry-bound subtree, mounted only once a session is selected so its useLiveTelemetry hook is
 * unconditional within it. Holds the visible connection banner, the canvas + accessible mirror, and the
 * 1 Hz active-player count. The wake-lock lives here because it is driven by the live connection phase.
 */
function LiveView({
  session,
  theme,
  reducedMotion,
  roster,
  thresholds,
  corners,
  pitchKey,
  onUnauthorized,
}: LiveViewProps) {
  const { store, health, dist, conn, reconnectNow } = useLiveTelemetry(session, onUnauthorized);

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
      // serverNow(), not Date.now(): `serverTs` is stamped by the SERVER, so counting against this
      // tablet's clock would report 0 players over a healthy feed whenever the tablet runs fast
      // (audit C-1). The correction is inert until the first frame arrives.
      const now = serverNow();
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
        {/* Phase 5 (audit C-2): the way OUT of a dead feed. Offered whenever the connection is not
            live AND retrying could plausibly help — i.e. a network drop or the terminal give-up, but
            never an authz refusal, where a button would only invite jabbing at a locked door. */}
        {shouldOfferReconnect(conn) ? (
          <button type="button" onClick={reconnectNow} style={controlStyle(false)}>
            Reconnect now
          </button>
        ) : null}
      </div>

      <ErrorBoundary
        title="The live pitch couldn't be drawn"
        sessionId={session}
        resetKey={`${session}:${pitchKey}`}
      >
        <PitchCanvas
          key={pitchKey}
          store={store}
          health={health}
          dist={dist}
          conn={conn}
          theme={theme}
          reducedMotion={reducedMotion}
          roster={roster}
          thresholds={thresholds}
          corners={corners}
        />
        <A11yMirror
          store={store}
          health={health}
          dist={dist}
          conn={conn}
          roster={roster}
          thresholds={thresholds}
          corners={corners}
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

/**
 * Every interactive control in the shell (Phase 5; audit §6 "Client": touch targets ~24-25 px, WCAG
 * 2.5.5 wants 44). These are pressed on a tablet held in one hand, at the side of a pitch, often in
 * rain or with gloves on — a 24 px target there is not a style preference, it is a missed tap while
 * a coach is trying to look at children. `minHeight`/`minWidth` rather than a fixed size so a long
 * label still grows, and the e2e gate measures the rendered boxes.
 */
const TOUCH_TARGET_PX = 44;

function controlStyle(active: boolean): React.CSSProperties {
  return {
    cursor: 'pointer',
    fontSize: 13,
    minHeight: TOUCH_TARGET_PX,
    minWidth: TOUCH_TARGET_PX,
    padding: '0 14px',
    borderRadius: 8,
    border: '1px solid #2a2d33',
    background: active ? '#ffdf2b' : '#16181d',
    color: active ? '#000' : '#e8e8e8',
  };
}

function pickerInputStyle(theme: Theme): React.CSSProperties {
  return {
    fontSize: 13,
    minHeight: TOUCH_TARGET_PX,
    minWidth: TOUCH_TARGET_PX,
    padding: '0 10px',
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
