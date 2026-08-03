/**
 * Inbound-frame hardening for the /live WebSocket. Every frame is UNTRUSTED — the payload is
 * children's live location, so a malicious or buggy feed must not be able to crash, mislead, or
 * blow up the view. This module is the single choke point: parse defensively, accept only a frame
 * that matches the envelope contract AND a strictly-typed, range-checked Telemetry, and otherwise
 * return null (never throw, never store). Kept pure so it's trivially unit-testable.
 *
 * The accepted envelopes are exactly what `server.ts` publishes: {event:'telemetry', data:Telemetry}
 * and {event:'status', data:DeviceHealth} (Phase 3). Unknown event types are ignored (return null) so
 * the wire contract can grow without crashing here.
 */
import type { Telemetry, DeviceHealth } from '../types';

// Bound on id-string length — a real playerId/sessionId is short. Cap it so a hostile feed can't
// hand us megabyte strings that bloat the Map keys/values (defence in depth alongside MAX_TRACKED_PLAYERS).
const MAX_ID_LEN = 128;

/** Finite-number guard: rejects NaN, +/-Infinity, and non-number types in one place. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Non-empty, length-bounded string — used for the id-shaped fields. */
function isBoundedString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN;
}

/**
 * Validate an already-parsed value as a Telemetry. Returns the SAME object (typed) when it passes
 * so we don't allocate a copy per packet (10 players x 10 Hz). Checks: every required field present
 * and correctly typed; lat/lon/serverTs/spd/hdg finite; lat in [-90,90], lon in [-180,180];
 * playerId/sessionId non-empty bounded strings; fix a number. Anything else -> null.
 */
function validateTelemetry(data: unknown): Telemetry | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  // Geographic coordinates: finite AND physically in-range — an out-of-range lat/lon would project
  // to nonsense and could fling a dot off the pitch, so it's a hard reject, not a clamp.
  if (!isFiniteNumber(d.lat) || d.lat < -90 || d.lat > 90) return null;
  if (!isFiniteNumber(d.lon) || d.lon < -180 || d.lon > 180) return null;

  // Server clock is the source of truth for ordering/eviction — must be a real number.
  if (!isFiniteNumber(d.serverTs)) return null;

  // Motion fields drive the heading arrow / speed readout; finite so they can't poison the render.
  if (!isFiniteNumber(d.spd) || !isFiniteNumber(d.hdg)) return null;

  // Fix quality is a number on the wire (server already drops fix<2, but re-check the type here).
  if (!isFiniteNumber(d.fix)) return null;

  // Remaining numeric fields from the enriched Telemetry contract.
  if (!isFiniteNumber(d.ts) || !isFiniteNumber(d.sats) || !isFiniteNumber(d.pdop)) return null;

  // Identity fields key the Map and label the UI — non-empty and length-bounded.
  if (!isBoundedString(d.id) || !isBoundedString(d.pl)) return null;
  if (!isBoundedString(d.playerId) || !isBoundedString(d.sessionId)) return null;

  // Return a FRESH literal of exactly the known fields — never `d as Telemetry`. A stray field on the wire
  // (e.g. an injected `displayName`) is then STRUCTURALLY stripped before the object reaches the store,
  // upholding §0.1 ("no name in the pseudonymous store") by construction, not by consumer discipline. This
  // mirrors validateDeviceHealth; the server also strips at source (ingest.ts), so this is defense in depth.
  return {
    id: d.id,
    pl: d.pl,
    ts: d.ts,
    lat: d.lat,
    lon: d.lon,
    spd: d.spd,
    hdg: d.hdg,
    fix: d.fix,
    sats: d.sats,
    pdop: d.pdop,
    sessionId: d.sessionId,
    playerId: d.playerId,
    serverTs: d.serverTs,
  } as Telemetry;
}

/**
 * Validate an already-parsed value as a DeviceHealth (the minimised `.../status` fan-out). Same
 * defensive posture as validateTelemetry: every required field present + correctly typed, numbers
 * finite, id-shaped fields non-empty bounded strings; anything else -> null.
 *
 * SECURITY (invariant §0.1): a DeviceHealth must NEVER carry a child name. This returns a
 * FRESHLY-CONSTRUCTED object literal with EXACTLY the nine known fields — NOT `d as DeviceHealth` —
 * so a stray `name`/`displayName` field on the wire is structurally stripped, not merely "not read".
 * The structural guarantee (not consumer discipline) is what upholds the no-names invariant here.
 */
function validateDeviceHealth(data: unknown): DeviceHealth | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  // Identity fields key the health Map — non-empty and length-bounded (no name field exists here).
  if (!isBoundedString(d.playerId) || !isBoundedString(d.sessionId)) return null;

  // Server clock is the authoritative stamp at status receipt — must be a real number.
  if (!isFiniteNumber(d.serverTs)) return null;

  // Battery / signal / GNSS / backlog — all finite so they can't poison the health classifier.
  // (battPct is -1 when unmetered; the classifier already special-cases the negative value.)
  if (!isFiniteNumber(d.battPct) || !isFiniteNumber(d.battVolts)) return null;
  if (!isFiniteNumber(d.rssi)) return null;
  if (!isFiniteNumber(d.fix) || !isFiniteNumber(d.sats)) return null;
  if (!isFiniteNumber(d.backlogBytes)) return null;

  // Reconstruct from scratch with exactly the nine contract fields — this is the structural strip.
  return {
    playerId: d.playerId,
    sessionId: d.sessionId,
    serverTs: d.serverTs,
    battPct: d.battPct,
    battVolts: d.battVolts,
    rssi: d.rssi,
    fix: d.fix,
    sats: d.sats,
    backlogBytes: d.backlogBytes,
  };
}

/**
 * Parse one raw WS frame into a validated Telemetry, or null if it's malformed, the wrong event,
 * or fails the strict validator. Pure: no side effects, no throws — the caller drops null silently.
 */
export function parseTelemetryFrame(raw: string): Telemetry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // non-JSON / truncated frame
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const env = parsed as Record<string, unknown>;
  if (env.event !== 'telemetry') return null; // ignore unknown / future event types

  return validateTelemetry(env.data);
}

/**
 * Parse one raw WS frame, routing on the envelope's `event` to the matching strict validator:
 *   - 'telemetry' -> {kind:'telemetry', data:Telemetry}
 *   - 'status'    -> {kind:'status',    data:DeviceHealth}  (structurally name-stripped, §0.1)
 * Anything else — non-JSON, non-object, unknown event, or a payload that fails its validator — is
 * null, which the caller drops silently. Pure: no side effects, no throws.
 */
export function parseLiveFrame(
  raw: string,
): { kind: 'telemetry'; data: Telemetry } | { kind: 'status'; data: DeviceHealth } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // non-JSON / truncated frame
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const env = parsed as Record<string, unknown>;
  if (env.event === 'telemetry') {
    const t = validateTelemetry(env.data);
    return t ? { kind: 'telemetry', data: t } : null;
  }
  if (env.event === 'status') {
    const h = validateDeviceHealth(env.data);
    return h ? { kind: 'status', data: h } : null;
  }
  return null; // unknown / future event type
}
