# ADR-0019 — Age-banded speed zones via a per-session config store

**Status:** Implemented (FE Phase 4, 2026-06-15) · **Date:** 2026-06-15 · See [phase-4-contract.md](../frontend/phase-4-contract.md)
(`sessionConfig.ts` store + `session-config.ts` CLI + `GET /sessions/:id/config`; client `useSessionConfig` + `zones.ts`).

## Context
Phase 4 adds coaching metrics: speed-zone colouring (live), distance + distance/min (live), an isolated-player
cue (live), and post-match aggregates — zone breakdown, sprint efforts, accel/decel efforts (review). The
governing rule from [metric-definitions](../requirements/metric-definitions.md) §0/§3: **adult speed
thresholds do not transfer to children** — a U13 records *zero* sprint distance against an adult 25.2 km/h
cut-off. The high-intensity (HSR) and sprint cut-offs must be **age-banded**, and the threshold set used
**must be stored with each session** so a later comparison knows which numbers produced the result (§3.2).

## Decision
- **Age bands** U12/U14/U16/U19 with the §3.2 default thresholds: zones 1–3 keep the adult walking/jogging/
  running breaks (0 / 2.0 / 4.0 m/s); only **HSR** and **Sprint** scale by band — U12 4.44/5.28, U14 4.86/5.83,
  U16 5.28/6.39, U19 5.50/6.94 (m/s). Individualized MSS/MAS thresholds (§3.3) are deferred (need per-player testing).
- **Per-session age band lives in a server-side config store** — a separate, fail-closed JSON file
  (`SESSION_CONFIG_FILE`), modelled exactly on the Phase-3 roster store (async load, size-cap, periodic reload,
  0o600, a provisioning CLI). An unconfigured session resolves to a documented default band (U14), so zones
  always render. This literally satisfies "store the threshold set with each session."
- **Single source of truth for the band→threshold mapping is the server.** `GET /sessions/:id/config` returns
  `{ageBand, thresholds}`; the client uses the returned thresholds for live zone colouring, and the server
  reads the same band for the review aggregates — so live and review never disagree, and the client never
  re-implements the table.
- **Scope = GPS-derivable coaching metrics only** (zones, distance, distance/min, sprint efforts §3.4,
  accel/decel efforts §4). **Deferred:** IMU PlayerLoad (§5.1, no hardware), metabolic power/HMLD (§5.2),
  sRPE (§5.3), ACWR/monotony (§6, cross-session daily-load tracking) — all out of Phase 4.
- **Load metrics stay off the live path** (§3/plan): sprint/accel/decel counts are review-only; live carries
  only zone colour + distance/min + the isolated cue.

## Consequences
- **+** Youth-correct zones; provenance per session; live and review consistent by construction.
- **+** The config store reuses the proven roster pattern (fail-closed, 0o600, reload, CLI) — low novelty risk.
- **−** A new provisioning surface (store + endpoint + CLI + reload + tests) — chosen over a client-picked band
  for cross-device/coach consistency (product-owner decision).
- **−** The age band is not an identity/secret, but the config file + endpoint inherit the session-scoped
  authz posture anyway for uniformity (it is NOT name/location data, so no `no-store`/rate-limit is required —
  see the Phase-4 contract).

## Alternatives considered
- **Client-picked band + query param (echoed for provenance)** — rejected by the owner: simplest, but two
  coaches could pick different bands for the same session; no server-stored provenance.
- **Single global env default band** — rejected: a club with multiple age groups can't differentiate sessions.
- **Individualized MSS/MAS thresholds now** — rejected: requires per-player sprint testing the project lacks; the
  age-band defaults are the documented "start here," with individualization a later upgrade.
