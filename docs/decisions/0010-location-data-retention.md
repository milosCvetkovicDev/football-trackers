# ADR-0010 — Location data retention & erasure for minors

**Status:** Accepted · **Implementation:** partial — raw-fix time-based purge + per-player **raw** erasure
shipped 2026-06-14 (e2e-verified, `secure_delete` byte-level); aggregates / roster / cloud-copy erasure
**not built** (those stores don't exist yet) · **Date:** 2026-06-14

## Context
Raw 10 Hz fixes are the **live location of children** — special-category-sensitive (GDPR / safeguarding).
The longer raw data is kept, and the more places it lives, the larger the breach blast-radius and the storage
cost. The analytics value, however, is in the **per-session aggregates** ([metric-definitions](../requirements/metric-definitions.md)),
not the indefinite raw trace.

## Decision
- **Raw fixes:** retained on the **field box only** for `RETENTION_DAYS` (default **30**, configurable), then a
  scheduled job **auto-purges** them, leaving `session_aggregate`.
- **Cloud (relay):** stores **aggregates only** — never durable raw 10 Hz.
- **Right to erasure:** a `purge-player <playerId>` operation deletes raw + aggregates + roster entry + the
  cloud aggregate copy for that player.
  - *Shipped today (raw only):* [`server/purge-player.ts`](../../server/purge-player.ts) erases the raw
    `telemetry` rows (`secure_delete` zeroes the bytes). Aggregates/roster/cloud copies don't exist yet;
    when they land, extend the CLI to purge them too. Two residuals it can't reach — the running server's
    in-memory Prometheus series (clear by restart) and pre-wipe DB backups — are in the
    [erasure runbook](../architecture/observability.md).
- **Pseudonymity:** the telemetry DB carries only opaque `playerId`; the `playerId → name` roster is a
  separate, access-controlled, encrypted store.

## Consequences
- **+** Bounds both storage (~1–2 GB on the field box) and breach blast-radius.
- **+** Cloud holds the least sensitive data; a VPS compromise can't leak raw traces.
- **+** Concrete GDPR posture (minimisation, retention limit, erasure path).
- **−** Raw history beyond 30 days is gone — accepted; aggregates carry the durable analytics value.

## Alternatives considered
- **Keep raw forever** — rejected: unbounded sensitive-data liability and cost for little analytic gain.
- **Push raw to the cloud for convenience** — rejected: maximises sensitive data at rest in the exposed tier.
- **No purge, manual cleanup** — rejected: retention must be automatic to be trustworthy.
