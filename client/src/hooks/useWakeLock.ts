import { useEffect, useState } from 'react';

export interface WakeLockState {
  /** Whether the Screen Wake Lock API exists in this browser at all. */
  supported: boolean;
  /** Whether a sentinel is currently held (false while the tab is hidden). */
  held: boolean;
}

/**
 * Keeps the screen awake while `active` (e.g. for the pitch-side tablet that must
 * stay on through a match) using the Screen Wake Lock API.
 *
 * Two facts drive the shape of this hook:
 *   1. The platform auto-releases the lock whenever the document becomes hidden
 *      (tab switch, screen off), so we re-acquire on `visibilitychange` rather
 *      than assume a single acquire sticks.
 *   2. The API is still patchy — feature-detect and no-op gracefully where it's
 *      missing instead of throwing, so unsupported browsers just fall back to the
 *      OS idle timer.
 */
export function useWakeLock(active: boolean): WakeLockState {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!supported || !active) return;

    // Typed locally so we don't depend on lib.dom carrying the WakeLock types yet.
    const wakeLock = (navigator as Navigator & {
      wakeLock: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
    }).wakeLock;

    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;

    const acquire = async () => {
      // Only meaningful when the page is visible; the request is rejected otherwise.
      if (disposed || document.visibilityState !== 'visible') return;
      try {
        sentinel = await wakeLock.request('screen');
        if (disposed) {
          // Effect was torn down mid-request — release immediately, don't leak it.
          void sentinel.release();
          sentinel = null;
          return;
        }
        setHeld(true);
        // The sentinel auto-releases (e.g. on hide); reflect that so callers see it drop.
        sentinel.addEventListener('release', () => setHeld(false));
      } catch {
        // User gesture / permission / power-save can reject — degrade silently.
        setHeld(false);
      }
    };

    const onVisibility = () => {
      // The lock drops when hidden; re-acquire when we come back to the foreground.
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release();
      sentinel = null;
      setHeld(false);
    };
  }, [supported, active]);

  return { supported, held };
}

/** Minimal shape of a WakeLockSentinel — avoids relying on lib.dom having the type. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
