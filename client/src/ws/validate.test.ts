import { expect, test } from 'bun:test';
import { parseTelemetryFrame, parseLiveFrame } from './validate';
import type { Telemetry, DeviceHealth } from '../types';

// A wire-shaped frame the server would actually publish, used as the base for mutation tests.
const VALID: Telemetry = {
  id: 'dev-1',
  pl: 'p1',
  ts: 12_345,
  lat: 44.8125,
  lon: 20.4612,
  spd: 3.2,
  hdg: 90,
  fix: 3,
  sats: 9,
  pdop: 1.4,
  sessionId: 'test',
  playerId: 'p1',
  serverTs: 1_700_000_000_000,
};

function frame(data: unknown): string {
  return JSON.stringify({ event: 'telemetry', data });
}

test('accepts a valid telemetry frame', () => {
  const t = parseTelemetryFrame(frame(VALID));
  expect(t).not.toBeNull();
  expect(t!.playerId).toBe('p1');
  expect(t!.lat).toBeCloseTo(44.8125, 6);
});

test('rejects NaN lat', () => {
  // JSON can't carry NaN literally; a feed would send null/string — both must fail the finite check.
  expect(parseTelemetryFrame(frame({ ...VALID, lat: null }))).toBeNull();
  expect(parseTelemetryFrame(frame({ ...VALID, lat: 'x' }))).toBeNull();
});

test('rejects Infinity lat', () => {
  // Inject a raw Infinity token into the JSON text (JSON.parse will throw -> null is still correct).
  const raw = frame(VALID).replace('44.8125', 'Infinity');
  expect(parseTelemetryFrame(raw)).toBeNull();
});

test('rejects out-of-range lon', () => {
  expect(parseTelemetryFrame(frame({ ...VALID, lon: 200 }))).toBeNull();
  expect(parseTelemetryFrame(frame({ ...VALID, lat: 91 }))).toBeNull();
});

test('rejects missing fields', () => {
  const { serverTs: _serverTs, ...noServerTs } = VALID;
  expect(parseTelemetryFrame(frame(noServerTs))).toBeNull();
  const { playerId: _playerId, ...noPlayerId } = VALID;
  expect(parseTelemetryFrame(frame(noPlayerId))).toBeNull();
});

test('rejects empty / overlong id strings', () => {
  expect(parseTelemetryFrame(frame({ ...VALID, playerId: '' }))).toBeNull();
  expect(parseTelemetryFrame(frame({ ...VALID, sessionId: 'x'.repeat(200) }))).toBeNull();
});

test('rejects the wrong event type', () => {
  expect(parseTelemetryFrame(JSON.stringify({ event: 'status', data: VALID }))).toBeNull();
  expect(parseTelemetryFrame(JSON.stringify({ data: VALID }))).toBeNull();
});

test('rejects non-JSON and non-object payloads', () => {
  expect(parseTelemetryFrame('not json {')).toBeNull();
  expect(parseTelemetryFrame('42')).toBeNull();
  expect(parseTelemetryFrame(JSON.stringify({ event: 'telemetry', data: 'nope' }))).toBeNull();
});

// --- parseLiveFrame: the routed entry point used by useLiveTelemetry (Phase 3) ------------------

// A wire-shaped minimised DeviceHealth the server would actually publish on the `.../status` fan-out.
const HEALTH: DeviceHealth = {
  playerId: 'p1',
  sessionId: 'test',
  serverTs: 1_700_000_000_000,
  battPct: 82,
  battVolts: 4.01,
  rssi: -62,
  fix: 3,
  sats: 11,
  backlogBytes: 0,
};

test('parseLiveFrame routes a valid telemetry frame to kind:telemetry', () => {
  const r = parseLiveFrame(JSON.stringify({ event: 'telemetry', data: VALID }));
  expect(r).not.toBeNull();
  expect(r!.kind).toBe('telemetry');
  expect((r!.data as Telemetry).playerId).toBe('p1');
});

test('parseLiveFrame routes a valid status frame to kind:status', () => {
  const r = parseLiveFrame(JSON.stringify({ event: 'status', data: HEALTH }));
  expect(r).not.toBeNull();
  expect(r!.kind).toBe('status');
  const h = r!.data as DeviceHealth;
  expect(h.playerId).toBe('p1');
  expect(h.battPct).toBe(82);
  expect(h.backlogBytes).toBe(0);
});

test('parseLiveFrame rejects junk / malformed status frames', () => {
  // Missing required numeric field.
  const { rssi: _rssi, ...noRssi } = HEALTH;
  expect(parseLiveFrame(JSON.stringify({ event: 'status', data: noRssi }))).toBeNull();
  // Non-finite battery.
  expect(parseLiveFrame(JSON.stringify({ event: 'status', data: { ...HEALTH, battPct: null } }))).toBeNull();
  // Empty id string.
  expect(parseLiveFrame(JSON.stringify({ event: 'status', data: { ...HEALTH, playerId: '' } }))).toBeNull();
  // Non-object data, unknown event, and non-JSON all drop.
  expect(parseLiveFrame(JSON.stringify({ event: 'status', data: 'nope' }))).toBeNull();
  expect(parseLiveFrame(JSON.stringify({ event: 'mystery', data: HEALTH }))).toBeNull();
  expect(parseLiveFrame('not json {')).toBeNull();
});

