import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Reports whether the user has asked the OS to minimise non-essential motion.
 * Returned so callers (e.g. PitchCanvas's `reducedMotion` prop) can drop the
 * position interpolation/trail and any CSS transitions — animation on an
 * always-on pitch-side tablet is exactly the kind of motion this setting targets.
 *
 * SSR / no-`matchMedia` safe: defaults to `false` (no special accommodation) and
 * never touches `window` during render, only inside the effect.
 */
export function useReducedMotion(): boolean {
  // Lazy initialiser so the first paint already reflects the preference in the
  // browser, while still returning a stable default where matchMedia is absent.
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    // Re-sync on mount in case the preference changed between the lazy init and now.
    setReduced(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
