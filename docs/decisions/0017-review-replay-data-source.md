# ADR-0017 — Post-match review & replay: one renderer, history read off the live loop

**Status:** Implemented (FE Phase 3, 2026-06-15) · **Date:** 2026-06-15

> Built to the frozen [Phase 3 contract](../frontend/phase-3-contract.md) (§3). Of the two sanctioned read
> paths below, the **single-threaded keyset-paging** option was chosen (worker thread deferred):
> [`server/src/history.ts`](../../server/src/history.ts) pages the existing `idx_telemetry_session_ts` index in
> `HISTORY_SCAN_CHUNK`-row (default 1000) batches and `await`-yields between them — like `retention.ts` — using
> the existing WAL `db` handle (no separate read-only connection). `GET /sessions/:id/history` in
> [`server/src/server.ts`](../../server/src/server.ts) carries the auth posture + DoS controls (span-cap,
> per-principal rate-limit, inflight cap, audit log, `Cache-Control: no-store`); the client is
> `client/src/useHistory.ts` + `ReviewView.tsx` reusing the live homography. The off-loop SLO is verified — not
> asserted — by `ft_history_read_seconds` plus the `test/history.ts` SLO case (≥270k pre-seeded rows; a
> concurrent aggregate query must not freeze the live `ft_ws_messages_sent_total` rate). The `history.ts`
> boundary keeps the worker-thread swap local if the SLO ever fails.

## Context
Workstream (c) adds a **review / replay** mode. Raw 10 Hz fixes already persist in bun:sqlite under 30-day
retention ([ADR-0010](0010-location-data-retention.md)); there is **no** client history API. Everything runs
on **one Bun event loop** and bun:sqlite is **synchronous** — [`server/src/retention.ts`](../../server/src/retention.ts)
already chunks its deletes to avoid stalling live ingest. The FE panel's adversarial pass confirmed a naive
synchronous history read (~540k rows for a 90-min, 10-player match) would **freeze every live tablet** mid-
match, and that a history endpoint is a new **bulk-export attack surface** for children's location.

## Decision
- **One renderer, two modes.** Reuse `PitchCanvas` + the homography for both live and review; a mode-aware
  shell switches the data source (live WS vs history fetch). No second rendering stack.
- **History reads off the live loop.** Serve `GET /sessions/{id}/history` from a **worker thread / dedicated
  read-only `Database` handle** (WAL already permits concurrent readers without blocking the writer), **or**,
  if single-threaded, **page** it (keyset on `server_ts`, bounded chunks, yield between) exactly like
  `purgeOlderThan` — **never** materialise a whole match with `.all()`.
- **Verified as an SLO, not asserted.** Add `ft_history_read_seconds` and an e2e assertion that a review query
  issued while the simulator ramps to 50 players does **not** introduce a gap in the live `ft_ws_*` rate.
- **Auth + minimisation.** The endpoint reuses `/live`'s auth posture (principal + Origin,
  [ADR-0015](0015-frontend-auth-transport.md)), is **session-scoped** ([ADR-0010](0010-location-data-retention.md)),
  and never lives on a public unauthenticated interface. Prefer a **session-aggregate / down-sampled** store
  for replay where the coaching question allows (smaller result sets; aligns with ADR-0010 minimisation).
- **Reuse record/replay for tests.** The simulator's `--record`/`--replay`
  ([`server/test/simulate.ts`](../../server/test/simulate.ts)) drives deterministic review-mode tests.

## Consequences
- **+** Review mode without a second renderer; the live feed stays smooth during a review query.
- **+** The history endpoint can't become an unauthenticated bulk location export.
- **−** A worker-thread (or careful paging) read path is more work than a naive `SELECT`.
- **−** Adds a server history endpoint + a new SLO/test.

## Alternatives considered
- **Naive synchronous `SELECT … .all()`** — rejected: blocks the shared event loop, freezes every live tablet.
- **A separate review renderer** — rejected: duplicates the homography/canvas; more code, drift risk.
- **Replay only from the raw 10 Hz trace** — kept *secondary*; default to per-player aggregates + position
  heatmap (smaller, age-appropriate, ADR-0010-aligned), raw replay on demand.
