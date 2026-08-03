# ADR-0002 — WiFi (not BLE) as the field transport

**Status:** Accepted · **Date:** 2026-06-14

## Context
The naive design is "wearable advertises over BLE → coach's phone reads it." But BLE range is
~10–30 m and a pitch is ~100×64 m. A coach on the touchline can't receive BLE from a player 80 m
away.

## Decision
Use **WiFi** (2.4 GHz) as the field transport: wearables push packets (MQTT) to a broker via one
outdoor AP. (4G is the alternative long-range transport.)

## Consequences
- **+** Covers the whole pitch from one AP (line-of-sight ~100 m), handles 10 devices.
- **+** Enables a true real-time push pipeline to the backend.
- **−** Requires a live field network (AP + broker + backend) during the session.

## Alternatives considered
- **BLE to phone** — rejected: range can't cover the pitch.
- **4G + IoT SIM** (Path B / Traccar) — works at range but adds per-device SIM cost and ~1 Hz / 1–3 s
  latency; reserved as a fallback.
