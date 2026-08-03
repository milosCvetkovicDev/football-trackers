/**
 * Youth speed-zone classification (Phase 4; ADR-0019, metric-definitions.md §3). Pure + tiny so the canvas,
 * the accessible mirror, and the review breakdown all classify a speed IDENTICALLY.
 *
 * This module does NOT hold the band→threshold table — thresholds come from the server (GET
 * /sessions/:id/config), the single source of truth. It only (a) classifies a speed against given thresholds
 * and (b) names/colours the five zones. The ONE exception is DEFAULT_THRESHOLDS: a U14 fallback used ONLY
 * while the config fetch is in flight or has failed, so zones still render (it mirrors the server's default band).
 */
import type { ZoneThresholds } from './types';

export type Zone = 1 | 2 | 3 | 4 | 5;

/**
 * Classify a speed (m/s) into zone 1–5 using a descending `>=` cascade, so a value EXACTLY at a threshold
 * lands in the HIGHER zone — matching the half-open intervals in metric-definitions §3.1 and the server's
 * review breakdown (they MUST agree at a boundary). A negative/NaN speed falls through to Z1.
 */
export function speedZone(v: number, t: ZoneThresholds): Zone {
  if (v >= t.sprintMps) return 5;
  if (v >= t.hsrMps) return 4;
  if (v >= t.runMps) return 3;
  if (v >= t.jogMps) return 2;
  return 1;
}

/** Zone word — carries the meaning for assistive tech + colour-blind users (colour is a redundant extra). */
export const ZONE_LABEL: Record<Zone, string> = {
  1: 'walk',
  2: 'jog',
  3: 'run',
  4: 'HSR',
  5: 'sprint',
};

/** Cool→hot ramp. Colour is ALWAYS paired with the word (a11y) — never the sole signal. */
export const ZONE_COLOR: Record<Zone, string> = {
  1: '#6b7280', // walking — slate grey
  2: '#3ddc84', // jogging — green
  3: '#ffd23f', // running — yellow
  4: '#ff9f40', // HSR — orange
  5: '#ff5d5d', // sprint — red
};

/**
 * U14 fallback thresholds — used ONLY before/without a fetched session config, so live zones still render.
 * Mirrors the server's DEFAULT_AGE_BAND (U14) row of the §3.2 table; once /sessions/:id/config resolves, the
 * SERVER's thresholds are used instead. (This is the single small, documented duplication of one band's row.)
 */
export const DEFAULT_THRESHOLDS: ZoneThresholds = { jogMps: 2.0, runMps: 4.0, hsrMps: 4.86, sprintMps: 5.83 };
