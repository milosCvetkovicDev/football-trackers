import type { LatLon } from './geo';

/**
 * Phase 2 (ADR-0015): the client is served SAME-ORIGIN with the server (Vite dev-proxy in dev, Caddy in
 * prod), so the session cookie auto-attaches on the /live upgrade. There is no bundled token and no
 * cross-origin WS URL any more — both were security holes (a bundle-readable bearer secret; token-in-URL
 * leaking to logs/history/Referer). The WS + API targets are derived from the page origin at runtime.
 */

/** Same-origin /live WebSocket URL for a session. The HttpOnly session cookie rides the upgrade. */
export function liveWsUrl(sessionId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/live?sessionId=${encodeURIComponent(sessionId)}`;
}

/** Same-origin API path (relative) — fetch with `credentials:'same-origin'` so the cookie is sent. */
export function apiUrl(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Prefill for the admin "which session?" picker only (admins are wildcard-authorized, so they type/choose
 * a session id). NOT a secret and NOT used for auth — a coach's sessions come from /auth/me, anon's from
 * the server's ANON_SESSIONS.
 */
export const DEFAULT_SESSION = import.meta.env.VITE_DEFAULT_SESSION ?? 'test';

/**
 * FALLBACK pitch corners, in on-screen order:
 *   0 = top-left, 1 = top-right, 2 = bottom-right, 3 = bottom-left.
 * Edges 0->1 and 3->2 are the two touchlines (long sides).
 *
 * PHASE 5 (audit §6 "Client"): the REAL corners come from the server, per session —
 * `GET /sessions/:id/config` returns `pitch:{corners}` when someone has measured them
 * (`bun run session-config.ts set-pitch <session> <TL> <TR> <BR> <BL>` in server/).
 * This constant is only what the view falls back to when a session has no configured
 * pitch: before Phase 5 it was the ONLY source, which meant every real pitch mapped to
 * the wrong box until someone edited this file and rebuilt the bundle.
 *
 * The values below are a ~105x68 m rectangle at deliberately ROUND synthetic coordinates —
 * not anyone's pitch, home, or training ground. They are also intentionally a few km away
 * from the quad the tests/simulator use, so a session without measured corners keeps the
 * off-pitch fallback path honestly exercised (reliability spec §6 depends on that distance).
 */
export const PITCH_CORNERS: LatLon[] = [
  { lat: 44.830000, lon: 20.400000 }, // TL
  { lat: 44.830000, lon: 20.401332 }, // TR
  { lat: 44.829388, lon: 20.401332 }, // BR
  { lat: 44.829388, lon: 20.400000 }, // BL
];

// --- Render / liveness tuning (shared by the canvas and the accessible mirror) ---

/** Fade a dot / mark a fix "stale" once its last fix is older than this. */
export const STALE_MS = 2_000;
/** Stop drawing a player / mark "lost" once its last fix is older than this. */
export const DROP_MS = 10_000;
/**
 * ADR-0018 honesty rule: clamp smoothed motion to a plausible youth sprint (~8 m/s) so a single
 * bad fix can't fling a dot across the pitch, and never interpolate across a gap wider than this.
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 8;
/** Interpolate only between two fixes whose serverTs gap is below this; snap otherwise (ADR-0018). */
export const INTERP_MAX_GAP_MS = 200;
/** Hard cap on tracked players — a bound against a buggy/hostile feed flooding the Map with ids. */
export const MAX_TRACKED_PLAYERS = 64;

/**
 * How many consecutive failed network reconnects before the live socket settles into a terminal,
 * visibly-stopped state (Phase 5, audit C-2). Eight capped-backoff attempts is ~37 s expected and
 * 75 s worst case — long enough to ride out a relay blip, and the point at which continuing to retry
 * silently is less honest than saying so and offering the coach a button.
 *
 * Overridable ONLY so the e2e gate can reach the terminal state in seconds instead of a minute; a
 * bad value falls back to the default LOUDLY (the same rule the server's env.ts follows) rather than
 * becoming NaN, which would make `attempt > MAX_RETRIES` false forever — a silent infinite loop, the
 * exact bug the terminal state exists to remove.
 */
export const MAX_RECONNECT_ATTEMPTS = readAttempts();

function readAttempts(): number {
  const raw = import.meta.env.VITE_MAX_RECONNECT_ATTEMPTS;
  if (raw === undefined || raw === '') return 8;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    console.warn(
      `VITE_MAX_RECONNECT_ATTEMPTS="${raw}" is not an integer in 1..50 — using the default (8).`,
    );
    return 8;
  }
  return n;
}

// --- Device-health thresholds (Phase 3) — shared by the canvas cue + the accessible mirror so they
// classify a tracker's health identically. Status frames arrive ~every 5 s (see firmware/simulate). ---
/** A device whose last status frame is older than this is "unseen" — we can't vouch for its health. */
export const DEVICE_STATUS_STALE_MS = 15_000;
/** Battery percent (when metered, i.e. >= 0): warn below the first, critical below the second. */
export const BATT_PCT_WARN = 30;
export const BATT_PCT_BAD = 15;
/** WiFi RSSI dBm: warn below (weaker than) the first, critical below the second. */
export const RSSI_WARN = -75;
export const RSSI_BAD = -85;
/** Any on-device flash backlog means the tracker is (or was just) unable to reach the broker → warn. */
export const BACKLOG_WARN_BYTES = 1;

// --- Isolated-player cue (Phase 4) — a lightweight, positions-only "no teammate near" hint. A fresh player
// whose nearest fresh teammate stays farther than ISOLATION_M for ≥ ISOLATION_MS gets a distinct cue. ---
/** A player is "isolated" when the nearest fresh teammate is farther than this (metres). */
export const ISOLATION_M = 15;
/** ...and has stayed that far for at least this long (ms) — so a brief gap doesn't flag a false positive. */
export const ISOLATION_MS = 3_000;

// --- Live distance gate (Phase 4, metric-definitions §2.1). These MUST equal server/src/history.ts
// WALK_FLOOR_MPS / PDOP_MAX so the live running distance and the server review distance apply the SAME
// filter and never disagree. (Named here rather than inlined so the duplication is explicit + greppable.) ---
/** Accumulate a distance segment only when v ≥ this walking floor (else GNSS jitter fakes distance). */
export const WALK_FLOOR_MPS = 0.4;
/** ...and the fix's PDOP ≤ this (poor geometry is dropped). The third clause, fix ≥ 2, is checked inline. */
export const PDOP_MAX = 5;
