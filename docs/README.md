# football-trackers — Documentation

Business and product documentation for **football-trackers**, a private DIY system for
real-time tracking of youth football players. This folder captures the requirements,
market analysis, architecture, and decisions behind the project — derived from the
original requirements-gathering discussion (June 2026).

> These are product/business documents. For how the code is structured and how to run it,
> see the root [`README.md`](../README.md) and [`CLAUDE.md`](../CLAUDE.md).

## Contents

### product/
- [vision.md](product/vision.md) — problem, goal, target user, success criteria
- [market-analysis.md](product/market-analysis.md) — commercial trackers, pricing, the gap this fills
- [roadmap.md](product/roadmap.md) — phased delivery (MVP → v1 → v2) and the feature inventory

### requirements/
- [business-requirements.md](requirements/business-requirements.md) — objectives, stakeholders, scope, constraints, assumptions
- [functional-requirements.md](requirements/functional-requirements.md) — metrics and features to build
- [metric-definitions.md](requirements/metric-definitions.md) — exact formulas & youth-calibrated thresholds (speed zones, sprints, accel/decel, PlayerLoad, metabolic power, ACWR)
- [non-functional-requirements.md](requirements/non-functional-requirements.md) — real-time, accuracy, resilience, cost

### architecture/
- [architecture-brief.md](architecture/architecture-brief.md) — design brief / prompt for the target architecture: drivers (security, real-time, cost), dual deployment profile, security & scale requirements, deliverables
- [target-architecture.md](architecture/target-architecture.md) — the secure dual-profile design: local-core + cloud-relay, STRIDE threat model, authN/Z, MQTT security, retention, perf & cost budgets, evolution plan ([ADR-0006–0014](decisions/README.md))
- [system-architecture.md](architecture/system-architecture.md) — data flow and layers
- [reviews/2026-06-14-architecture-board-review.md](architecture/reviews/2026-06-14-architecture-board-review.md) — six-expert board review of the target architecture: verdict (approve-with-changes), top risks, adjudicated conflicts, prioritized actions, owner decisions
- [observability.md](architecture/observability.md) — metrics, logs, health, device self-telemetry; SLOs, alerts, runbook
- [hardware-bom.md](architecture/hardware-bom.md) — bill of materials, sourcing (Serbia), costs, what was ordered

### frontend/
- [improvement-plan.md](frontend/improvement-plan.md) — phased plan to take the coach live view to production: drivers, the six-expert panel's findings + adversarial corrections, the MSI (client-only) vs auth/data tracks, server contracts, testing ([ADR-0015–0018](decisions/README.md))
- [event-detection-contract.md](frontend/event-detection-contract.md) — tactical event detection (Track A) frozen contract: team-shape series + heuristic phases, off-loop posture, pre-mortem/post-build dispositions ([ADR-0020](decisions/0020-tactical-event-detection.md))

### dev/
- [local-bench-runbook.md](dev/local-bench-runbook.md) — run the whole pipeline locally with a **real wearable**: Docker Compose backend + host-run coach view, flashing/enrolling a device, the Wi-Fi / `MQTT_HOST` gotchas, and troubleshooting ([ADR-0021](decisions/0021-local-dev-docker-stack.md))

### decisions/
- [decisions/README.md](decisions/README.md) — architecture decision log (ADRs)

## Status
Requirements captured 2026-06-14. Firmware, Bun/Elysia ingest + WS fan-out + SQLite persistence, the React live
view, the four-phase FE roadmap, and GPS tactical event detection (Track A, [ADR-0020](decisions/0020-tactical-event-detection.md))
are implemented. **The first real prototype was validated end-to-end on 2026-06-17** — device → Wi-Fi → broker →
server → live view — via the local Docker stack ([dev/local-bench-runbook.md](dev/local-bench-runbook.md)); the
outdoor real-GPS dot + the battery remain. See [roadmap.md](product/roadmap.md) for what's next.

_Written in English to match the rest of the repo; a Serbian version can be produced on request._
