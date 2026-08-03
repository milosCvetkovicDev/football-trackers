# ADR-0001 — Build a DIY system instead of using a commercial tracker

**Status:** Accepted · **Date:** 2026-06-14

## Context
The goal is **real-time** player data that the coach **fully owns**, affordable for ~10 youth
players. The market (see [market-analysis](../product/market-analysis.md)) shows:
- Consumer trackers are closed (proprietary BLE, encryption, store-and-sync to vendor cloud) and
  can't be read from outside.
- Public APIs exist only on a few **pro** brands and are **cloud** APIs (customer + token), not
  device SDKs.
- Affordable youth devices (Footbar, STATSports Athlete) are the closed ones; the ones with APIs
  (Catapult, WIMU) are expensive subscription/pro systems. **Cheap + open don't coexist.**
- Every real-time commercial system is closed.

## Decision
Build a custom system: per-player WiFi wearable + owned backend + owned coach UI ("Path A").

## Consequences
- **+** Full real-time stream, complete data ownership, one-time cost, no subscription.
- **+** Backend/UI are in the owner's wheelhouse (full-stack).
- **−** Must build firmware and durable wearable units; pitch calibration is on us.
- **−** Consumer-GPS accuracy (~2–5 m), not elite-grade.

## Alternatives considered
- **Buy commercial (Footbar/STATSports/Catapult/PlayerMaker)** — rejected: closed data and/or
  per-player subscription, and the cheap ones aren't real-time/open.
- **Path B — cheap 4G trackers + Traccar (open source)** — viable weekend MVP for live dots, but
  ~1 Hz, GPS-only, 1–3 s latency; too coarse for sprint/accel/load. Kept as a fallback to see live
  dots fast.
