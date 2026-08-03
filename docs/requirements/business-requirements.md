# Business Requirements

Project: **football-trackers** — private, real-time youth football tracking. Date: 2026-06-14.

## 1. Background
A youth football coach needs to monitor ~10 players live during training and matches. Off-the-shelf
trackers either can't be read from outside (closed BLE, store-and-sync) or are priced on per-player
subscriptions unsuited to youth budgets, and the real-time ones are all closed. See
[market-analysis.md](../product/market-analysis.md). The decision is to build a custom system.

## 2. Business objectives
| # | Objective |
|---|---|
| OBJ-1 | Give the coach **live** (sub-second) visibility of every player during a session. |
| OBJ-2 | **Own the data** end-to-end — local storage, full export, no vendor lock-in. |
| OBJ-3 | Equip ~10 players at a **one-time low-hundreds-of-EUR** cost with **no subscription**. |
| OBJ-4 | Reach **~80% feature parity** with Catapult/STATSports core physical metrics. |
| OBJ-5 | Be extensible to football-specific (technical) metrics later. |

## 3. Stakeholders
| Stakeholder | Interest |
|---|---|
| Coach (primary user) | Live tablet view, per-player metrics, session management |
| Players / parents (later) | Personal stats, trends, records, engagement |
| Owner / developer | Full-stack build; owns firmware, backend, UI, data |

## 4. Scope

### In scope
- Per-player WiFi wearable (GPS, later IMU) streaming live telemetry.
- Field network (one outdoor AP) + MQTT broker + owned backend ingest.
- Coach live view: player dots on a calibrated pitch; core physical metrics.
- Local persistence and export.

### Out of scope (initially) / not feasible
- Reading or integrating any **commercial** tracker (closed BLE / no consumer API).
- BLE-to-phone as the field transport (range can't cover a pitch).
- Possession %, pass networks, team shape from wearables alone (need camera CV).
- RTK centimetre accuracy (needs a base station; overkill for youth).
- Building a smart ball (can't DIY; tracks the ball, not players).

## 5. Constraints
| # | Constraint |
|---|---|
| CON-1 | **Transport must be WiFi/4G, not BLE** — BLE range 10–30 m vs a 100×64 m pitch. |
| CON-2 | **Real-time requires streaming firmware + a live WiFi link** during the session. |
| CON-3 | Consumer GPS accuracy is ~2–5 m — fine for youth trends, not elite-grade. |
| CON-4 | Sourced in Serbia (local suppliers + AliExpress/TME); prices in RSD, FX/customs apply. |
| CON-5 | Solo build — firmware and on-field durability are the real effort, not the backend. |

## 6. Assumptions
- ~10 players per team; ~90-minute sessions.
- One outdoor 2.4 GHz AP covers the pitch (line-of-sight ~100 m).
- The coach has a tablet on the touchline on the same network.
- The owner has an AI/ML-capable desktop (RTX 3060 12 GB) for any future computer-vision work.

## 7. Guardrail
**Prove one device end-to-end before buying ten** — don't scale hardware until firmware → MQTT →
backend → live dot works on a single unit.

## 8. Key decisions
Recorded as ADRs in [decisions/](../decisions/README.md): build vs buy, WiFi vs BLE, real-time vs
store-and-sync, wearable hardware baseline, technical-metrics sensor strategy.