test('parseLiveFrame structurally strips a displayName off a status frame (§0.1)', () => {
  // A hostile/buggy feed sneaks a child name onto the wire. The validator must reconstruct a fresh
  // literal so the name is GONE from the result — not merely "not read" (return-value, not discipline).
  const r = parseLiveFrame(
    JSON.stringify({ event: 'status', data: { ...HEALTH, displayName: 'Alex M.', name: 'Alex M.' } }),
  );
  expect(r).not.toBeNull();
  expect(r!.kind).toBe('status');
  expect((r!.data as Record<string, unknown>).displayName).toBeUndefined();
  expect((r!.data as Record<string, unknown>).name).toBeUndefined();
});

test('telemetry validation structurally strips a stray displayName (§0.1)', () => {
  // Same guard for the TELEMETRY path: a name injected into a telemetry body must NOT reach the store.
  const hostile = { ...VALID, displayName: 'Alex M.', name: 'Alex M.' };
  const t = parseTelemetryFrame(frame(hostile));
  expect(t).not.toBeNull();
  expect((t as Record<string, unknown>).displayName).toBeUndefined();
  expect((t as Record<string, unknown>).name).toBeUndefined();
  const live = parseLiveFrame(frame(hostile));
  expect(live!.kind).toBe('telemetry');
  expect((live!.data as Record<string, unknown>).displayName).toBeUndefined();
});

// --- Phase 5: the subscribed-session check (audit §6 "Client": inbound frames not checked against
// the subscribed sessionId). The room is server-side, so a cross-session frame should be impossible
// — which is exactly why a silent one would go unnoticed. Defence in depth: if a fan-out bug (or a
// future multi-room feature) ever delivered another session's children onto this pitch, the frame is
// dropped here, before it can reach a store keyed only by playerId. ------------------------------

test('parseLiveFrame drops a frame belonging to another session when one is expected', () => {
  expect(parseLiveFrame(frame(VALID), 'test')).not.toBeNull(); // matching session -> accepted
  expect(parseLiveFrame(frame(VALID), 'other-session')).toBeNull();
  const status = JSON.stringify({ event: 'status', data: HEALTH });
  expect(parseLiveFrame(status, HEALTH.sessionId)).not.toBeNull();
  expect(parseLiveFrame(status, 'other-session')).toBeNull();
});

test('omitting the expected session keeps the previous behaviour (accept any well-formed frame)', () => {
  // The parameter is optional so the pure parser stays usable without a subscription context.
  expect(parseLiveFrame(frame(VALID))).not.toBeNull();
  expect(parseLiveFrame(frame(VALID), undefined)).not.toBeNull();
});

// --- Phase 5: the `hello` envelope — the server's clock, sent once as the socket opens (audit C-1).
// It is the client's TRUSTED skew reference precisely because it cannot be anything else: a telemetry
// frame's serverTs may be a replayed fix's GPS time (Phase 4 `gts`), which would let a backlog drain
// convince the view that hours-old positions are live. -----------------------------------------------

const HELLO = { sessionId: 'test', serverTs: 1_700_000_000_000 };
const helloFrame = (data: unknown) => JSON.stringify({ event: 'hello', data });

test('parseLiveFrame accepts a well-formed hello and returns exactly {sessionId, serverTs}', () => {
  const r = parseLiveFrame(helloFrame(HELLO));
  expect(r).not.toBeNull();
  expect(r!.kind).toBe('hello');
  expect(Object.keys(r!.data).sort()).toEqual(['serverTs', 'sessionId']);
  expect((r!.data as { serverTs: number }).serverTs).toBe(HELLO.serverTs);
});

test('a hello with a junk clock is dropped rather than allowed to set the skew', () => {
  // Every one of these would, if accepted, move the whole view's sense of "now".
  expect(parseLiveFrame(helloFrame({ ...HELLO, serverTs: null }))).toBeNull();
  expect(parseLiveFrame(helloFrame({ ...HELLO, serverTs: '1700000000000' }))).toBeNull();
  expect(parseLiveFrame(helloFrame({ ...HELLO, serverTs: 0 }))).toBeNull();
  expect(parseLiveFrame(helloFrame({ ...HELLO, serverTs: -1 }))).toBeNull();
  expect(parseLiveFrame(helloFrame(helloFrame(HELLO).replace('1700000000000', 'Infinity')))).toBeNull();
  expect(parseLiveFrame(helloFrame({ serverTs: HELLO.serverTs }))).toBeNull(); // no sessionId
  expect(parseLiveFrame(helloFrame(null))).toBeNull();
  expect(parseLiveFrame(helloFrame('nope'))).toBeNull();
});

test('a hello for another session is dropped like any other foreign frame', () => {
  expect(parseLiveFrame(helloFrame(HELLO), 'test')).not.toBeNull();
  expect(parseLiveFrame(helloFrame(HELLO), 'other-session')).toBeNull();
});

test('a hello is structurally stripped — nothing rides along on the clock frame', () => {
  const r = parseLiveFrame(helloFrame({ ...HELLO, displayName: 'Alex M.', lat: 44.8 }));
  expect(r).not.toBeNull();
  expect((r!.data as Record<string, unknown>).displayName).toBeUndefined();
  expect((r!.data as Record<string, unknown>).lat).toBeUndefined();
});
