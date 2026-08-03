# ADR-0016 — Player names via an authenticated per-session roster (stores stay pseudonymous)

**Status:** Implemented (FE Phase 3, 2026-06-15) · **Date:** 2026-06-15

> Built to the frozen [Phase 3 contract](../frontend/phase-3-contract.md) (§1). Roster store
> [`server/src/roster.ts`](../../server/src/roster.ts) (fail-closed async loader, modelled on `auth.ts`),
> provisioning CLI [`server/roster-user.ts`](../../server/roster-user.ts) (`roster.json`, mode `0o600`),
> `GET /sessions/:id/roster` in [`server/src/server.ts`](../../server/src/server.ts) (auth + per-principal
> rate-limit + audit log + `Cache-Control: no-store`), erasure coupling in
> [`server/purge-player.ts`](../../server/purge-player.ts) (`rosterEntriesErased` in the receipt), and the
> render-only client join `client/src/useRoster.ts`. Verified by `test/roster-loader.ts`, `test/roster-cli.ts`,
> `test/roster-e2e.ts`, `test/erasure-e2e.ts`, and the standing name-leak guard.

## Context
Coaches think in **names**, not opaque ids; the live view shows `playerId` only, which is the core
glanceability gap. [ADR-0010](0010-location-data-retention.md) deliberately keeps the `playerId → name` map in
a **separate, access-controlled, encrypted store** and the wire contract / telemetry DB / Prometheus labels
pseudonymous (only `playerId`). The product owner chose: show **real names via an authenticated, per-session
roster fetch — never bundled**. The FE panel's adversarial pass confirmed names *can* be shown without
breaking store-level pseudonymity, but only if the join stays client-side at render and several easy
regressions are blocked — otherwise pseudonymity becomes a label, not a control.

## Decision
- **Names resolved client-side at render only.** Fetch an authenticated `GET /sessions/{id}/roster` →
  `[{playerId, displayName}]`; hold it **in memory**; never persist it client-side; resolve `playerId → name`
  at draw time.
- **Separate authz decision.** The roster endpoint is authorised against the **authenticated principal**
  ([ADR-0008](0008-authentication-access-control.md) / [ADR-0015](0015-frontend-auth-transport.md)) — **not**
  the live WS path — and is access-controlled and session-scoped.
- **Stores stay pseudonymous.** No `name` field in the wire contract, the telemetry DB, replay-export rows,
  logs, or **any** Prometheus label. Block any schema/migration that adds a name column; add a guard/test
  asserting no metric label value and no log line ever carries a name (extend the existing `/metrics`-shape
  e2e).
- **Erasure follows the name.** The moment a roster store ships, `purge-player` ([ADR-0010](0010-location-data-retention.md))
  deletes the roster entry too — ADR-0010 already lists this as owed.
- **Honest scope.** This keeps the **location stores** pseudonymous — *not* the coach screen or any review
  export, which are identified by design and must be treated as identified data operationally.

## Consequences
- **+** Real coaching legibility without weakening the data-at-rest privacy posture.
- **+** A leaked DB / `/metrics` scrape still exposes no names.
- **−** Adds a server roster endpoint + its authz; couples to ADR-0015 login.
- **−** The coach screen and any cached review artifact are identified data — handle accordingly.

## Alternatives considered
- **Names on the wire / in the bundle** — rejected: re-identifies the whole feed; exactly what ADR-0010 forbids.
- **Names in metric labels** (for nicer dashboards) — rejected: re-identifies the entire location history via
  a `/metrics` scrape.
- **Keep ids-only** — rejected: poor coaching UX; the owner chose names-via-authenticated-fetch.
