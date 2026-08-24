/**
 * Telemetry contracts (framework-agnostic).
 * RawTelemetry = exactly what the ESP32 firmware publishes over MQTT.
 * Telemetry    = enriched server-side (session/player from topic, authoritative ts).
 *
 * This is the wire contract shared with firmware/src/main.cpp — change both sides
 * together if you touch the keys.
 */

export interface RawTelemetry {
  id: string; // device client id, e.g. "trk-01-AB12"
  pl: string; // player id as flashed on the device
  ts: number; // device millis - ordering hint only, NOT authoritative
  lat: number;
  lon: number;
  spd: number; // m/s
  hdg: number; // degrees
  fix: number; // 0 = none, 2 = 2D, 3 = 3D
  sats: number;
  pdop: number;
  /** Phase 4 (audit F-1): per-device monotonic sequence (survives reboot via an NVS high-water mark).
   *  Optional — pre-Phase-4 firmware doesn't send it; without it there is no replay dedupe. */
  sq?: number;
  /** Phase 4 (audit F-2): GPS-UTC epoch ms of the FIX (0 = GPS time not yet valid). Optional. A sane gts
   *  becomes the row's serverTs, so a replayed outage spans its real duration instead of collapsing into
   *  the arrival second. */
  gts?: number;
}

export interface Telemetry extends RawTelemetry {
  sessionId: string;
  playerId: string;
  serverTs: number; // Date.now() at ingest - the authoritative timestamp
}

/**
 * Device self-telemetry ("telemetry about the telemetry"): low-rate health the
 * wearable publishes on the .../status topic so the pipeline can see WHY a dot
 * went stale (dead battery? weak WiFi? backlog piling up?). Best-effort, NOT
 * backlogged — health is only useful live. Built in firmware/src/main.cpp.
 */
export interface DeviceStatus {
  id: string; // device client id
  pl: string; // player id
  ts: number; // device millis (ordering only)
  up: number; // uptime seconds
  heap: number; // free heap bytes
  rssi: number; // WiFi RSSI dBm
  batt: number; // battery volts (0 if unmetered)
  pct: number; // battery percent (-1 if unmetered)
  fix: number; // last GNSS fix type
  sats: number; // last satellites-in-view
  pub: number; // device-side cumulative successful publishes
  stash: number; // device-side cumulative backlog appends
  backlog: number; // current flash backlog size, bytes
  rst: number; // Phase 4 (F-4): esp_reset_reason() code (-1 = unknown/pre-Phase-4 firmware)
  boot: number; // Phase 4 (F-4): NVS boot counter (0 = unknown)
  ver: string; // Phase 4 (F-4): firmware version string, bounded; logged, NEVER a metric label
}

/**
 * Minimised device-health envelope fanned out to coaches on /live (Phase 3; ADR-0016, observability).
 * A coach-relevant SUBSET of DeviceStatus — battery / GPS / WiFi / backlog — so a coach can tell a
 * stationary player from a dropped tracker. Internal diagnostics (heap/uptime/pub/stash) deliberately
 * stay on /metrics ONLY (data minimisation). `serverTs` is the authoritative stamp at status receipt
 * (device `ts` is ordering-only). Carries NO child name — `playerId` is pseudonymous. NOT persisted.
 * Wire envelope: { event: 'status', data: DeviceHealth }.
 */
export interface DeviceHealth {
  playerId: string;
  sessionId: string;
  serverTs: number; // Date.now() at status receipt — authoritative
  battPct: number; // -1 if unmetered
  battVolts: number;
  rssi: number; // WiFi dBm — weak-signal vs dead-tracker
  fix: number; // last GNSS fix type
  sats: number;
  backlogBytes: number; // rising ⇒ device can't reach the broker
}

// ----- Coaching domain (Phase 4; ADR-0019) — youth speed-zone model -----------------------
/** Youth age bands (metric-definitions.md §1). A session's band is config (sessionConfig.ts), not a name. */
export type AgeBand = 'U12' | 'U14' | 'U16' | 'U19';

/**
 * Speed-zone boundaries (m/s) for a band (metric-definitions.md §3). Zones 1–3 use the FIXED adult breaks
 * (jog 2.0, run 4.0); only HSR + Sprint scale by age. The server (sessionConfig.ts) is the SINGLE source of
 * this mapping; the client receives resolved thresholds from GET /sessions/:id/config and never re-implements
 * the table, so live zone colour and the review breakdown can never disagree.
 */
