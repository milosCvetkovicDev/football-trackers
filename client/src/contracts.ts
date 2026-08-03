/**
 * Shared contracts for the live view — pinned so the rendering, connection, and
 * accessibility layers agree without importing each other. Pure types + pure helpers only.
 */
import type { RefObject } from 'react';
import type { Telemetry, DeviceHealth, LiveDist } from './types';
import {
  STALE_MS,
  DROP_MS,
  DEVICE_STATUS_STALE_MS,
  BATT_PCT_WARN,
  BATT_PCT_BAD,
  RSSI_WARN,
  RSSI_BAD,
  BACKLOG_WARN_BYTES,
} from './config';

/**
 * Coarse connection lifecycle for the /live WS — richer than raw readyState so the UI can
 * say *why* there's no data and stop the old silent infinite reconnect. The phases map to the
 * 1008 close reasons `server.ts` emits (Phase 2, ADR-0015):
 *   - 'unauthorized'      (reason 'unauthorized' | 'forbidden origin') -> terminal; App re-checks /auth/me
 *   - 'forbidden'         (reason 'forbidden session') -> terminal; authed but not assigned this session
 *   - 'error'             (reason 'bad session' / any other 1008) -> terminal
 *   - any other close / network drop -> 'disconnected', retried with capped backoff, then terminal 'error'
 */
export type ConnectionPhase =
  | 'connecting'
  | 'live'
  | 'disconnected'
  | 'unauthorized' // not logged in / cookie expired — bounce to <Login>
  | 'forbidden' // logged in, but not authorized for THIS session (Phase 2, ADR-0015) — terminal
  | 'error';

export interface ConnectionState {
  phase: ConnectionPhase;
  /** Human-readable detail for the a11y live region and the HUD subtitle. */
  detail?: string;
  /** Reconnect attempts so far; 0 while live. */
  attempt: number;
  /** False for terminal phases (unauthorized / forbidden / error) — the UI must not imply "reconnecting…". */
  willRetry: boolean;
}

/** What `useLiveTelemetry` returns: refs read each rAF frame + the re-render-driving conn. */
export interface LiveTelemetry {
  /** Latest validated telemetry fix per playerId — pseudonymous; names are joined at render only. */
  store: RefObject<Map<string, Telemetry>>;
  /** Latest device-health per playerId from the `.../status` envelope (Phase 3). No TTL — cleared on switch. */
  health: RefObject<Map<string, DeviceHealth>>;
  /** Per-player LIVE running distance (Phase 4). Best-effort glance; resets on reconnect. Cleared on switch. */
  dist: RefObject<Map<string, LiveDist>>;
  conn: ConnectionState;
}

export type PlayerFreshness = 'fresh' | 'stale' | 'lost';

/**
 * Classify a fix's age against the shared staleness thresholds — used by BOTH the canvas HUD
 * and the accessible mirror so they never disagree about a player's state.
 */
export function playerFreshness(ageMs: number): PlayerFreshness {
  if (ageMs > DROP_MS) return 'lost';
  if (ageMs > STALE_MS) return 'stale';
  return 'fresh';
}

export type ConnectionTone = 'ok' | 'warn' | 'bad';

/**
 * One source of truth for the connection label + tone shown on the canvas HUD and announced in
 * the ARIA live region. `activePlayers` surfaces the "connected, no players yet" case distinctly.
 */
