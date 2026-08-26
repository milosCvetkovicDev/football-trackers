import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { sendBeacon } from './beacon';

interface Props {
  children: ReactNode;
  /** Headline for this boundary's scope, e.g. "Match review couldn't load". */
  title?: string;
  /** Label for the recovery action; omit for no button (the root boundary has nowhere to go). */
  resetLabel?: string;
  /** Called when the recovery action is pressed, after the boundary clears its error. */
  onReset?: () => void;
  /** Session id, so a caught crash can be reported (kind only — never the message; see beacon.ts). */
  sessionId?: string;
  /**
   * Changing this value clears a caught error. Wire it to whatever "try something else" means for the
   * wrapped subtree (the session, the review window) so a boundary can't strand the coach on a stale
   * failure after the thing that failed has changed underneath it.
   */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
  resetKey?: string | number;
}

/**
 * UI for render-time crashes in one subtree.
 *
 * PHASE 5 (audit §6 "Client": *ErrorBoundary only wraps the live canvas — Review white-screens the
 * whole root*). Two things changed. It is now SCOPED — one boundary around the live canvas, one
 * around Review, one at the root as a backstop — so a crash inside Review takes down Review and
 * leaves the shell (header, session, Live/Review toggle) standing. And it is RECOVERABLE: the
 * fallback offers a way back instead of leaving "reload the page" as the only exit, which on a
 * pitch-side tablet mid-match is a genuinely expensive instruction.
 *
 * A caught crash is also reported (`render_error`) — a KIND only. The error MESSAGE never leaves the
 * device: messages routinely interpolate whatever data was being rendered, and on this system that
 * data is children's names and positions.
 *
 * A class component is required here: error boundaries still have no hooks equivalent in React 19.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // A changed resetKey clears the error, so the subtree re-mounts and tries again.
    if (props.resetKey !== state.resetKey) {
      return { resetKey: props.resetKey, error: null };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the stack to the console for field debugging; the UI stays calm.
    console.error('ErrorBoundary caught a render error:', error, info.componentStack);
    if (this.props.sessionId) sendBeacon('render_error', this.props.sessionId);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Heuristic: a degenerate-homography throw is almost always bad pitch corners, so point the
    // operator straight at the thing they need to fix. Since Phase 5 the corners usually come from
    // session config (`session-config.ts set-pitch`), with src/config.ts as the fallback.
    const isConfigError = /degenerate homography/i.test(error.message);

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          background: '#0e0f12',
          color: '#e8e8e8',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          textAlign: 'center',
          border: '1px solid #2a2d33',
          borderRadius: 10,
          width: '100%',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, color: '#ff5d5d' }}>
          {this.props.title ?? "This view couldn't be shown"}
        </h2>
        <p style={{ margin: 0, maxWidth: 520, fontSize: 14, lineHeight: 1.5, opacity: 0.85 }}>
          {isConfigError ? (
            <>
              This looks like a pitch-corner configuration problem: the four GPS corners are collinear
              or coincident, so the GPS&nbsp;→&nbsp;pitch mapping can&apos;t be solved. Re-measure them
              with <code>session-config.ts set-pitch</code>, or check the fallback{' '}
              <code>PITCH_CORNERS</code> in <code>src/config.ts</code>.
            </>
          ) : (
            <>Something went wrong while rendering. See the browser console for details.</>
          )}
        </p>
        <pre
          style={{
            margin: 0,
            maxWidth: 520,
            overflowX: 'auto',
            padding: '8px 12px',
            borderRadius: 8,
            background: '#1a1c20',
            color: '#ffb4b4',
            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            fontSize: 12,
          }}
        >
          {error.message}
        </pre>
        {this.props.resetLabel ? (
          <button type="button" onClick={this.handleReset} style={resetButtonStyle}>
            {this.props.resetLabel}
          </button>
        ) : null}
      </div>
    );
  }
}

// 44 px minimum (WCAG 2.5.5) — this button is pressed on a wet tablet, possibly with gloves, by
// someone who has just lost their view of the pitch.
const resetButtonStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: 14,
  minHeight: 44,
  minWidth: 44,
  padding: '0 16px',
  borderRadius: 8,
  border: '1px solid #2a2d33',
  background: '#16181d',
  color: '#e8e8e8',
};
