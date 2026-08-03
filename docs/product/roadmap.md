# Roadmap & Feature Inventory

The competitive insight: the pro platforms do almost everything **post-session**; this project is
**real-time**. Live is the differentiator, not a missing feature. Every metric below is derivable
from the GPS + IMU stream the wearable already produces (technical metrics need the extra leg
sensor or a camera — see [functional-requirements.md](../requirements/functional-requirements.md)
and [ADR-0005](../decisions/0005-technical-metrics-sensor-strategy.md)).

## Delivery phases

### Phase 0 — Prototype (1 device) — _in progress_
Prove the whole chain with a single unit before buying ten:
firmware → MQTT → backend → **one live dot moving on a calibrated pitch**.
- 1× WEMOS Lite ESP32 + NEO-M8N + LiPo, WiFi hardcoded, publish 10 Hz JSON → Mosquitto → backend log.
- WebSocket → React renders one moving dot on the homography-calibrated pitch.

### Phase 1 — MVP (~80% of Catapult/STATSports value)
Distance + speed + sprints + speed zones + heatmap + **live positions** + splits.
Scale to N devices, add metrics + persistence.

### Phase 2 — v1
Load management (trends, personal records, ACWR), engagement (Pro Score, leaderboards,
achievements), optional BLE heart-rate, post-session analytics + export.

### Phase 3 — v2 (football-specific / technical)
Shots, passes, dribbling — via leg/boot IMU (per-player, live) and/or one elevated camera with
open-source CV (whole team, ball-centric). Possession %, pass networks, team shape (camera only).

## Feature inventory (benchmarked against pro platforms)

### Core physical metrics — _Catapult One, STATSports (16 metrics)_
Total distance, max/current speed, sprint count & distance, High Speed Running (HSR), High
Intensity Distance, distance per minute (intensity), accelerations/decelerations, PlayerLoad, GPS
heatmap.
→ All computable from the GPS+IMU stream (haversine distance, speed zones, IMU accumulation).

### Spatial / tactical
Position heatmap, directional running. **Live dots are the project's bonus.** The direct model for
the coach view is **PLAYERTEK Plus** (Catapult's coach app), which does live distance, sprint
distance, % time in HR red zone, top speed, distance/min, and create/edit splits per player in
real time.

### Load management
Trends and benchmarks vs personal records, recovery guidance, overtraining/injury-risk signals.
Add **ACWR** (acute:chronic workload ratio) from stored history.

### Engagement / gamification
Pro Score (single overall rating), leaderboards (Max Speed, HSR, High Intensity Distance, Total
Distance), achievements, personal records, teams/invites, match-up comparison by age/position.

### Coaching
Drill library / training plans, recovery advice, session management, pod-to-player assignment.

### Easiest "pro" add — Heart Rate
A cheap BLE HR strap using the **standard Heart Rate profile (0x180D)** — readable by any app, no
reverse-engineering. Yields HR zones and time-in-red-zone (like PLAYERTEK). Low effort, high value.

## MVP parity statement
distance + speed + sprints + speed zones + heatmap + live positions + splits ≈ **80% of what
Catapult/STATSports sell** — delivered **live**, which they mostly don't.
