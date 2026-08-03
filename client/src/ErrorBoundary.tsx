import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort UI for render-time crashes. The motivating case is the homography
 * solve throwing 'degenerate homography (are 3 corners collinear?)' when
 * PITCH_CORNERS in src/config.ts is misconfigured — without a boundary that bubbles
 * to the root and white-screens the whole coach view. A class component is required
 * here: error boundaries have no hooks equivalent in React 19.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the stack to the console for field debugging; the UI stays calm.
    console.error('ErrorBoundary caught a render error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Heuristic: a degenerate-homography throw is almost always bad pitch corners,
    // so point the operator straight at the file they need to fix.
    const isConfigError = /degenerate homography/i.test(error.message);

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
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
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18, color: '#ff5d5d' }}>
          The live view couldn&apos;t start
        </h1>
        <p style={{ margin: 0, maxWidth: 520, fontSize: 14, lineHeight: 1.5, opacity: 0.85 }}>
          {isConfigError ? (
            <>
              This looks like a pitch-corner configuration problem: the four GPS corners
              are collinear or coincident, so the GPS&nbsp;→&nbsp;pitch mapping can&apos;t be
              solved. Check the four <code>PITCH_CORNERS</code> in{' '}
              <code>src/config.ts</code> are a real (non-degenerate) rectangle.
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
      </div>
    );
  }
}
