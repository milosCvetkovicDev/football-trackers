/**
 * zones.test.ts — Phase 4 unit gate for the pure speed-zone classifier (zones.ts).
 *
 * The single load-bearing rule (metric-definitions §3.1, contract §1): the zone intervals are
 * HALF-OPEN, so a speed EXACTLY at a threshold lands in the HIGHER zone. The client `speedZone`
 * and the server review breakdown MUST use this identical descending `>=` cascade so live colour
 * and the review breakdown never disagree at a boundary. These cases pin that boundary behaviour
 * (the exact-threshold → higher zone direction) plus the below-floor and known-speed mappings.
 */
import { test, expect } from 'bun:test';
import { speedZone, DEFAULT_THRESHOLDS, ZONE_LABEL, ZONE_COLOR } from './zones';
import type { ZoneThresholds } from './types';

// A deliberately round, distinct-from-default threshold set so the "exactly at threshold → higher
// zone" assertions can't accidentally pass against DEFAULT_THRESHOLDS' real numbers.
const T: ZoneThresholds = { jogMps: 2.0, runMps: 4.0, hsrMps: 6.0, sprintMps: 8.0 };

test('exactly at a threshold lands in the HIGHER zone (half-open intervals)', () => {
  // v === jog → Z2 (not Z1); v === run → Z3; v === hsr → Z4; v === sprint → Z5.
  expect(speedZone(T.jogMps, T)).toBe(2);
  expect(speedZone(T.runMps, T)).toBe(3);
  expect(speedZone(T.hsrMps, T)).toBe(4);
  expect(speedZone(T.sprintMps, T)).toBe(5);
});

test('below the walking/jog floor classifies as Z1 (walk)', () => {
  expect(speedZone(0, T)).toBe(1);
  expect(speedZone(1.99, T)).toBe(1);
  // A negative or NaN speed falls through the cascade to Z1 (defensive — never throws / NaN-zone).
  expect(speedZone(-3, T)).toBe(1);
  expect(speedZone(NaN, T)).toBe(1);
});

test('just-below a threshold stays in the LOWER zone (the other side of the boundary)', () => {
  expect(speedZone(T.jogMps - 0.01, T)).toBe(1);
  expect(speedZone(T.runMps - 0.01, T)).toBe(2);
  expect(speedZone(T.hsrMps - 0.01, T)).toBe(3);
  expect(speedZone(T.sprintMps - 0.01, T)).toBe(4);
});

test('mid-band speeds land in the expected zone', () => {
  expect(speedZone(3.0, T)).toBe(2); // jog band [2,4)
  expect(speedZone(5.0, T)).toBe(3); // run band [4,6)
  expect(speedZone(7.0, T)).toBe(4); // HSR band [6,8)
  expect(speedZone(12.0, T)).toBe(5); // sprint band [8,∞)
});

test('DEFAULT_THRESHOLDS (U14) classifies known speeds correctly', () => {
  // U14: jog 2.0, run 4.0, hsr 4.86, sprint 5.83 (the §1 table's default-band row, mirrored in zones.ts).
  expect(DEFAULT_THRESHOLDS).toEqual({ jogMps: 2.0, runMps: 4.0, hsrMps: 4.86, sprintMps: 5.83 });
  expect(speedZone(0.5, DEFAULT_THRESHOLDS)).toBe(1); // walking
  expect(speedZone(3.0, DEFAULT_THRESHOLDS)).toBe(2); // jogging
  expect(speedZone(4.5, DEFAULT_THRESHOLDS)).toBe(3); // running ([4.0, 4.86))
  expect(speedZone(5.0, DEFAULT_THRESHOLDS)).toBe(4); // HSR ([4.86, 5.83))
  expect(speedZone(6.5, DEFAULT_THRESHOLDS)).toBe(5); // sprint
  // The exact U14 HSR + sprint boundaries land in the higher zone, same half-open rule.
  expect(speedZone(4.86, DEFAULT_THRESHOLDS)).toBe(4);
  expect(speedZone(5.83, DEFAULT_THRESHOLDS)).toBe(5);
});

test('ZONE_LABEL + ZONE_COLOR cover all five zones with distinct values', () => {
  // The word carries meaning for a11y / colour-blind users; colour is a redundant extra. Both maps
  // must be keyed 1..5 with no gaps and no duplicate colours (colour is a glance cue, must disambiguate).
  const labels = [1, 2, 3, 4, 5].map((z) => ZONE_LABEL[z as 1 | 2 | 3 | 4 | 5]);
  const colours = [1, 2, 3, 4, 5].map((z) => ZONE_COLOR[z as 1 | 2 | 3 | 4 | 5]);
  expect(labels).toEqual(['walk', 'jog', 'run', 'HSR', 'sprint']);
  expect(new Set(labels).size).toBe(5);
  expect(new Set(colours).size).toBe(5);
});
