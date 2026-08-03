# ADR-0004 — ESP32 (WEMOS Lite) + NEO-M8N wearable baseline

**Status:** Accepted · **Date:** 2026-06-14

## Context
The wearable must stream 10 Hz GPS (and later IMU) over WiFi, run a ~90-min session on battery, and
be cheap enough to build ×10. Boards and GPS modules vary in capability and cost.

## Decision
Prototype baseline per unit:
- **WEMOS Lite ESP32** (LOLIN32 Lite) — plain ESP32 is enough to stream at 10 Hz, and it has
  **on-board LiPo charging** (no separate TP4056).
- **GY-GPSV3 NEO-M8N** — 10 Hz, multi-constellation, TTL/UART.
- **LP-503759CL 1S LiPo 1350 mAh** — covers a session with margin.
- IMU is **optional for v1** (GPS gives ~80% of physical metrics); add MPU-6050 later for PlayerLoad
  / cleaner accel-decel.

## Consequences
- **+** Cheapest, cleanest wearable for physical metrics; fewer parts (no TP4056).
- **+** 10 Hz cleanly captures sprints and accelerations.
- **−** Plain ESP32 isn't ideal for 500 Hz IMU shot-detection — that's the S3's job (Variant C).

## Alternatives considered
- **ESP32-S3 DevKitC** — more capable (PSRAM, faster core) and future-proof for fast IMU / ML /
  camera, but overkill for Variant B and has no on-board LiPo charging. Choose it only as a single
  board for all variants.
- **NEO-6M GPS** — rejected: ~1 Hz, smears sprints/accelerations.
- **NEO-M9N GPS** — marginally better under cover; not worth the cost for youth; an option for a
  guaranteed-original batch via TME.