export interface ZoneThresholds {
  jogMps: number; // Z1→Z2 break (2.0)
  runMps: number; // Z2→Z3 break (4.0)
  hsrMps: number; // Z3→Z4 (High-Speed Running), per band
  sprintMps: number; // Z4→Z5 (Sprint), per band
}

// ----- Tactical event detection (Track A; ADR-0020, event-detection-contract) --------------
/**
 * One time-bucket team-shape snapshot (contract §2.2). Reconstructed OFF the live loop from stored fixes by
 * time-bucketing the keyset scan and taking each player's latest fix per bucket. Team-AGGREGATE: carries NO
 * playerId/name (even more minimal than the pseudonymous history aggregate). `centroid` is the team mean
 * position — child-derived location, so the whole surface keeps the §0.4 history posture. Geometry (stretch/
 * hull/spread) is in a local equirectangular plane about the bucket centroid (orientation-independent).
 */
export interface TeamShapeBucket {
  ts: number; // bucket-start serverTs (ms)
  count: number; // players present in this bucket (data-quality signal; PM-6 detectors need ≥ MIN_PLAYERS_FOR_EVENTS)
  centroid: { lat: number; lon: number };
  stretchM: number; // mean distance (m) of present players from the centroid — compactness (0 if 1 player)
  surfaceAreaM2: number; // convex-hull area (m²); 0 if < 3 distinct hull vertices (PM-S2/S3: |shoelace|/2)
  spreadM: number; // max pairwise distance (m) between present players — team "size" (0 if < 2)
  meanSpeedMps: number; // mean of present players' spd (null spd coerced to 0 — stored rows always have spd)
  hsrFraction: number; // fraction of present players with spd ≥ the session HSR cut (the high-tempo input)
}

/** A movement-derived phase. Heuristic, NEVER ground truth (§0.5) — `confidence` + `minCount` flag quality. */
export type TacticalEventType = 'high_tempo' | 'transition' | 'stoppage';
export interface TacticalEvent {
  type: TacticalEventType;
  fromTs: number;
  toTs: number;
  confidence: number; // 0..1 heuristic; honestly labelled in the UI
  minCount: number; // PM-6: min player-count over the run's buckets — a thin-data quality signal
  peakHsrFraction?: number; // high_tempo summary
  centroidShiftM?: number; // transition summary (net centroid displacement, m)
  meanSpeedMps?: number; // stoppage summary (how still)
}

/** The structural detector params actually used (PM-S6) — env-tunable + UNVALIDATED; shipped for provenance. */
export interface DetectorParams {
  highTempoFraction: number;
  highTempoMinS: number;
  transitionM: number;
  transitionWindowS: number;
  transitionMinMeanMps: number;
  stoppageSpeedMps: number;
  stoppageCentroidMaxM: number;
  stoppageMinS: number;
  minPlayersForEvents: number;
}

/** GET /sessions/:id/events response body (contract §2.4). Bounded series (≤ MAX_BUCKETS). NO name/playerId. */
export interface EventsResult {
  sessionId: string;
  from: number;
  to: number;
  scannedRows: number;
  bucketMs: number; // the adaptive bucket size chosen (provenance)
  ageBand: AgeBand; // speed-threshold provenance (§0.5)
  thresholds: { hsrMps: number; sprintMps: number };
  detectorParams: DetectorParams; // PM-S6: structural-param provenance
  series: TeamShapeBucket[]; // ascending ts, ≤ MAX_BUCKETS
  events: TacticalEvent[]; // ascending fromTs
}

/** Broker-side subscriptions (MQTT '+' wildcards for any session/player). */
export const TELEMETRY_TOPIC =
  'football-trackers/session/+/player/+/telemetry';
export const STATUS_TOPIC = 'football-trackers/session/+/player/+/status';

/** Recover {sessionId, playerId} from a concrete topic. */
export const TOPIC_RE =
  /^football-trackers\/session\/([^/]+)\/player\/([^/]+)\/telemetry$/;
export const STATUS_TOPIC_RE =
  /^football-trackers\/session\/([^/]+)\/player\/([^/]+)\/status$/;

/** WS pub/sub room: one per session, so a tablet only sees its own session. */
export const wsRoom = (sessionId: string) => `session:${sessionId}`;
