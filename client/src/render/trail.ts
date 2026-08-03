/**
 * Per-player short motion trail — a few recent *received* positions, faded oldest-first.
 *
 * Kept separate from interpolate.ts because it's a different concern (history vs. the single
 * current position) and so it stays canvas-free and unit-friendly. The trail records one point
 * per genuinely-new fix (changed serverTs), NOT one per rAF frame — otherwise a 30 fps loop over
 * a 10 Hz feed would pack the trail with duplicates and exaggerate motion. Per ADR-0018 the trail
 * is presentation only and is omitted entirely under prefers-reduced-motion (caller's choice).
 */

/** Max points kept per player — a short tail (~0.6 s at 10 Hz), bounded so memory can't grow. */
export const TRAIL_LEN = 6;

export interface TrailPoint {
  lat: number;
  lon: number;
  serverTs: number;
}

/** Append a fix to a player's trail iff it's new (changed serverTs); ring-buffer to TRAIL_LEN. */
export function pushTrail(trail: TrailPoint[], pt: TrailPoint): TrailPoint[] {
  const last = trail[trail.length - 1];
  if (last && last.serverTs === pt.serverTs) return trail; // same fix re-read → ignore
  trail.push(pt);
  if (trail.length > TRAIL_LEN) trail.shift();
  return trail;
}
