/**
 * pitchFrame.ts — one definition of "where on the pitch is this player, and are they off it"
 * (Phase 5; audit §6 "Client": off-pitch players clipped invisibly while still counted, and
 * PITCH_CORNERS compile-time).
 *
 * TWO JOBS.
 *
 * 1. A UNIT-SQUARE FRAME. The canvas maps GPS onto whatever pixel rectangle the tablet's layout
 *    gives it, so "is this dot outside the pitch?" cannot be answered from pixels without also
 *    answering "which pixels?" — and the accessible mirror has no pixels at all. This module maps
 *    GPS onto the pitch's own unit square (0,0 = the TL corner … 1,1 = the BR corner), which both
 *    the canvas and the mirror can consume, so they can never disagree about who is off the pitch.
 *    Before Phase 5 an off-pitch player was simply CLIPPED by the canvas — invisible, while the HUD
 *    kept counting them, so the coach read "11 players" over a pitch showing ten.
 *
 * 2. THE UNTRUSTED-CORNERS BOUNDARY. The four corners now arrive from the server (session config)
 *    instead of being compiled into the bundle. `parsePitchCorners` is where a wire value becomes a
 *    usable pitch: it rejects anything that would make the 8x8 homography solve throw (coincident,
 *    collinear, self-crossing) or that is not plausibly a football pitch, so the caller falls back to
 *    the built-in corners instead of white-screening the coach view mid-match.
 */
import { makeProjector, type LatLon } from './geo';
import { applyHomography, computeHomography, type Pt } from './homography';

/**
 * How far outside the touchline a player may be before they are called "off pitch", in metres.
 * Sized for GNSS noise at the line (a few metres) rather than for a rulebook: the question this
 * answers is "would the canvas have silently clipped them?", not "was that throw-in legal".
 */
export const OFF_PITCH_MARGIN_M = 3;

/** Plausibility bounds on a configured pitch's side length, in metres. A youth 5-a-side pitch is
 *  ~30 x 20; a full adult pitch is 105 x 68 and the laws cap it at 120 x 90. Anything outside these
 *  is a units mistake or a mistyped corner, and silently mapping players onto it would be worse than
 *  refusing it. */
export const PITCH_MIN_SIDE_M = 10;
export const PITCH_MAX_SIDE_M = 250;

/** Corners must be at least this far apart, in metres, for the homography to be well conditioned. */
const MIN_CORNER_SEPARATION_M = 1;

export interface PitchFrame {
  /** GPS → the pitch's unit square: [0,0] at the TL corner, [1,1] at the BR corner. */
  toUnit(lat: number, lon: number): [number, number];
  /** True when the point is outside the pitch by more than OFF_PITCH_MARGIN_M (or is not a number). */
  isOffPitch(lat: number, lon: number): boolean;
  /** Touchline length (TL→TR) in metres. */
  widthM: number;
  /** Goal-line length (TL→BL) in metres. */
  heightM: number;
}

/** The unit square, in the same on-screen corner order the rest of the client uses. */
const UNIT_SQUARE: Pt[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * Build the frame for a set of corners in on-screen order (TL, TR, BR, BL).
 * THROWS on a degenerate quad — pass corners that came from `parsePitchCorners` or from the built-in
 * fallback, never raw wire values.
 */
export function makePitchFrame(corners: LatLon[]): PitchFrame {
  const project = makeProjector(corners[0]);
  const srcM = corners.map(project);
  const H = computeHomography(srcM, UNIT_SQUARE);

  const widthM = Math.hypot(srcM[1][0] - srcM[0][0], srcM[1][1] - srcM[0][1]);
  const heightM = Math.hypot(srcM[3][0] - srcM[0][0], srcM[3][1] - srcM[0][1]);
  // Convert the metre margin into the unit frame ONCE — the hot path is per-player, per-frame.
  const marginU = OFF_PITCH_MARGIN_M / Math.max(widthM, 1e-6);
  const marginV = OFF_PITCH_MARGIN_M / Math.max(heightM, 1e-6);

  const toUnit = (lat: number, lon: number): [number, number] =>
    applyHomography(H, project({ lat, lon }));

  return {
    toUnit,
    isOffPitch(lat: number, lon: number): boolean {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true; // unplaceable ⇒ not on the pitch
      const [u, v] = toUnit(lat, lon);
      if (!Number.isFinite(u) || !Number.isFinite(v)) return true;
      return u < -marginU || u > 1 + marginU || v < -marginV || v > 1 + marginV;
    },
    widthM,
    heightM,
  };
}

/** Finite number in a closed range. */
function inRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

/** 2-D cross product of the edges meeting at b — its SIGN is the turn direction at that corner. */
function cross(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
}

/**
 * Validate four corners off the wire. Returns freshly-built `{lat, lon}` objects (so a stray field on
 * the wire is structurally stripped, exactly like the telemetry validator) or `null` when the quad is
 * unusable — in which case the caller keeps its built-in corners.
 *
 * KNOWN LIMIT (both validators, deliberately): the projection is a local flat-plane approximation
 * around corner 0, so a quad straddling the ±180° meridian projects to a ~40 000 km "side" and is
 * rejected by the length bound. The consequence is a fallback to the built-in corners, not a wrong
 * mapping — and the alternative (wrapping longitude) would add a branch nothing here can exercise.
 *
 * The geometry rules exist because the client SOLVES a homography from these four points:
 *   - coincident or collinear corners hit a zero pivot and throw 'degenerate homography';
 *   - a self-crossing (bow-tie) order solves fine but folds the pitch over itself, mapping players to
 *     mirrored nonsense — a silent wrong answer, which is worse than a refused config;
 *   - a quad far outside pitch dimensions is a mistyped or mis-united coordinate.
 */
export function parsePitchCorners(value: unknown): LatLon[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;

  const corners: LatLon[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const c = raw as Record<string, unknown>;
    if (!inRange(c.lat, -90, 90) || !inRange(c.lon, -180, 180)) return null;
    corners.push({ lat: c.lat, lon: c.lon }); // fresh literal — nothing else rides along
  }

  // Everything below is in metres on a local plane around corner 0.
  const project = makeProjector(corners[0]);
  const m = corners.map(project);

  // Distinct corners (also catches the coincident case before it reaches the solver).
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (Math.hypot(m[i][0] - m[j][0], m[i][1] - m[j][1]) < MIN_CORNER_SEPARATION_M) return null;
    }
  }

  // Plausible side lengths (TL→TR→BR→BL→TL).
  for (let i = 0; i < 4; i++) {
    const a = m[i];
    const b = m[(i + 1) % 4];
    const side = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (side < PITCH_MIN_SIDE_M || side > PITCH_MAX_SIDE_M) return null;
  }

  // Convex, consistently wound, non-degenerate: every corner must turn the same way, and none may
  // turn by ~nothing (three collinear points). The threshold is in m² — 1 m² over a pitch-scale quad
  // is far below any real corner and far above float noise.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const z = cross(m[i], m[(i + 1) % 4], m[(i + 2) % 4]);
    if (Math.abs(z) < 1) return null; // collinear at this corner
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return null; // a reflex corner ⇒ self-crossing / folded quad
  }

  return corners;
}
