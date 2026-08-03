# 20. Tactical event detection from GPS (Track A); ball-events deferred (Track B)

Date: 2026-06-16

## Status

**Implemented** (Track A, 2026-06-16) — see [event-detection-contract.md](../frontend/event-detection-contract.md).
Track B (ball-interaction events) remains **deferred** (§6). Built via the house flow: frozen contract → 5-lens
adversarial pre-mortem (6 must-fix folded) → parallel disjoint-file slices → integration → post-build
security/correctness review (3 confirmed + 5 nits, all test-coverage/env-hardening — zero feature-code bugs).
Verified green: server `tsc` + `test/events.ts` + `test/events-e2e.ts` (270k-row off-loop SLO + shared-cap 503)
+ `test/scan-load.ts` (cross-surface shared cap) + the full existing suite; client `tsc`/lint/units + the
Playwright review spec (panel render + honesty labels + no-persist + no-name-in-DOM).

## Context

The repo README lists "Football events (passes/shots)" as a future capability, qualified as needing **a calf
IMU @200–500 Hz + ML, or one elevated 4K camera + CV**. The deployed system, however, senses **only our own
team's player positions at 10 Hz** — no ball, no opponents, no IMU, no camera. A pass/shot is a sub-second
ball event that is **physically invisible** to 10 Hz single-team position data; attempting to detect it from
GPS would manufacture noise.

What *is* derivable from synchronized multi-player GPS is **collective movement structure**: where the team's
centroid is, how compact it is, how much of it is running hard, and when it is essentially stopped. These are
real, coach-meaningful signals — and they correlate with footballing phases (transitions, pressing, dead
time) without claiming to be the ball events themselves.

We must also not regress the project's security spine: children's location is the #1 protected asset, and any
new read over stored fixes is a bulk-export surface that has to match the `history.ts` posture (off-loop,
authz, rate-limited, audited, no-store, no names, SLO-gated).

## Decision

Split "football-event detection" into two tracks and **ship Track A only**:

- **Track A (this ADR) — GPS-only collective/tactical *movement* events.** A new **off-loop** analytics
  endpoint `GET /sessions/:id/events` computes, over stored history via the existing keyset-paged + yielding
  scan:
  1. a **team-shape time series** (adaptive ~1 s buckets): centroid, stretch/compactness, convex-hull
     surface area, spread, mean speed, HSR fraction; and
  2. three **heuristic phase events** — `high_tempo`, `transition`, `stoppage` — each with a `confidence` and
     honest "movement-derived" labelling (ADR-0018 lineage).
  Rendered as a review-mode timeline. The endpoint **reuses `sessionGetGate` verbatim** and adds the same
  per-principal rate-limit + inflight cap + audit + `no-store` + opaque-error + off-loop-SLO discipline as
  `/history`. The result is **team-aggregate** (no `playerId`), so it is strictly less identifying than the
  existing raw-replay surface.

- **Track B (deferred) — true ball-interaction events.** Passes/shots/tackles require new sensing: (B1) a
  boot/calf IMU @200–500 Hz + an ML pipeline (firmware-owned dependency; we do not edit `firmware/src/main.cpp`),
  or (B2) an elevated 4K camera + CV (a different data plane that **reopens the out-of-scope child-video
  DPIA**). Track B is a sensing/ML research spike with its own ADR — **not** built here, and explicitly **not**
  attempted from GPS.

**Threshold sourcing.** Speed inputs reuse the spec-grounded, session-resolved youth cuts
(`thresholdsForSession`, ADR-0019 / metric-definitions §3.2) and the §2.1 walking floor. The structural
detector parameters (intensity fraction, durations, displacement, windows) are **new, proposed heuristics** —
`metric-definitions.md` defines no collective thresholds — so they are env-tunable, default-documented, and
flagged everywhere as **unvalidated on real match data**, never as measurement truth.

## Consequences

**Positive**
- Delivers genuinely useful tactical signals (compactness, tempo, dead-time segmentation, territorial
  transitions) from data we already store — **no new hardware**.
- No new exposure class: team-aggregate centroid/shape is less identifying than the per-player tracks already
  exposed by `/history`; the same security posture applies, gated identically.
- Honest by construction: confidence + provenance + "movement-derived" labels prevent over-claiming.
- The bucketed cross-player scan keeps O(players) memory and bounded output, and is SLO-gated like history.

**Negative / risks**
- The structural thresholds are unvalidated; they will misfire until tuned on real matches. Mitigated by
  honest labelling, confidence scores, env-tunability, and review-only (never live, never a coaching verdict).
- A **second** off-loop scan shape (group-by-time) is new and must independently pass the event-loop SLO.
- Centroid/length/width along true pitch axes is deferred (no pitch-geometry config) — surface area, stretch,
  and spread are orientation-independent and sufficient for the MSI.

**Deferred (need IMU/camera or pitch geometry / real data):** passes/shots/tackles (Track B), pitch-aligned
length×width, opponent-relative pressing, possession.

## Alternatives considered

- **Detect passes/shots from GPS now** — rejected: physically impossible at 10 Hz single-team position; would
  fabricate events. This is the central reason for the Track A/B split.
- **Live tactical overlay** — deferred: derived/tactical metrics belong off the per-packet path
  (metric-definitions §9); a live centroid/compactness overlay is a possible follow-on behind its own
  frame-budget gate, not the MSI.
- **New `events` scan vs extending the history aggregate** — chose a separate module/endpoint: the scan shape
  (group-by-time vs group-by-player) and the bounded-series output differ, and isolation keeps each surface's
  caps independent and its SLO separately provable.

## References
- [event-detection-contract.md](../frontend/event-detection-contract.md) — the frozen contract.
- [ADR-0017](0017-review-replay-data-source.md) — off-loop history read + SLO (the posture reused).
- [ADR-0018](0018-live-position-smoothing-honesty.md) — the honesty rule reused for confidence/labelling.
- [ADR-0019](0019-age-banded-zones-session-config.md) — the youth thresholds the speed inputs resolve from.
- [metric-definitions.md](../requirements/metric-definitions.md) §2.1/§3.2/§9.
