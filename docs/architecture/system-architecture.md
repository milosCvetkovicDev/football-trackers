# System Architecture

The "Path A" design ([ADR-0001](../decisions/0001-build-vs-buy.md)): DIY WiFi wearables + an owned
backend. This is the logical architecture; for the running code see the root
[`README.md`](../../README.md) and [`CLAUDE.md`](../../CLAUDE.md).

## Data flow
```
[10x wearable]              [field AP]       [broker]        [backend]                 [coach tablet]
ESP32 + GNSS (+IMU)  ->  WiFi 2.4 GHz  ->  Mosquitto MQTT ->  ingest + metrics  -> WS ->  React live view
   publish 10 Hz          (1 outdoor AP)     (QoS0)          + serverTs + persist        pitch + dots
```

## Layers

### 1. Wearable (firmware)
- ESP32 (WiFi) + u-blox NEO-M8N/M9N (10 Hz, UART) + optional IMU + 1S LiPo.
- GNSS raised from 9600/1 Hz/NMEA to 115200/10 Hz/**UBX-PVT** (one compact binary message).
- Publishes telemetry over MQTT (QoS 0).
- **Flash backup**: on WiFi/MQTT loss, each fix is appended to LittleFS (newline-delimited JSON,
  capped 256 KB) and replayed on reconnect — a dropout loses at most the fixes arriving during the short bounded connect attempts (bench target: ≥ 92 % of a 60 s outage preserved; hardware drill pending, runbook §7).
- Per-device config: WiFi creds, MQTT host, unique `PLAYER_ID`.

### 2. Wire contract
- Topic: `football-trackers/session/{sessionId}/player/{playerId}/telemetry` (QoS0, 10 Hz); plus
  `/status` (QoS1 retained: battery, fix) and `/cmd` (server→device).
- Packet (terse JSON): `{id, pl, ts, lat, lon, spd, hdg, fix, sats, pdop}`. `ts` is the device
  clock (ordering only); the **server stamps the authoritative timestamp** on receipt.

### 3. Ingest + metrics
- Subscribe to the `+` wildcard topic; recover session/player from the topic.
- Validate (drop no-fix packets) → enrich (serverTs, session, player) → metrics (haversine
  distance, speed smoothing, sprint threshold) → live fan-out → persist.

### 4. Live fan-out
- WebSocket, one room per session, so a tablet receives only its session.

### 5. Persistence
- Time-series storage of all telemetry for post-session analytics (distances, sprints, heatmaps).

### 6. Coach live view
- **Pitch calibration**: homography from the 4 corner GPS coords → normalized pitch.
- Canvas/SVG render; last position per player held in a `useRef` Map; `requestAnimationFrame` loop;
  packets buffered/interpolated for smooth motion (no per-packet React re-render).

## Latency budget
fix age + WiFi + broker + backend + WS ≈ **< 1 s** — sufficient for a coach.

## Implementation note
The original requirements conversation sketched this on **NestJS + TimescaleDB**. The project as
built uses **Bun + Elysia + bun:sqlite** for the server and **React + Vite + canvas** for the client
(see [`CLAUDE.md`](../../CLAUDE.md)). The logical architecture above is unchanged — only the
runtime/framework differs; the MQTT topic, packet contract, server-timestamp rule, WS per-session
fan-out, and homography live view are all as specified here.