export function describeConnection(
  conn: ConnectionState,
  activePlayers: number,
): { label: string; tone: ConnectionTone } {
  switch (conn.phase) {
    case 'connecting':
      return {
        label: conn.attempt > 0 ? `reconnecting (try ${conn.attempt})…` : 'connecting…',
        tone: 'warn',
      };
    case 'live':
      return activePlayers > 0
        ? {
            label: `live · ${activePlayers} player${activePlayers === 1 ? '' : 's'}`,
            tone: 'ok',
          }
        : { label: 'connected · waiting for players', tone: 'warn' };
    case 'disconnected':
      return { label: conn.willRetry ? 'disconnected · reconnecting…' : 'disconnected', tone: 'bad' };
    case 'unauthorized':
      return { label: conn.detail ?? 'unauthorized — check access', tone: 'bad' };
    case 'forbidden':
      return { label: conn.detail ?? 'not authorized for this session', tone: 'bad' };
    case 'error':
      return { label: conn.detail ?? 'connection failed', tone: 'bad' };
  }
}

// --- Device health (Phase 3) — one classifier so the canvas cue + the accessible mirror agree -----------

/**
 * Classify a device's health into the shared tone vocabulary (`ok|warn|bad`) — by SHAPE + WORD downstream,
 * never colour alone (a11y). `now` is passed so a status frame we haven't heard in a while reads as 'bad'
 * (we can't vouch for a tracker we can't see). Thresholds live in config.ts so canvas + mirror never diverge.
 * `null` health (no status frame yet for this player) is the caller's "unknown" case, handled there.
 */
export function deviceHealthLevel(h: DeviceHealth, now: number): ConnectionTone {
  if (now - h.serverTs > DEVICE_STATUS_STALE_MS) return 'bad'; // haven't heard from the device recently
  // Metered battery critically low, signal effectively gone, or no GNSS fix → bad.
  if ((h.battPct >= 0 && h.battPct <= BATT_PCT_BAD) || h.rssi <= RSSI_BAD || h.fix < 2) return 'bad';
  // Battery low, signal weak, or the device is stashing to flash (can't reach the broker) → warn.
  if ((h.battPct >= 0 && h.battPct <= BATT_PCT_WARN) || h.rssi <= RSSI_WARN || h.backlogBytes >= BACKLOG_WARN_BYTES) {
    return 'warn';
  }
  return 'ok';
}

// --- Auth (Phase 2 — named login + cookie-on-upgrade; ADR-0015/0008) -----------------------------------
// Shared so useAuth (provider), Login (form), and App (gate) agree on the principal + auth lifecycle
// without importing each other. The csrf is a SYNCHRONIZER token from /auth/me — held in memory and echoed
// on logout; it is NOT read from a cookie. No child names ever appear here — only operator usernames +
// match-session ids (the Phase-1 "no child names anywhere" invariant).

export type Role = 'coach' | 'admin';

export interface Principal {
  /** Operator login name (adult). null only for the isolated-LAN anonymous principal. */
  username: string | null;
  role: Role;
  /** Match sessions this principal may view (coach: assigned; admin: empty + wildcard; anon: ANON_SESSIONS). */
  sessions: string[];
  /** Admin → authorized for every session (free-choice picker). */
  wildcard: boolean;
  /** True only under the server's ALLOW_ANONYMOUS_LIVE isolated-LAN bypass (no real login). */
  anonymous: boolean;
  /** CSRF synchronizer token to echo in X-CSRF-Token on state-changing requests (logout). '' for anon. */
  csrf: string;
}

export type AuthState =
  | { status: 'loading' } // initial /auth/me in flight
  | { status: 'anonymous' } // not logged in → show <Login>
  | { status: 'authed'; principal: Principal };

export interface UseAuth {
  auth: AuthState;
  /** POST /auth/login then confirm via /auth/me (catches the cookie-not-stored failure). */
  login(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** POST /auth/logout (X-CSRF-Token from the in-memory principal), then flip to 'anonymous'. */
  logout(): Promise<void>;
  /**
   * Re-check /auth/me; flips to 'anonymous' on 401 (cookie expired/revoked mid-session). Resolves to
   * `true` iff still authed afterward — lets the live view distinguish "cookie truly gone → go to login"
   * from "cookie still valid, transient WS-auth blip → re-arm the socket instead of going dark".
   */
  refresh(): Promise<boolean>;
}
