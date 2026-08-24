/**
 * Ingest path: MQTT (QoS0) -> validate -> enrich -> persist -> WS fan-out.
 *
 * This is the Bun/Elysia port of the old NestJS TelemetryController. Instead of
 * the @nestjs/microservices MQTT transport + @EventPattern decorator, we drive
 * the npm `mqtt` client directly and recover session/player from the topic with
 * TOPIC_RE — the same regex the controller used.
 *
 * Fully instrumented: every packet is counted (received / dropped-by-reason /
 * published), the processing latency and DB-write latency are timed, and
 * per-player fix quality + last-seen are exported as gauges. The wearable's own
 * health arrives on the .../status topic and feeds the device gauges. All of it
 * surfaces on GET /metrics — see docs/architecture/observability.md.
 */

import mqtt from 'mqtt';
import {
  TELEMETRY_TOPIC,
  STATUS_TOPIC,
  TOPIC_RE,
  STATUS_TOPIC_RE,
  type DeviceHealth,
  type Telemetry,
} from './types';
import { insertTelemetry } from './db';
import { metrics, capLabel, capLabelPeek } from './metrics';
import { log } from './log';
import { envNumber, envString, envTimerMs } from './env';
import { coerceTelemetry, coerceStatus } from './wire';

export interface IngestDeps {
  /** Fan a finished Telemetry out to the session's WS room. */
  publish: (sessionId: string, t: Telemetry) => void;
  /** Fan a minimised DeviceHealth out to the session's WS room (Phase 3 — second envelope). */
  publishStatus: (sessionId: string, h: DeviceHealth) => void;
  /** Called once the broker subscription is live (used for readiness/health). */
  onSubscribed?: () => void;
  /** Called whenever the broker connection drops (audit S-4: /health must stop saying mqtt:true). */
  onDisconnected?: () => void;
}

export function startIngest({ publish, publishStatus, onSubscribed, onDisconnected }: IngestDeps): mqtt.MqttClient {
  const url = envString('MQTT_URL', 'mqtt://127.0.0.1:1883');
  // The broker requires auth (allow_anonymous false); the server uses a read-only
  // 'ingest' account. Falls back to anonymous only when MQTT_USERNAME is unset (dev).
  const username = envString('MQTT_USERNAME', '') || undefined;
  const password = envString('MQTT_PASSWORD', '') || undefined;
  // keepalive 15 s (default 60): a broker that is TCP-alive but not serving (wedged host, half-open AP
  // socket) is detected in ~22 s instead of ~90 s — the window in which /health would still say mqtt:true.
  const client = mqtt.connect(url, { keepalive: 15, ...(username ? { username, password } : {}) });

  client.on('connect', () => {
    metrics.mqttConnected.set({}, 1);
    // Fires on every (re)connect, so the subscription is restored automatically.
    client.subscribe([TELEMETRY_TOPIC, STATUS_TOPIC], { qos: 0 }, (err) => {
      if (err) {
        log.error('mqtt subscribe failed', { err: err.message });
      } else {
        log.info('mqtt connected', { url: url.replace(/\/\/[^@/]*@/, '//<redacted>@'), topics: [TELEMETRY_TOPIC, STATUS_TOPIC] });
        onSubscribed?.();
      }
    });
  });

  client.on('reconnect', () => metrics.mqttReconnects.inc());
  client.on('close', () => { metrics.mqttConnected.set({}, 0); onDisconnected?.(); });
  client.on('offline', () => { metrics.mqttConnected.set({}, 0); onDisconnected?.(); });
  client.on('error', (err) => log.error('mqtt error', { err: err.message }));

  client.on('message', (topic, payload) => {
    // The shipped broker config enforces message_size_limit 1024; this makes the bound a SERVER invariant
    // too, so a host-run broker without the limit cannot feed 1 MB bodies into JSON.parse at 10 Hz.
    if (payload.length > MAX_PAYLOAD_BYTES) return void metrics.dropped.inc({ reason: 'too_large' });
    const tm = TOPIC_RE.exec(topic);
    if (tm) {
      if (!boundedId(tm[1]) || !boundedId(tm[2])) return void metrics.dropped.inc({ reason: 'bad_topic' });
      return handleTelemetry(tm[1], tm[2], payload, publish);
    }
    const sm = STATUS_TOPIC_RE.exec(topic);
    if (sm) {
      if (!boundedId(sm[1]) || !boundedId(sm[2])) return void metrics.dropped.inc({ reason: 'bad_topic' });
      return handleStatus(sm[1], sm[2], payload, publishStatus);
    }
    metrics.dropped.inc({ reason: 'bad_topic' });
  });

  return client;
}

