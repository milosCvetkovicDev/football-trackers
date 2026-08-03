/**
 * Pure, canvas-free position smoothing for the live view — the ADR-0018 "honesty rule".
 *
 * The rendered dot is a *child's real location*, so smoothing must never fabricate a
 * position a coach would act on. These functions implement the bounded, gap-aware,
 * non-extrapolating policy from ADR-0018:
 *   - interpolate (damped lerp) between the last two received fixes ONLY when their
 *     serverTs gap is small (< INTERP_MAX_GAP_MS) — a true 10 Hz stream;
 *   - SNAP to the newest fix across any wider gap (dropout / backlog-replay / burst),
 *     so we never draw a glide across a gap that never happened;
 *   - NEVER extrapolate past the newest fix — once `now` exceeds the newest serverTs we
 *     hold at the last real position;
 *   - CLAMP the implied inter-fix speed to MAX_PLAUSIBLE_SPEED_MPS so a single bad fix
 *     can't fling the dot across the pitch.
 * Everything here is unit-testable: no canvas, no DOM, no clock — `now` is passed in.
 */
import { INTERP_MAX_GAP_MS, MAX_PLAUSIBLE_SPEED_MPS } from '../config';

/** A received fix reduced to the fields position-smoothing cares about. */
export interface FixSample {
  /** Authoritative ingest clock (ms) — ordering + interpolation domain (NOT device `ts`). */
  serverTs: number;
  lat: number;
  lon: number;
}

/**
 * Per-player buffer of the last two *received* fixes (newest = `b`). A new fix is detected
 * by a changed `serverTs` (see pushFix); identical-serverTs frames are ignored so the rAF
 * loop reading the store many times per fix doesn't corrupt the buffer.
 */
export interface FixBuffer {
  a: FixSample | null; // previous fix
  b: FixSample | null; // newest fix
}

export function emptyBuffer(): FixBuffer {
  return { a: null, b: null };
}

/**
 * Record a fix into the buffer, but only if it's genuinely new (serverTs changed). Returns the
 * same buffer mutated in place — buffers are per-player scratch state owned by the caller.
 * Keeping this here (not in the component) lets the test prove the "new fix" detection.
 */
export function pushFix(buf: FixBuffer, fix: FixSample): FixBuffer {
  // No change in the authoritative clock → same fix re-read; leave the buffer untouched.
  if (buf.b && buf.b.serverTs === fix.serverTs) return buf;
  buf.a = buf.b;
  buf.b = fix;
  return buf;
}

/**
 * Resolve the position to render *right now* for one player, in lat/lon (projection to pixels
 * is the caller's job — this stays geometry-agnostic and pure).
 *
 * @param buf       the player's two-fix buffer
 * @param now       current time in the same domain as serverTs (ms)
 * @param projLatLonToM  projects lat/lon → local metres, used ONLY to clamp implied speed in a
 *                       distance unit that's meaningful (degrees are anisotropic). Reuse the
 *                       app's `makeProjector` so the clamp matches the rest of the pipeline.
 * @param snapOnly  true under prefers-reduced-motion → never interpolate, always the newest fix.
 */
export function resolvePosition(
  buf: FixBuffer,
  now: number,
  projLatLonToM: (p: { lat: number; lon: number }) => [number, number],
  snapOnly: boolean,
): { lat: number; lon: number } | null {
  const { a, b } = buf;
  if (!b) return null; // nothing received yet
  // Reduced motion, or only one fix so far → snap to the newest real position.
  if (snapOnly || !a) return { lat: b.lat, lon: b.lon };

  const gap = b.serverTs - a.serverTs;
  // Wider than the honesty threshold (or non-positive / out-of-order) → SNAP, don't glide.
  if (gap <= 0 || gap >= INTERP_MAX_GAP_MS) return { lat: b.lat, lon: b.lon };

  // Implied inter-fix speed: if a bad fix jumped further than a child plausibly could in `gap`,
  // don't smooth toward it — snap so the dot can't be flung across the pitch.
  const [ax, ay] = projLatLonToM(a);
  const [bx, by] = projLatLonToM(b);
  const distM = Math.hypot(bx - ax, by - ay);
  const impliedSpeed = distM / (gap / 1000);
  if (impliedSpeed > MAX_PLAUSIBLE_SPEED_MPS) return { lat: b.lat, lon: b.lon };

  // Honest bounded interpolation. `frac` is time-since-`a` over the gap, but NEVER extrapolated:
  // once `now` passes `b.serverTs` we hold at `b` (clamp to 1), never project beyond it.
  const frac = clamp01((now - a.serverTs) / gap);
  return {
    lat: a.lat + (b.lat - a.lat) * frac,
    lon: a.lon + (b.lon - a.lon) * frac,
  };
}

/** Clamp a fraction to [0, 1] — the guard that makes "never extrapolate" literal. */
export function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
