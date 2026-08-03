# ADR-0003 — Real-time streaming (not store-and-sync)

**Status:** Accepted · **Date:** 2026-06-14

## Context
The coach needs data **live during the session**, not as a post-training report. The same ESP32 +
GPS + IMU hardware can be built two ways — the difference is firmware, not parts:
- **Streaming**: read sensors and immediately push each sample over WiFi → MQTT → backend → WS →
  tablet (sub-second).
- **Store-and-sync**: log to flash/SD during the session, download afterwards (what cheap consumer
  trackers do — no live picture).

## Decision
Firmware **streams** every sample in real time. As a safety net it **also** logs to flash and
replays on reconnect, so a brief WiFi dropout doesn't lose data (real-time primary + backup).

## Consequences
- **+** Live coach view; the project's core differentiator vs commercial post-session tools.
- **+** Flash backlog makes the live stream resilient to field dropouts.
- **−** Requires the WiFi link + broker + backend + tablet all live during the session; if any drops,
  it falls back to "after the fact."

## Alternatives considered
- **Store-and-sync only** — rejected: no live view, defeats the purpose.
