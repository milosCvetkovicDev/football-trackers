/**
 * Mirrors the server's enriched Telemetry (server/src/types.ts) and the WS
 * envelope shape that server.ts publishes: {event:'telemetry', data:Telemetry}.
 */
export interface Telemetry {
  id: string;
  pl: string;
  ts: number;
  lat: number;
  lon: number;
  spd: number;
  hdg: number;
  fix: number;
  sats: number;
  pdop: number;
  sessionId: string;
  playerId: string;
  serverTs: number;
}

/**
 * Minimised device-health, mirroring the server's DeviceHealth (server/src/types.ts). Fanned out as the
 * second /live envelope so a coach can tell a stationary player from a dropped tracker. NO child name —
 * `playerId` is pseudonymous; names are joined from the roster at render only (ADR-0016).
 */
export interface DeviceHealth {
  playerId: string;
  sessionId: string;
  serverTs: number;
  battPct: number; // -1 if unmetered
  battVolts: number;
  rssi: number;
  fix: number;
  sats: number;
  backlogBytes: number;
}

/** What server.ts publishes on /live — a discriminated union over the two envelope kinds. */
export type LiveEnvelope =
  | { event: 'telemetry'; data: Telemetry }
  | { event: 'status'; data: DeviceHealth };

// ----- Coaching domain (Phase 4; ADR-0019) — mirror server/src/types.ts -----
export type AgeBand = 'U12' | 'U14' | 'U16' | 'U19';

/** Speed-zone boundaries (m/s). Resolved server-side and fetched via GET /sessions/:id/config — the client
 *  never re-implements the band→threshold table (single source of truth), so live colour == review breakdown. */
export interface ZoneThresholds {
  jogMps: number;
  runMps: number;
  hsrMps: number;
  sprintMps: number;
}

/** GET /sessions/:id/config response body. */
export interface SessionConfig {
  ageBand: AgeBand;
  thresholds: ZoneThresholds;
}

/** Per-player LIVE running-distance accumulator (client-only). Best-effort coaching glance: it is built from
 *  the live stream and RESETS on reconnect / eviction — the authoritative distance is the server review
 *  aggregate. A reset means "fresh live view", NOT "the player stopped". */
export interface LiveDist {
  distM: number;
  firstTs: number;
  lastLat: number;
  lastLon: number;
  lastTs: number;
}

// ----- Tactical event detection (Track A; ADR-0020) — mirror server/src/types.ts -----
/** One time-bucket team-shape snapshot. Team-AGGREGATE: NO playerId/name. `count` is a data-quality signal
 *  (a 1-2 player bucket is thin — the server's detectors ignore buckets below its participation floor). */
export interface TeamShapeBucket {
  ts: number;
  count: number;
  centroid: { lat: number; lon: number };
  stretchM: number;
  surfaceAreaM2: number;
  spreadM: number;
  meanSpeedMps: number;
  hsrFraction: number;
}

/** A movement-derived phase. HEURISTIC, never a confirmed ball event — `confidence` + `minCount` flag quality. */
export type TacticalEventType = 'high_tempo' | 'transition' | 'stoppage';
export interface TacticalEvent {
  type: TacticalEventType;
  fromTs: number;
  toTs: number;
  confidence: number;
  minCount: number;
  peakHsrFraction?: number;
  centroidShiftM?: number;
  meanSpeedMps?: number;
}

/** The structural detector params actually used — env-tunable + UNVALIDATED; shown as "proposed" provenance. */
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

/** GET /sessions/:id/events response body. Bounded series; NO name/playerId. */
export interface EventsResult {
  sessionId: string;
  from: number;
  to: number;
  scannedRows: number;
  bucketMs: number;
  ageBand: AgeBand;
  thresholds: { hsrMps: number; sprintMps: number };
  detectorParams: DetectorParams;
  series: TeamShapeBucket[];
  events: TacticalEvent[];
}
