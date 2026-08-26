/**
 * pitchFrame.test.ts — Phase 5 unit gate for the shared pitch frame (audit §6 "Client": off-pitch
 * players clipped invisibly while still counted, and PITCH_CORNERS compile-time).
 *
 * TWO PROPERTIES ARE PINNED HERE.
 *
 * 1. ONE definition of "off pitch". The canvas clips a dot that lands outside the drawn rectangle —
 *    it silently disappears while the HUD keeps counting it, so a coach reads "11 players" over a
 *    pitch showing 10. The canvas and the accessible mirror must therefore agree on *which* players
 *    are off, which means the test is against a single pure frame both consume — not against pixels.
 *
 * 2. Corners off the wire are UNTRUSTED. Phase 5 moves the pitch corners into session config, so the
 *    four points now arrive over HTTP. `parsePitchCorners` is the boundary: anything that would make
 *    the homography throw (collinear/coincident/self-crossing) or that is not plausibly a pitch must
 *    be rejected so the caller falls back to the built-in corners, NOT crash the whole coach view.
 */
import { test, expect } from 'bun:test';
import {
  makePitchFrame,
  parsePitchCorners,
  OFF_PITCH_MARGIN_M,
  PITCH_MIN_SIDE_M,
  PITCH_MAX_SIDE_M,
} from './pitchFrame';
import type { LatLon } from './geo';

// --- A synthetic ~105 x 68 m pitch built from metre offsets, so every assertion below is stated in
// metres rather than in opaque decimal degrees. ---------------------------------------------------
const BASE: LatLon = { lat: 44.812806, lon: 20.460535 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180);
/** `east` metres and `north` metres from the top-left corner. */
const at = (east: number, north: number): LatLon => ({
  lat: BASE.lat + north / M_PER_DEG_LAT,
  lon: BASE.lon + east / M_PER_DEG_LON,
});

const W = 105;
const H = 68;
// On-screen order: TL, TR, BR, BL. North is UP, so the two "bottom" corners are 68 m SOUTH.
const CORNERS: LatLon[] = [at(0, 0), at(W, 0), at(W, -H), at(0, -H)];

test('the four corners map to the unit square in on-screen order', () => {
  const f = makePitchFrame(CORNERS);
  const near = ([u, v]: [number, number], eu: number, ev: number) => {
    expect(Math.abs(u - eu)).toBeLessThan(1e-6);
    expect(Math.abs(v - ev)).toBeLessThan(1e-6);
  };
  near(f.toUnit(CORNERS[0].lat, CORNERS[0].lon), 0, 0); // TL
  near(f.toUnit(CORNERS[1].lat, CORNERS[1].lon), 1, 0); // TR
  near(f.toUnit(CORNERS[2].lat, CORNERS[2].lon), 1, 1); // BR
  near(f.toUnit(CORNERS[3].lat, CORNERS[3].lon), 0, 1); // BL
  near(f.toUnit(at(W / 2, -H / 2).lat, at(W / 2, -H / 2).lon), 0.5, 0.5); // centre spot
});

test('the frame reports the pitch dimensions it was built from', () => {
  const f = makePitchFrame(CORNERS);
  expect(Math.abs(f.widthM - W)).toBeLessThan(0.5);
  expect(Math.abs(f.heightM - H)).toBeLessThan(0.5);
});

test('a player inside the pitch is never flagged off-pitch', () => {
  const f = makePitchFrame(CORNERS);
  expect(f.isOffPitch(at(1, -1).lat, at(1, -1).lon)).toBe(false);
  expect(f.isOffPitch(at(W - 1, -H + 1).lat, at(W - 1, -H + 1).lon)).toBe(false);
  expect(f.isOffPitch(at(W / 2, -H / 2).lat, at(W / 2, -H / 2).lon)).toBe(false);
});

test('the margin absorbs GNSS noise at the touchline but not a real walk-off', () => {
  const f = makePitchFrame(CORNERS);
  // A metre outside the line is a player ON the line plus GPS error — still drawn, not flagged.
  const justOut = at(W / 2, OFF_PITCH_MARGIN_M / 2);
  expect(f.isOffPitch(justOut.lat, justOut.lon)).toBe(false);
  // Ten metres beyond the touchline is a substitute on the bench: outside the drawn rectangle, so
  // the canvas would clip it into invisibility — this is exactly the case that must be flagged.
  const wayOut = at(W / 2, OFF_PITCH_MARGIN_M + 10);
  expect(f.isOffPitch(wayOut.lat, wayOut.lon)).toBe(true);
  // ...and on every side.
  expect(f.isOffPitch(at(-20, -H / 2).lat, at(-20, -H / 2).lon)).toBe(true);
  expect(f.isOffPitch(at(W + 20, -H / 2).lat, at(W + 20, -H / 2).lon)).toBe(true);
  expect(f.isOffPitch(at(W / 2, -H - 20).lat, at(W / 2, -H - 20).lon)).toBe(true);
});

