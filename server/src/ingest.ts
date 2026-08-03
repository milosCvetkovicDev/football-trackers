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
  type RawTelemetry,
  type DeviceStatus,
  type DeviceHealth,
  type Telemetry,
} from './types';
import { insertTelemetry } from './db';
import { metrics } from './metrics';
import { log } from './log';

export interface IngestDeps {
  /** Fan a finished Telemetry out to the session's WS room. */
  publish: (sessionId: string, t: Telemetry) => void;
  /** Fan a minimised DeviceHealth out to the session's WS room (Phase 3 — second envelope). */
  publishStatus: (sessionId: string, h: DeviceHealth) => void;
  /** Called once the broker subscription is live (used for readiness/health). */
  onSubscribed?: () => void;
}

export function startIngest({ publish, publishStatus, onSubscribed }: IngestDeps): mqtt.MqttClient {
  const url = process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883';
  // The broker requires auth (allow_anonymous false); the server uses a read-only
  // 'ingest' account. Falls back to anonymous only when MQTT_USERNAME is unset (dev).
  const username = process.env.MQTT_USERNAME;
  const password = process.env.MQTT_PASSWORD;
  const client = mqtt.connect(url, username ? { username, password } : {});

  client.on('connect', () => {
    metrics.mqttConnected.set({}, 1);
    // Fires on every (re)connect, so the subscription is restored automatically.
    client.subscribe([TELEMETRY_TOPIC, STATUS_TOPIC], { qos: 0 }, (err) => {
      if (err) {
        log.error('mqtt subscribe failed', { err: err.message });
      } else {
        log.info('mqtt connected', { url, topics: [TELEMETRY_TOPIC, STATUS_TOPIC] });
        onSubscribed?.();
      }
    });
  });

  client.on('reconnect', () => metrics.mqttReconnects.inc());
  client.on('close', () => metrics.mqttConnected.set({}, 0));
  client.on('offline', () => metrics.mqttConnected.set({}, 0));
  client.on('error', (err) => log.error('mqtt error', { err: err.message }));

  client.on('message', (topic, payload) => {
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
const MAX_SPD = Number(process.env.INGEST_MAX_SPEED ?? 40); // m/s (~144 km/h): a GPS glitch, not a child
const RATE_CAP = Number(process.env.INGEST_RATE_CAP ?? 15); // accepted packets/sec per player (10 Hz + headroom)
const RATE_BURST = Number(process.env.INGEST_RATE_BURST ?? 30);
// Status frames are ~0.2 Hz from the firmware; cap them well below the telemetry rate. Without this a
// compromised/mis-ACL'd device flooding .../status would flood the WS fan-out (publishStatus broadcasts to
// every coach in the room) and thrash the device gauges — handleTelemetry already has this guard; mirror it.
const STATUS_RATE_CAP = Number(process.env.INGEST_STATUS_RATE_CAP ?? 2); // accepted status msgs/sec per player
const STATUS_RATE_BURST = Number(process.env.INGEST_STATUS_RATE_BURST ?? 4);
const buckets = new Map<string, { tokens: number; last: number }>();

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
  metrics.received.inc({ session, player });

  let raw: RawTelemetry;
  try {
    raw = JSON.parse(payload.toString());
  } catch {
    metrics.dropped.inc({ reason: 'bad_json' });
    return;
  }
  if (!raw || typeof raw.lat !== 'number' || typeof raw.lon !== 'number') {
    metrics.dropped.inc({ reason: 'bad_payload' });
    return;
  }
  // Identity is authoritative from the broker-routed *topic*, never the device body.
  // The per-device MQTT ACL already confines a device to its own player topic; this
  // rejects any packet whose body `pl` disagrees — defence in depth, and a signal that
  // a device is misconfigured or compromised.
  if (raw.pl !== player) {
    metrics.dropped.inc({ reason: 'id_mismatch' });
    return;
  }
  // Reject impossible coordinates / speeds before they poison the DB and the live canvas.
  if (
    raw.lat < -90 || raw.lat > 90 ||
    raw.lon < -180 || raw.lon > 180 ||
    (typeof raw.spd === 'number' && raw.spd > MAX_SPD)
  ) {
    metrics.dropped.inc({ reason: 'out_of_range' });
    return;
  }
  // Cheap sanity gate: drop packets without a real 2D/3D fix.
  if (raw.fix < 2) {
    metrics.dropped.inc({ reason: 'no_fix' });
    return;
  }
  // Per-player rate cap — a DoS guard on the synchronous DB write + fan-out.
  if (!rateOk(`${session}/${player}`)) {
    metrics.dropped.inc({ reason: 'rate' });
    return;
  }

  // Build the fan-out object from EXPLICIT fields — never `...raw`. A spread would carry any extra key the
  // device (or an MQTT-write attacker) put in the body straight onto the wire + into the client store; a
  // stray `displayName` would then violate the §0.1 "no name in the pseudonymous stores" invariant. (db.ts's
  // insert is already explicit-column, so the DB row was safe — this closes the wire/fan-out path too.)
  const t: Telemetry = {
    id: raw.id,
    pl: raw.pl,
    ts: raw.ts,
    lat: raw.lat,
    lon: raw.lon,
    spd: raw.spd,
    hdg: raw.hdg,
    fix: raw.fix,
    sats: raw.sats,
    pdop: raw.pdop,
    sessionId: session,
    playerId: player,
    serverTs: Date.now(), // authoritative timestamp lives here
  };

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
  metrics.published.inc({ session });

  // Data-quality + freshness gauges (per player).
  metrics.fixType.set({ session, player }, t.fix);
  metrics.sats.set({ session, player }, t.sats);
  metrics.pdop.set({ session, player }, t.pdop);
  metrics.lastSeen.set({ session, player }, t.serverTs / 1000);

  metrics.ingestLatency.observe({}, (performance.now() - t0) / 1000);
}

function handleStatus(
  session: string,
  player: string,
  payload: Buffer,
  publishStatus: (sessionId: string, h: DeviceHealth) => void,
): void {
  let s: DeviceStatus;
  try {
    s = JSON.parse(payload.toString());
  } catch {
    metrics.dropped.inc({ reason: 'bad_json' });
    return;
  }
  if (!s || typeof s.up !== 'number') {
    metrics.dropped.inc({ reason: 'bad_payload' });
    return;
  }
  // Identity is authoritative from the broker-routed topic, never the body — drop a body whose `pl`
  // disagrees (mirrors handleTelemetry; defence in depth against a misconfigured/compromised device).
  if (s.pl !== player) {
    metrics.dropped.inc({ reason: 'id_mismatch' });
    return;
  }
  // Per-player status rate cap — a DoS guard on the gauge writes + the WS fan-out (publishStatus broadcasts).
  if (!rateOkWith(`status/${session}/${player}`, STATUS_RATE_CAP, STATUS_RATE_BURST)) {
    metrics.dropped.inc({ reason: 'rate' });
    return;
  }
  const L = { session, player };
  metrics.devUptime.set(L, s.up);
  metrics.devHeap.set(L, s.heap);
  metrics.devRssi.set(L, s.rssi);
  metrics.devBattVolts.set(L, s.batt);
  metrics.devBattPct.set(L, s.pct);
  metrics.devBacklogBytes.set(L, s.backlog);
  metrics.devPublished.set(L, s.pub);
  metrics.devStashed.set(L, s.stash);
  metrics.devStatusLastSeen.set(L, Date.now() / 1000);

  // Phase 3: fan a MINIMISED health envelope out to coaches on /live — battery/GPS/WiFi/backlog only, so a
  // coach can tell a stationary player from a dropped tracker. Device internals (heap/uptime/pub/stash) stay
  // on /metrics above (data minimisation). serverTs is authoritative; identity is the topic-routed player.
  // No name ever appears here — playerId is pseudonymous. Best-effort, NOT persisted (mirrors DeviceStatus).
  publishStatus(session, {
    playerId: player,
    sessionId: session,
    serverTs: Date.now(),
    battPct: s.pct,
    battVolts: s.batt,
    rssi: s.rssi,
    fix: s.fix,
    sats: s.sats,
    backlogBytes: s.backlog,
  });
}