// The TOPIC_RE/STATUS_TOPIC_RE capture groups are `[^/]+` — they tolerate spaces/unicode/arbitrary length.
// Those segments become Prometheus {session,player} LABEL values and (for status) the fan-out playerId, so
// bound them to the same safe charset session ids use: a compromised broker / mis-set ACL publishing a
// crafted topic (e.g. .../player/Some%20Name/...) can neither inject an arbitrary label value (a name leak
// / label-injection vector) nor explode label cardinality. Legitimate flashed ids ("01") pass unchanged.
const TOPIC_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const boundedId = (v: string): boolean => TOPIC_ID_RE.test(v);

// --- abuse bounds (the broker also caps message size; these guard the pipeline) ---
// All via env.ts (audit S-3): a typo here used to become NaN and silently disable the cap.
const MAX_SPD = envNumber('INGEST_MAX_SPEED', 40, { min: 1 }); // min 1: 0 would silently drop every moving fix // m/s (~144 km/h): a GPS glitch, not a child
const RATE_CAP = envNumber('INGEST_RATE_CAP', 15, { min: 0.001 }); // accepted packets/sec per player (10 Hz + headroom)
const RATE_BURST = envNumber('INGEST_RATE_BURST', 30, { min: 1 });
// Status frames are ~0.2 Hz from the firmware; cap them well below the telemetry rate. Without this a
// compromised/mis-ACL'd device flooding .../status would flood the WS fan-out (publishStatus broadcasts to
// every coach in the room) and thrash the device gauges — handleTelemetry already has this guard; mirror it.
const STATUS_RATE_CAP = envNumber('INGEST_STATUS_RATE_CAP', 2, { min: 0.001 }); // accepted status msgs/sec per player
const STATUS_RATE_BURST = envNumber('INGEST_STATUS_RATE_BURST', 4, { min: 1 });
/** Matches the shipped broker's message_size_limit; a real frame is ~200 bytes. */
const MAX_PAYLOAD_BYTES = envNumber('INGEST_MAX_PAYLOAD_BYTES', 1024, { min: 128 });
const buckets = new Map<string, { tokens: number; last: number }>();
// Audit S-5: the bucket map is keyed by (session, player) straight off the topic, and the ACL lets a device
// mint a new session segment per publish — so sweep buckets that have been idle long enough to have FULLY
// refilled (recreating them then is equivalent), bounding the map to the streams actually active. The clamp
// matters when an operator lowers the cap: sweeping a half-refilled bucket would hand back a full burst.
const BUCKET_IDLE_MS = Math.max(
  envTimerMs('INGEST_BUCKET_IDLE_MS', 60_000, { min: 1_000 }),
  Math.ceil(1000 * Math.max(RATE_BURST / RATE_CAP, STATUS_RATE_BURST / STATUS_RATE_CAP)),
);
setInterval(() => {
  const cutoff = performance.now() - BUCKET_IDLE_MS;
  for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
}, BUCKET_IDLE_MS).unref?.();

/** Token-bucket rate limit keyed per stream — tolerate the steady rate + bursts, drop a firehose. */
function rateOkWith(key: string, cap: number, burst: number): boolean {
  const now = performance.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, last: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * cap);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
/** Per-(session,player) telemetry rate limit (10 Hz + headroom). */
function rateOk(key: string): boolean {
  return rateOkWith(key, RATE_CAP, RATE_BURST);
}

