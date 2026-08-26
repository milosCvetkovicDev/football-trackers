import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * The ROOT boundary (Phase 5; audit §6 "Client"). It is the backstop, not the working boundary: the
 * live canvas and Review each have their own, so a crash in either leaves the shell standing and the
 * other reachable. This one only catches a throw in the shell itself — auth gate, header, session
 * picker — where there is nothing left to fall back to, so it offers no "go back" action, only an
 * honest statement of what happened instead of a white page.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary title="The coach view couldn't start">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
