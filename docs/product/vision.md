# Product Vision

## One-liner
A privately owned, real-time tracking system for a youth football team — each player streams
live position (and later movement) to the coach's tablet during training and matches, with full
ownership of the data and no per-player subscription.

## The problem
A youth coach wants to track ~10 players and see performance **live, during the session** — not
as a report synced after training. The journey started from a simpler question: *"Can I build a
mobile app that reads an existing football GPS tracker that already has its own app?"*
Investigating that surfaced two hard walls:

1. **Reading commercial trackers from the outside is effectively impossible.** Consumer football
   trackers use closed, proprietary BLE protocols (undocumented GATT services), often with pairing
   encryption, and most **store-and-sync** to the vendor's cloud rather than streaming live. See
   [market-analysis.md](market-analysis.md).
2. **The economics are wrong for youth football.** The affordable devices are closed; the ones
   with open (cloud) APIs are expensive, subscription, pro-grade systems. "Cheap + open data" does
   not exist in one product.

## The goal
**Real-time + fully owned.** Since no off-the-shelf product delivers live, open data at a
youth-team price, the system is built in-house: a custom WiFi wearable per player plus an owned
backend and coach UI. This trades hardware/firmware effort for complete control over the data and
a one-time cost instead of recurring per-player fees.

## Target user
- **Primary:** the coach of a single youth team (~10 players), watching live on a tablet on the
  touchline.
- **Secondary (later):** players/parents viewing personal stats, trends, and records.

## Why this is achievable here
The owner is a full-stack engineer — the backend and UI are in their comfort zone. The real
challenge is the firmware and pitch calibration, not the server. A real-time pipeline the coach
controls end-to-end is a realistic build, not a research project.

## Success criteria
- A coach sees **live player dots** on a calibrated pitch with **sub-second latency**.
- Equipping ~10 players costs a **one-time** amount in the low hundreds of EUR, with **no
  subscription**.
- All data is stored locally and is fully exportable/owned.
- Core physical metrics (distance, speed, sprints, heatmap) reach ~80% of what Catapult/STATSports
  sell — with **live** as the differentiator.

## Guiding constraints (decided early)
- **WiFi, not BLE** for the field transport (BLE can't cover a pitch) — [ADR-0002](../decisions/0002-wifi-vs-ble-transport.md).
- **Real-time streaming, not store-and-sync** — [ADR-0003](../decisions/0003-realtime-vs-store-and-sync.md).
- **Prove one device end-to-end before buying ten.**
