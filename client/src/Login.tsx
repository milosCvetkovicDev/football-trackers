import { useState } from 'react';
import type { FormEvent } from 'react';
import type { UseAuth } from './contracts';

interface Props {
  /** The auth provider's login(): POST /auth/login + confirm via /auth/me. */
  login: UseAuth['login'];
  /** High-contrast sunlight palette for pitch-side tablets, matching App's outdoor toggle. */
  theme?: 'normal' | 'outdoor';
  /**
   * When present, renders a "Back to the live view" escape hatch. Set ONLY on the isolated-LAN anon
   * stack, where signing in is optional (it buys names + Review) rather than the way in — without it a
   * coach who opens the form has no way back to the pitch but a page reload.
   */
  onCancel?: () => void;
}

/**
 * The named-operator login gate (Phase 2, ADR-0015/0008). Rendered by App whenever auth is
 * 'anonymous'. On success the provider flips to 'authed' and App re-renders the live shell — this
 * form is then unmounted, so nothing here persists a credential beyond the in-flight request.
 *
 * Accessibility: both inputs are labelled, the username input takes focus on mount (a keyboard/SR anchor),
 * the password field declares `current-password` autocomplete, and the failure message lands in a
 * `role="alert"` region as TEXT (not colour) so screen readers announce it and colour-blind operators can
 * read it. The submit button is disabled while the request is in flight to prevent a double-submit (which
 * would also trip the server's per-IP throttle).
 */
export function Login({ login, theme = 'normal', onCancel }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const outdoor = theme === 'outdoor';
  const pal = {
    bg: outdoor ? '#000' : '#0e0f12',
    surface: outdoor ? '#0a0a0a' : '#16181d',
    border: outdoor ? '#666' : '#2a2d33',
    text: outdoor ? '#fff' : '#e8e8e8',
    muted: outdoor ? '#cfcfcf' : '#9a9a9a',
    accent: outdoor ? '#ffdf2b' : '#3b82f6',
    accentText: outdoor ? '#000' : '#fff',
    error: outdoor ? '#ffd23f' : '#ff5d5d',
    inputBg: outdoor ? '#111' : '#0e0f12',
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    // Trim the username (leading/trailing whitespace is never meaningful in a login name); the
    // password is sent verbatim — trimming it would silently change a legitimate credential.
    const result = await login(username.trim(), password);
    if (!result.ok) {
      setError(result.error);
      setSubmitting(false);
      return;
    }
    // On success the parent observes the authed state and re-renders, unmounting this form; we
    // intentionally leave `submitting` true so the button stays disabled during that brief handoff.
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        background: pal.bg,
        color: pal.text,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <form
        onSubmit={onSubmit}
        aria-labelledby="login-heading"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          width: '100%',
          maxWidth: 320,
          padding: 24,
          borderRadius: 12,
          border: `1px solid ${pal.border}`,
          background: pal.surface,
        }}
      >
        <h1 id="login-heading" style={{ margin: 0, fontSize: 18, letterSpacing: 0.3 }}>
          football-trackers · sign in
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: pal.muted, lineHeight: 1.4 }}>
          Coach access to the live pitch view.
        </p>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Username</span>
          <input
            type="text"
            name="username"
            // Focus on mount: the whole page is just this gate, so anchoring keyboard + SR users on the first
            // field is the expected behaviour (no content is skipped past).
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
            required
            style={inputStyle(pal)}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            required
            style={inputStyle(pal)}
          />
        </label>

        {/* role="alert" already implies aria-live="assertive" + aria-atomic, so the failure is announced
            immediately without the double-announce some screen readers do when both are set. It's TEXT, not
            colour-only, so it reads for colour-blind operators and assistive tech. Reserves no space when empty. */}
        <div
          role="alert"
          style={{
            fontSize: 13,
            lineHeight: 1.4,
            minHeight: error ? undefined : 0,
            color: pal.error,
          }}
        >
          {error}
        </div>

        <button
          type="submit"
          disabled={submitting}
          style={{
            cursor: submitting ? 'progress' : 'pointer',
            fontSize: 14,
            fontWeight: 600,
            padding: '10px 14px',
            borderRadius: 8,
            border: 'none',
            background: pal.accent,
            color: pal.accentText,
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={{
              cursor: 'pointer',
              fontSize: 13,
              padding: '8px 14px',
              borderRadius: 8,
              border: `1px solid ${pal.border}`,
              background: 'transparent',
              color: pal.muted,
            }}
          >
            Back to the live view
          </button>
        ) : null}
      </form>
    </div>
  );
}

/** Shared input styling — derived from the active palette so it tracks the outdoor toggle. */
function inputStyle(pal: { border: string; text: string; inputBg: string }): React.CSSProperties {
  return {
    fontSize: 15,
    padding: '8px 10px',
    borderRadius: 8,
    border: `1px solid ${pal.border}`,
    background: pal.inputBg,
    color: pal.text,
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  };
}
