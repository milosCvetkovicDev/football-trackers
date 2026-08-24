/**
 * The wire boundary (audit S-1/S-2): every field of a device frame is validated BEFORE anything
 * downstream sees it. Downstream means: a SQLite row, a WS frame to a coach's browser, a Prometheus sample.
 * All three assumed "a number" and interpolated whatever arrived — so a string `fix` of
 * `3\nft_injected_metric 999` passed `raw.fix < 2` (NaN compares false) and wrote a forged metric line into
 * the exposition; a firmware that omitted `batt` wrote the literal `undefined` and broke the whole scrape.
 *
 * Rules:
 *   - telemetry: every numeric field must be a finite JSON number; ids must be bounded printable strings.
 *     Anything else is `bad_payload`. No coercion of strings — a device sending "3" is a bug to surface,
 *     not to paper over.
 *   - status: `up` must be a finite number (the frame's liveness signal); every other numeric field takes
 *     the firmware's own "unmetered/unknown" sentinel when missing or invalid, so a skewed firmware still
 *     produces a finite-number health envelope and finite gauges instead of a blind health card.
 *   - identity comes from the topic; a body `pl` that disagrees is `id_mismatch` (defence in depth).
 *   - output objects are built from EXPLICIT fields — never a spread — so a stray `displayName` in a body
 *     cannot ride into the pseudonymous stores (§0.1).
 */
import type { DeviceStatus, Telemetry } from './types';

/** Device client ids: printable, bounded; stored as device_id and echoed to the client (`id`). */
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export type DropReason = 'bad_payload' | 'id_mismatch' | 'out_of_range' | 'no_fix';
export type Coerced<T> = { ok: true; value: T } | { ok: false; reason: DropReason };

const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function coerceTelemetry(body: unknown, sessionId: string, playerId: string, serverTs: number, maxSpeed = Infinity): Coerced<Telemetry> {
  if (!isObject(body)) return { ok: false, reason: 'bad_payload' };
  const { id, pl, ts, lat, lon, spd, hdg, fix, sats, pdop } = body;
  if (typeof id !== 'string' || !DEVICE_ID_RE.test(id) || typeof pl !== 'string') return { ok: false, reason: 'bad_payload' };
  // Wrong TYPE (string, null, object, NaN) is bad_payload — the frame is not the shape the contract names.
  if (!isFinite(ts) || !isFinite(lat) || !isFinite(lon) || !isFinite(spd) || !isFinite(hdg) || !isFinite(fix) || !isFinite(sats) || !isFinite(pdop)) {
    return { ok: false, reason: 'bad_payload' };
  }
  // Physically impossible VALUES are bad_payload too (checker finding): a negative speed once overflowed the
  // /history average to -Infinity → null; fix 2.5 / sats 1e9 / ts 2^63 have no meaning on this hardware.
  if (!Number.isInteger(fix) || fix < 0 || fix > 5) return { ok: false, reason: 'bad_payload' };
  if (spd < 0 || hdg < 0 || hdg > 360 || sats < 0 || sats > 128 || pdop < 0 || pdop > 100 || ts < 0 || ts > Number.MAX_SAFE_INTEGER) {
    return { ok: false, reason: 'bad_payload' };
  }
  // Identity is authoritative from the broker-routed *topic*, never the device body. The per-device MQTT
  // ACL already confines a device to its own player topic; this rejects any packet whose body disagrees.
  if (pl !== playerId) return { ok: false, reason: 'id_mismatch' };
  // Possible-but-implausible coordinates / speeds must not poison the DB or the live canvas.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || spd > maxSpeed) return { ok: false, reason: 'out_of_range' };
  // No real 2D/3D fix → nothing to place on the pitch.
  if (fix < 2) return { ok: false, reason: 'no_fix' };
  return {
    ok: true,
    value: { id, pl, ts, lat, lon, spd, hdg, fix, sats, pdop, sessionId, playerId, serverTs },
  };
}

/**
 * Sentinels for missing/invalid/impossible status fields. `pct: -1` and `batt: 0` are the firmware's own
 * "unmetered" conventions; `rssi: -127` is DELIBERATELY not 0 — 0 dBm is the strongest possible signal, and
 * the checker showed a missing rssi rendered a signal-less device as a GREEN card; -127 classifies as "bad",
 * so the coach investigates. Each field also has a physical range: a wrapped battPct of 250 must not read
 * "ok" on the card or in an alert rule, so out-of-range values take the sentinel too.
 */
const STATUS_FIELDS = {
  heap: { sentinel: 0, min: 0, max: 16 * 1024 * 1024 },
  rssi: { sentinel: -127, min: -120, max: 0 },
  batt: { sentinel: 0, min: 0, max: 10 },
  pct: { sentinel: -1, min: -1, max: 100 },
  fix: { sentinel: 0, min: 0, max: 5 },
  sats: { sentinel: 0, min: 0, max: 128 },
  pub: { sentinel: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
  stash: { sentinel: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
  backlog: { sentinel: 0, min: 0, max: 1024 * 1024 * 1024 },
  ts: { sentinel: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
} as const;

export function coerceStatus(body: unknown, _sessionId: string, playerId: string, _serverTs: number): Coerced<DeviceStatus> {
  if (!isObject(body)) return { ok: false, reason: 'bad_payload' };
  const { id, pl, up } = body;
  // `up` is the frame's liveness signal and is REQUIRED: not a finite non-negative number → the frame is junk.
  if (typeof pl !== 'string' || !isFinite(up) || up < 0) return { ok: false, reason: 'bad_payload' };
  if (pl !== playerId) return { ok: false, reason: 'id_mismatch' };
  const num = (k: keyof typeof STATUS_FIELDS): number => {
    const v = body[k];
    const f = STATUS_FIELDS[k];
    return isFinite(v) && v >= f.min && v <= f.max ? v : f.sentinel;
  };
  return {
    ok: true,
    value: {
      id: typeof id === 'string' && DEVICE_ID_RE.test(id) ? id : 'unknown',
      pl,
      ts: num('ts'),
      up,
      heap: num('heap'),
      rssi: num('rssi'),
      batt: num('batt'),
      pct: num('pct'),
      fix: num('fix'),
      sats: num('sats'),
      pub: num('pub'),
      stash: num('stash'),
      backlog: num('backlog'),
    },
  };
}
