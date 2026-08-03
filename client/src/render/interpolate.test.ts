import { expect, test } from 'bun:test';
import { clamp01, emptyBuffer, pushFix, resolvePosition, type FixBuffer } from './interpolate';
import { INTERP_MAX_GAP_MS, MAX_PLAUSIBLE_SPEED_MPS } from '../config';
import { makeProjector } from '../geo';

// A reference projector around the config test centre; metres-scale so the speed clamp is meaningful.
const REF = { lat: 44.8125, lon: 20.4612 };
const project = makeProjector(REF);
const proj = (p: { lat: number; lon: number }) => project(p);

// ~1 m north of REF, for building plausible vs. implausible jumps.
const M_PER_DEG_LAT = 111_320;
const dLat = (m: number) => m / M_PER_DEG_LAT;

function buf(a: { serverTs: number; lat: number; lon: number }, b: { serverTs: number; lat: number; lon: number }): FixBuffer {
  return { a, b };
}

test('pushFix records a new fix but ignores a re-read of the same serverTs', () => {
  const b = emptyBuffer();
  pushFix(b, { serverTs: 1000, lat: REF.lat, lon: REF.lon });
  pushFix(b, { serverTs: 1000, lat: 99, lon: 99 }); // same serverTs → ignored
  expect(b.b!.serverTs).toBe(1000);
  expect(b.a).toBeNull();
  pushFix(b, { serverTs: 1100, lat: REF.lat + dLat(1), lon: REF.lon });
  expect(b.a!.serverTs).toBe(1000);
  expect(b.b!.serverTs).toBe(1100);
});

test('gap below threshold lerps between the two fixes at the right fraction', () => {
  const a = { serverTs: 1000, lat: REF.lat, lon: REF.lon };
  // 0.5 m in 100 ms = 5 m/s — under the 8 m/s clamp, so it interpolates rather than snaps.
  const b = { serverTs: 1000 + 100, lat: REF.lat + dLat(0.5), lon: REF.lon };
  expect(100).toBeLessThan(INTERP_MAX_GAP_MS);
  const p = resolvePosition(buf(a, b), 1050, proj, false)!; // halfway in time
  expect(p.lat).toBeCloseTo(REF.lat + dLat(0.25), 12); // halfway between a and b
  expect(p.lon).toBeCloseTo(REF.lon, 12);
});

test('gap at/above threshold snaps to the newest fix (no glide across a gap)', () => {
  const a = { serverTs: 1000, lat: REF.lat, lon: REF.lon };
  const b = { serverTs: 1000 + INTERP_MAX_GAP_MS + 5, lat: REF.lat + dLat(1), lon: REF.lon };
  const p = resolvePosition(buf(a, b), 1000 + 10, proj, false)!; // early in the interval
  expect(p.lat).toBeCloseTo(b.lat, 12); // snapped to newest, not lerped near `a`
  expect(p.lon).toBeCloseTo(b.lon, 12);
});

test('never extrapolates past the newest fix — holds at b once now exceeds b.serverTs', () => {
  const a = { serverTs: 1000, lat: REF.lat, lon: REF.lon };
  // 0.5 m in 100 ms (plausible) so this exercises the frac clamp, not the speed clamp.
  const b = { serverTs: 1100, lat: REF.lat + dLat(0.5), lon: REF.lon };
  const p = resolvePosition(buf(a, b), 5000, proj, false)!; // far past b
  expect(p.lat).toBeCloseTo(b.lat, 12); // clamped to b, not projected beyond
  expect(p.lon).toBeCloseTo(b.lon, 12);
});

test('clamps an implausible jump: a too-fast inter-fix move snaps instead of smoothing', () => {
  const a = { serverTs: 1000, lat: REF.lat, lon: REF.lon };
  // 100 m in 100 ms = 1000 m/s, far above MAX_PLAUSIBLE_SPEED_MPS → must snap to b.
  const jumpM = MAX_PLAUSIBLE_SPEED_MPS * 0.1 * 50; // way over plausible for a 100 ms gap
  const b = { serverTs: 1100, lat: REF.lat + dLat(jumpM), lon: REF.lon };
  const p = resolvePosition(buf(a, b), 1050, proj, false)!;
  expect(p.lat).toBeCloseTo(b.lat, 12);
  expect(p.lon).toBeCloseTo(b.lon, 12);
});

test('reducedMotion (snapOnly) always returns the newest fix exactly', () => {
  const a = { serverTs: 1000, lat: REF.lat, lon: REF.lon };
  const b = { serverTs: 1100, lat: REF.lat + dLat(1), lon: REF.lon };
  const p = resolvePosition(buf(a, b), 1050, proj, true)!;
  expect(p.lat).toBe(b.lat);
  expect(p.lon).toBe(b.lon);
});

test('single fix (no previous) snaps; empty buffer returns null', () => {
  expect(resolvePosition(emptyBuffer(), 1000, proj, false)).toBeNull();
  const oneFix: FixBuffer = { a: null, b: { serverTs: 1000, lat: REF.lat, lon: REF.lon } };
  const p = resolvePosition(oneFix, 1000, proj, false)!;
  expect(p.lat).toBe(REF.lat);
});

test('out-of-order / zero gap snaps rather than dividing by zero', () => {
  const a = { serverTs: 1100, lat: REF.lat, lon: REF.lon };
  const b = { serverTs: 1100, lat: REF.lat + dLat(1), lon: REF.lon }; // zero gap
  const p = resolvePosition(buf(a, b), 1100, proj, false)!;
  expect(p.lat).toBeCloseTo(b.lat, 12);
});

test('clamp01 bounds the fraction', () => {
  expect(clamp01(-0.5)).toBe(0);
  expect(clamp01(0.5)).toBe(0.5);
  expect(clamp01(2)).toBe(1);
});