test('a non-finite coordinate reads as off-pitch rather than throwing', () => {
  const f = makePitchFrame(CORNERS);
  expect(f.isOffPitch(Number.NaN, 20.5)).toBe(true);
  expect(f.isOffPitch(44.7, Number.POSITIVE_INFINITY)).toBe(true);
});

// --- parsePitchCorners: the untrusted-wire boundary ------------------------------------------------

test('parsePitchCorners accepts a well-formed four-corner pitch', () => {
  const parsed = parsePitchCorners(CORNERS.map((c) => ({ lat: c.lat, lon: c.lon })));
  expect(parsed).not.toBeNull();
  expect(parsed!.length).toBe(4);
  expect(parsed![2].lat).toBeCloseTo(CORNERS[2].lat, 9);
  // A FRESH literal per corner — a stray field on the wire must not ride into the render layer.
  expect(Object.keys(parsed![0]).sort()).toEqual(['lat', 'lon']);
});

test('parsePitchCorners strips extra fields rather than passing them through', () => {
  const parsed = parsePitchCorners(
    CORNERS.map((c) => ({ lat: c.lat, lon: c.lon, displayName: 'never', __proto__: null })),
  );
  expect(parsed).not.toBeNull();
  expect(Object.keys(parsed![0]).sort()).toEqual(['lat', 'lon']);
});

test('parsePitchCorners rejects anything that is not four usable corners', () => {
  expect(parsePitchCorners(null)).toBeNull();
  expect(parsePitchCorners(undefined)).toBeNull();
  expect(parsePitchCorners('nope')).toBeNull();
  expect(parsePitchCorners([])).toBeNull();
  expect(parsePitchCorners(CORNERS.slice(0, 3))).toBeNull(); // three corners cannot fix 8 DOF
  expect(parsePitchCorners([...CORNERS, CORNERS[0]])).toBeNull(); // five
  expect(parsePitchCorners([{ lat: 1 }, ...CORNERS.slice(1)])).toBeNull(); // missing lon
  expect(parsePitchCorners([{ lat: 'a', lon: 1 }, ...CORNERS.slice(1)])).toBeNull();
  expect(parsePitchCorners([{ lat: Number.NaN, lon: 20 }, ...CORNERS.slice(1)])).toBeNull();
  expect(parsePitchCorners([{ lat: 91, lon: 20 }, ...CORNERS.slice(1)])).toBeNull(); // out of range
  expect(parsePitchCorners([{ lat: 44, lon: 181 }, ...CORNERS.slice(1)])).toBeNull();
});

test('parsePitchCorners rejects the geometries that make the homography throw', () => {
  // Coincident corners: the 8x8 solve hits a zero pivot -> 'degenerate homography' -> white screen.
  expect(parsePitchCorners([CORNERS[0], CORNERS[0], CORNERS[2], CORNERS[3]])).toBeNull();
  // Three collinear corners: same failure, and the audit's motivating case for the ErrorBoundary.
  expect(parsePitchCorners([at(0, 0), at(50, 0), at(105, 0), at(0, -68)])).toBeNull();
  // Bow-tie (TR and BR swapped): solvable, but it folds the pitch over itself and maps players to
  // mirrored nonsense — a silent wrong answer is worse than a rejected config.
  expect(parsePitchCorners([at(0, 0), at(W, -H), at(W, 0), at(0, -H)])).toBeNull();
});

test('parsePitchCorners rejects a quad that is not plausibly a football pitch', () => {
  const tiny = PITCH_MIN_SIDE_M - 2;
  expect(parsePitchCorners([at(0, 0), at(tiny, 0), at(tiny, -tiny), at(0, -tiny)])).toBeNull();
  const huge = PITCH_MAX_SIDE_M + 50;
  expect(parsePitchCorners([at(0, 0), at(huge, 0), at(huge, -68), at(0, -68)])).toBeNull();
  // A 105 x 68 pitch sits comfortably inside both bounds.
  expect(parsePitchCorners(CORNERS)).not.toBeNull();
});