function handleTelemetry(
  session: string,
  player: string,
  payload: Buffer,
  publish: (sessionId: string, t: Telemetry) => void,
): void {
  const t0 = performance.now();
  // Label values are capped (audit S-5) and admission is a privilege (checker finding): `received` fires
  // before validation, so it PEEKS — an unvalidated junk session reads `_other` and cannot reserve one of
  // the 32 slots (32 garbage publishes used to evict the real match session for the process lifetime).
  metrics.received.inc({ session: capLabelPeek('session', session), player: capLabelPeek('player', player) });

  let body: unknown;
  try {
    body = JSON.parse(payload.toString());
  } catch {
    metrics.dropped.inc({ reason: 'bad_json' });
    return;
  }
  // Every field validated at the boundary (wire.ts, audit S-1): a string `fix`, a missing `sats`, an object
  // `ts` are bad_payload here — never a row, a WS frame, or a metric sample. Explicit fields only (§0.1).
  const coerced = coerceTelemetry(body, session, player, Date.now(), MAX_SPD);
  if (!coerced.ok) {
    metrics.dropped.inc({ reason: coerced.reason });
    return;
  }
  const t = coerced.value;
  // Per-player rate cap — a DoS guard on the synchronous DB write + fan-out.
  if (!rateOk(`${session}/${player}`)) {
    metrics.dropped.inc({ reason: 'rate' });
    return;
  }
  // The frame is fully validated + rate-admitted: NOW the session/player may claim label slots.
  const L = { session: capLabel('session', session), player: capLabel('player', player) };

  try {
    const dbStart = performance.now();
    insertTelemetry(t);
    metrics.dbWrite.observe({}, (performance.now() - dbStart) / 1000);
  } catch (err) {
    metrics.dbErrors.inc();
    log.error('db insert failed', { err: String(err), session, player });
    return; // a fix we couldn't persist still shouldn't crash the loop
  }

  publish(session, t);
  metrics.published.inc({ session: L.session });

  // Data-quality + freshness gauges (per player).
  metrics.fixType.set(L, t.fix);
  metrics.sats.set(L, t.sats);
  metrics.pdop.set(L, t.pdop);
  metrics.lastSeen.set(L, t.serverTs / 1000);

  metrics.ingestLatency.observe({}, (performance.now() - t0) / 1000);
}

function handleStatus(
  session: string,
  player: string,
  payload: Buffer,
  publishStatus: (sessionId: string, h: DeviceHealth) => void,
): void {
  let body: unknown;
  try {
    body = JSON.parse(payload.toString());
  } catch {
    metrics.dropped.inc({ reason: 'bad_json' });
    return;
  }
  // wire.ts (audit S-2): `up` must be a number; every other field takes the firmware's unmetered/unknown
  // sentinel when missing or invalid, so a skewed firmware neither breaks the scrape nor blinds the health card.
  const now = Date.now();
  const coerced = coerceStatus(body, session, player, now);
  if (!coerced.ok) {
    metrics.dropped.inc({ reason: coerced.reason });
    return;
  }
  const s = coerced.value;
  // Per-player status rate cap — a DoS guard on the gauge writes + the WS fan-out (publishStatus broadcasts).
  if (!rateOkWith(`status/${session}/${player}`, STATUS_RATE_CAP, STATUS_RATE_BURST)) {
    metrics.dropped.inc({ reason: 'rate' });
    return;
  }
  const L = { session: capLabel('session', session), player: capLabel('player', player) };
  metrics.devUptime.set(L, s.up);
  metrics.devHeap.set(L, s.heap);
  metrics.devRssi.set(L, s.rssi);
  metrics.devBattVolts.set(L, s.batt);
  metrics.devBattPct.set(L, s.pct);
  metrics.devBacklogBytes.set(L, s.backlog);
  metrics.devPublished.set(L, s.pub);
  metrics.devStashed.set(L, s.stash);
  metrics.devStatusLastSeen.set(L, now / 1000);

  // Phase 3: fan a MINIMISED health envelope out to coaches on /live — battery/GPS/WiFi/backlog only, so a
  // coach can tell a stationary player from a dropped tracker. Device internals (heap/uptime/pub/stash) stay
  // on /metrics above (data minimisation). serverTs is authoritative; identity is the topic-routed player.
  // No name ever appears here — playerId is pseudonymous. Best-effort, NOT persisted (mirrors DeviceStatus).
  publishStatus(session, {
    playerId: player,
    sessionId: session,
    serverTs: now,
    battPct: s.pct,
    battVolts: s.batt,
    rssi: s.rssi,
    fix: s.fix,
    sats: s.sats,
    backlogBytes: s.backlog,
  });
}
