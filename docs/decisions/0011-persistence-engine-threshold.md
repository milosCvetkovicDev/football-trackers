# ADR-0011 — Persistence engine: bun:sqlite now, TimescaleDB only on a trigger

**Status:** Accepted (design) · **Implementation:** done (bun:sqlite is the current engine; swap deferred) · **Date:** 2026-06-14

## Context
The original sketch named TimescaleDB. The system as built uses `bun:sqlite` (WAL, one prepared insert per
packet) behind the [`db.ts`](../../server/src/db.ts) seam. The current envelope is one session, 10–20 players,
~100–200 msg/s — trivial for SQLite. Introducing a networked time-series DB now would add an operational
component, a network hop (latency + a new attack surface), and cost, for no benefit at this scale
([brief §5](../architecture/architecture-brief.md#5-scale-envelope--design-to-this)).

## Decision
Keep **bun:sqlite** as the persistence engine. Preserve the `db.ts` module boundary so a TimescaleDB writer
can replace it **without touching `ingest.ts`**. Swap **only** when a concrete trigger fires:
- sustained throughput well beyond ~200 msg/s, **or**
- multiple concurrent sessions / multi-club operation, **or**
- analytics queries SQLite can't serve at acceptable latency.

None of these exists today.

## Consequences
- **+** Zero extra infrastructure, cost, or attack surface now; in-process writes keep ingest latency low.
- **+** The seam keeps the future swap cheap and localised.
- **−** SQLite is single-host — acceptable; the [relay design](0006-local-core-cloud-relay.md) keeps raw local
  by design anyway.

## Alternatives considered
- **TimescaleDB now** — rejected: premature; adds a service, a network hop, and cost for no current need.
- **Postgres (plain)** — rejected for the same reason; revisit only with the swap trigger.
