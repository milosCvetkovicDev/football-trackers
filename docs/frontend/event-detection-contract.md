# Tactical event-detection — frozen contract

**Status:** Frozen (pre-code) · **Date:** 2026-06-16 · **ADR:** [0020](../decisions/0020-tactical-event-detection.md)
· **Initiative:** football-event detection, **Track A** (GPS-only collective/tactical *movement* events).
Built the [house way](../../../.claude): frozen contract → adversarial pre-mortem → parallel disjoint-file
slices → integration → post-build security/correctness review.

> **Scope reality (read first).** The system tracks **only our own team's player positions** at 10 Hz — no
> ball, no opponents, no IMU, no camera. True ball-interaction events (passes/shots/tackles) are **not
> derivable** from this data ([README](../../README.md) "Football events" → needs a calf IMU @200–500 Hz +
> ML or a 4K camera + CV) and are **out of scope** (Track B, a separate sensing/ML spike — ADR-0020 §6).
> This contract delivers *movement-derived* collective events: a team-shape time series + high-tempo,
> transition, and stoppage phases. They **correlate with** football events but are **not ground truth** —
> §0.5 (honesty) is law.

---

## §0 Principles (non-negotiable)

- **§0.1 Children's location is the #1 protected asset.** Driver order: **security > performance > cost.**
  The events endpoint is a **bulk-export surface derived from minors' location** and inherits the *entire*
  `history.ts` posture (§0.4). It is **strictly less** identifying than `/history` (team-aggregate centroid,
  no per-player tracks) but is gated identically — never weaker.
- **§0.2 No name, anywhere.** No child/player name may enter the events module, its result, any log line, any
  metric label, the DB, or client persistence. The events result carries **no playerId at all** (it is
  team-aggregate) — even more minimal than the pseudonymous history aggregate. Coach usernames may appear in
  the audit log (never a metric label).
- **§0.3 Off the live loop.** All detection runs over **stored** history via the existing keyset paging +
  `await`-yield discipline (`db.readFixesPage`), never on the ingest/fan-out hot path. The §5 SLO is a gate.
- **§0.4 Authz posture — reuse `sessionGetGate` verbatim** (`server.ts`): Origin-lenient (absent OK on a
  same-origin GET; a *present* Origin must be allow-listed) → `currentPrincipal` (401 before id-validity so
  there is **no session-id oracle**) → `validSessionId` (400) → `authorizedFor` (403). Then a per-principal
  token bucket + global inflight cap (§3.3), an audit-log line, `Cache-Control: no-store`, and **opaque
  fixed-code errors** (never echo a query value — a misconfigured client could pass a name).
- **§0.5 Honesty (ADR-0018 lineage).** Every event is a **heuristic over movement**, never a confirmed ball
  event. Each carries a `confidence ∈ [0,1]` and the result ships the **resolved speed thresholds + ageBand
  provenance** it was scored against. The UI labels events "movement-derived." Never present a detection as
  ground truth. The structural detector parameters (§1.3) are **proposed, unvalidated on real match data** —
  env-tunable, documented as such, **not** spec constants.
- **§0.6 Bounded output.** The returned series length is bounded (§1.2 adaptive bucket size, ≤ `MAX_BUCKETS`)
  regardless of the query span, so a wide window can't return an unbounded body. The *scan* is still O(rows)
  and bounded by the span cap (§3.3) + paging.

---

## §1 Domain rules

### §1.1 What is computed (per time bucket — the team-shape series)
Reconstruct **time-aligned team snapshots** by binning the keyset scan into adaptive buckets (§1.2). Within a
bucket, take each player's **latest** fix (rows ascend by `(server_ts, rowid)`, so last-write-wins = latest).
For each non-empty bucket emit one `TeamShapeBucket` (§2.2):

- `centroid {lat, lon}` — mean of present players' positions.
- `stretchM` — mean distance (m) of present players from the centroid (compactness; needs ≥ 1 player, 0 for 1).
- `surfaceAreaM2` — convex-hull area (m²) of present players (monotone-chain hull + shoelace); **0 if < 3**.
- `spreadM` — max pairwise distance (m) between present players (team "size"); 0 if < 2.
- `meanSpeedMps` — mean of present players' `spd`.
- `hsrFraction` — fraction of present players with `spd ≥ hsrMps` (the session's resolved HSR cut, §1.4).
- `count` — players present (data-quality signal; a 1–2 player bucket is weak — the client should show it).

Geometry uses a **local equirectangular projection about the bucket centroid** (orientation-independent;
**no pitch-corner dependency**). Reference: `metric-definitions.md §2.1` (planar pitch-scale steps).

### §1.2 Adaptive bucketing (bounds the output)
`bucketMs = max(MIN_BUCKET_MS, ceil(span / MAX_BUCKETS))` where `span = to − from`. With `MIN_BUCKET_MS=1000`
and `MAX_BUCKETS=5000`, any span ≤ ~83 min buckets at 1 s; longer spans coarsen so the series never exceeds
`MAX_BUCKETS`. `bucketMs` is computed **before** the scan (span is known from params) and **returned** in the
result (provenance). Bucket index `= floor((serverTs − from) / bucketMs)`, monotonic non-decreasing across the
ascending scan, so a bucket closes the moment a row with a higher index arrives (streaming, O(players) memory).
Empty intermediate buckets are simply skipped (no snapshot).

### §1.3 Detectors (over the bounded in-memory series — cheap synchronous post-pass, O(buckets))
Run **after** the paged scan, over the bounded `series` (≤ `MAX_BUCKETS`), using real bucket-ts gaps. Three
event types (each a small state machine mirroring `history.feedBand`/sprint-run merge logic):

- **`high_tempo`** — a run of buckets with `hsrFraction ≥ HIGH_TEMPO_FRACTION`, sustained `≥ HIGH_TEMPO_MIN_S`
  **and** spanning `≥ 2` qualifying buckets. `confidence = clamp01(peakHsrFraction)`. Summary: `peakHsrFraction`.
- **`transition`** — over a sliding window `≤ TRANSITION_WINDOW_S`, the **centroid net displacement** (great-
  circle m) `≥ TRANSITION_M` **and** the window's mean `meanSpeedMps ≥ TRANSITION_MIN_MEAN_MPS` (the team is
  actually moving, not jittering). Non-overlapping (after emitting, the window restarts at the end bucket).
  `confidence = clamp01(shiftM / (2·TRANSITION_M))`. Summary: `centroidShiftM`.
- **`stoppage`** — a run of buckets with `meanSpeedMps < STOPPAGE_SPEED_MPS` **and** per-step centroid movement
  `< STOPPAGE_CENTROID_MAX_M`, sustained `≥ STOPPAGE_MIN_S` and `≥ 2` buckets. `confidence = clamp01(1 −
  meanSpeedMps / STOPPAGE_SPEED_MPS)`. Summary: `meanSpeedMps`. (Segments dead time; the complement is active.)

Each event: `{type, fromTs, toTs, confidence, …one summary scalar}` (§2.3). **All durations/gaps use real ts
deltas** and the `SECONDS_EPS` boundary tolerance (mirror `history.ts`, so an exact N-bucket boundary counts
deterministically despite float drift).

### §1.4 Threshold sourcing (the spec gap, surfaced)
`metric-definitions.md` defines **individual** thresholds only; it has **no collective/tactical thresholds**.
So:
- The **speed** inputs reuse spec-grounded, session-resolved cuts: `hsrMps`/`sprintMps` from
  `thresholdsForSession(sessionId)` (ADR-0019, §3.2), and the walking floor `0.4 m/s` (§2.1) underpins
  `STOPPAGE_SPEED_MPS`. These are NOT invented.
- The **structural** params (`HIGH_TEMPO_FRACTION`, `*_MIN_S`, `TRANSITION_M`, windows, `STOPPAGE_*`) are
  **new, proposed heuristics** with documented defaults, **env-tunable**, and flagged everywhere as
  "unvalidated on real match data." They are explicitly **not** presented as measurement truth (§0.5).

### §1.5 Constants (events.ts — one place)
```
EVENTS_MAX_SPAN_MS         = 6h (21_600_000)// < history's 24h: matches cover well under 6h; smaller scan ceiling
EVENTS_SCAN_CHUNK          = 1000           // == history; ~1–2 ms sync hold/page, yield between pages
MAX_BUCKETS                = 5000           // bounds the returned series
MIN_BUCKET_MS              = 1000           // adaptive-bucket floor
EVENTS_MAX_PLAYERS_PER_BUCKET = 64          // PM-2: == ROSTER cap; bounds per-bucket O(k²) spread/hull to ≤4096 ops
EVENTS_RATE_BURST          = 20             // per-principal token bucket capacity
EVENTS_RATE_PER_MIN        = 40             // …refill/min
SECONDS_EPS                = 1e-6
MIN_PLAYERS_FOR_HULL       = 3
MIN_PLAYERS_FOR_EVENTS     = 3              // PM-6: detectors ignore buckets below this count (thin-data fabrication guard)
// --- proposed heuristics (NOT spec; env-tunable; unvalidated) ---
HIGH_TEMPO_FRACTION        = 0.30
HIGH_TEMPO_MIN_S           = 3.0
TRANSITION_M               = 20
TRANSITION_WINDOW_S        = 5.0
TRANSITION_MIN_MEAN_MPS    = 2.0
STOPPAGE_SPEED_MPS         = 0.5
STOPPAGE_CENTROID_MAX_M    = 5
STOPPAGE_MIN_S             = 8.0
```
The **off-loop inflight cap is SHARED with `/history`** (PM-1): a single global `scanLoad` counter
(`OFFLOOP_MAX_INFLIGHT = 3`) covers history + events combined — NOT an additive per-surface cap — so the
documented "N× interleaved synchronous steps" loop-protection bound is actually true. Per-principal **rate**
buckets stay per-surface. `events.ts` and `history.ts` both acquire/release the shared slot.

---

## §2 Wire contract

### §2.1 Endpoint
`GET /sessions/:id/events?from=<ms>&to=<ms>` — principal-authed, session-scoped, **off-loop**. Params: `from`,
`to` finite, `to > from`, `to − from ≤ EVENTS_MAX_SPAN_MS` (else opaque `400 {error:'bad_params'}`). No
`mode`/`player`/`cursor` (single bounded response). `Cache-Control: no-store`. Reuses `sessionGetGate` (§0.4).

### §2.2 `TeamShapeBucket`
```ts
{ ts:number; count:number; centroid:{lat:number;lon:number};
  stretchM:number; surfaceAreaM2:number; spreadM:number; meanSpeedMps:number; hsrFraction:number }
```

### §2.3 `TacticalEvent`
```ts
{ type:'high_tempo'|'transition'|'stoppage'; fromTs:number; toTs:number; confidence:number;
  minCount:number;                 // PM-6: min player-count over the run's buckets — a data-quality signal
  peakHsrFraction?:number; centroidShiftM?:number; meanSpeedMps?:number }
```

### §2.4 `EventsResult` (the response body)
```ts
{ sessionId:string; from:number; to:number; scannedRows:number; bucketMs:number;
  ageBand:AgeBand; thresholds:{hsrMps:number;sprintMps:number};   // speed provenance (§0.5)
  detectorParams:{                 // PM-S6: the resolved STRUCTURAL params the events were scored against
    highTempoFraction:number; highTempoMinS:number;
    transitionM:number; transitionWindowS:number; transitionMinMeanMps:number;
    stoppageSpeedMps:number; stoppageCentroidMaxM:number; stoppageMinS:number;
    minPlayersForEvents:number };  // env-tunable + UNVALIDATED — UI labels them "proposed" (§0.5)
  series:TeamShapeBucket[];   // ≤ MAX_BUCKETS, ascending ts
  events:TacticalEvent[] }    // ascending fromTs
```
**No `playerId`, no `displayName`, no device internals anywhere.** Empty window → `series:[]`, `events:[]`
(the client renders an explicit "no data," never a silent blank — fail closed).

---

## §3 Implementation map (strict disjoint-file ownership — repo is NOT git)

| File | Owner slice | Change |
|---|---|---|
| `server/src/scanLoad.ts` | integration (me, NEW) | PM-1: the SHARED global off-loop-scan inflight counter (`acquireScanSlot`/`releaseScanSlot`, `OFFLOOP_MAX_INFLIGHT=3`) used by BOTH history + events |
| `server/src/history.ts` | integration (me) | PM-1: replace its private `historyInflight` with the shared `scanLoad` slot (rate bucket stays local) |
| `server/src/events.ts` | **server-core (NEW)** | the off-loop module: validate → paged bucketed scan (final-bucket flush, per-bucket player cap) → detectors → `EventsResult`; `eventsGate` (per-principal rate + shared inflight slot) |
| `server/src/types.ts` | integration (me) | add `TeamShapeBucket`, `TacticalEvent`, `EventsResult`, `TacticalEventType` |
| `server/src/metrics.ts` | integration (me) | add `eventsRequests`, `eventsReadSeconds`, `eventsRowsScanned` (`ft_events_*`) |
| `server/src/server.ts` | integration (me) | add `GET /sessions/:id/events` route (clone the history handler) |
| `server/test/events.ts` | **tests (NEW)** | module correctness: bucketing, geometry, each detector with hand-computed fixtures, Σ/bound invariants, params/DoS |
| `server/test/events-e2e.ts` | **tests (NEW)** | endpoint authz matrix (no id oracle) + no-store + opaque 400 + **off-loop SLO over ≥270k rows** + no-name-in-metrics/logs |
| `client/src/types.ts` | **client (NEW types)** | mirror `TeamShapeBucket`/`TacticalEvent`/`EventsResult` |
| `client/src/useEvents.ts` | **client (NEW)** | fetch hook (fail-closed loading/error/empty/ok; abort/stale guard; `credentials:'same-origin'`; no echoed params). PM-S5: holds the result in React state/refs **only** — NEVER localStorage/sessionStorage/IndexedDB (the centroid series is team-mean child location; must not survive logout, matching `no-store`) |
| `client/src/EventTimeline.tsx` | **client (NEW)** | the timeline panel (event chips + a compact team-shape sparkline), all honestly labelled |
| `client/src/ReviewView.tsx` | integration (me) | mount `EventTimeline` under the aggregate section |
| docs | integration (me) | ADR-0020, this contract, observability.md, README, improvement-plan, memory |

§3.3 DoS controls (events.ts): per-principal token bucket (`EVENTS_RATE_BURST`/`EVENTS_RATE_PER_MIN`,
keyed on principal username or anon-IP) **then** a global inflight cap (`EVENTS_MAX_INFLIGHT` → 503 busy),
exactly mirroring `historyGate`. Independent of history's caps (a separate surface) but the same shape.

---

## §4 Verification (all green, via the simulator — no hardware)
- **Server:** `bunx tsc --noEmit` + `bun run test/events.ts` (correctness/fixtures/invariants) +
  `bun run test/events-e2e.ts` (endpoint + **SLO**) + the full existing suite (regression).
- **Client:** `bun run typecheck` + `bun run lint` + `bun test` (unit: detector/timeline helpers) +
  `bun run e2e --project=review` (the events panel renders; fail-closed states).

## §5 SLO (the gate, mirrors ADR-0017)
Over a pre-seeded DB ≥ 270k rows, a concurrent `GET /sessions/:id/events` aggregate scan must **not** freeze
live WS fan-out: `ft_ws_messages_sent_total` must rise in every 100 ms interval during the scan. A naive
blocking read flatlines it. The bucketed scan is a **new scan shape** → this is proven independently.

---

## §6 Invariants the reviews check
1. No name/playerId in any events payload, log, or metric label; opaque errors never echo input.
2. Detection never touches the live ingest/fan-out path (review-only).
3. Off-loop SLO holds for the bucketed scan over ≥270k rows.
4. Output series bounded (≤ MAX_BUCKETS) for any span; scan bounded by the span cap.
5. Events carry confidence + threshold/ageBand provenance and are labelled movement-derived (never ground truth).
6. Speed cuts come from `thresholdsForSession` (spec); structural params are flagged proposed heuristics.
7. Authz reuses `sessionGetGate` verbatim (no id oracle); per-principal rate + inflight cap + no-store.

## §N Disposition (pre-mortem + post-build fixes)

**Pre-mortem (2026-06-16, 5 lenses): 6 must-fix + 7 should + 3 nit. All folded before code.**

| ID | Sev | Fix folded |
|---|---|---|
| PM-1 | must | **Shared off-loop inflight cap.** Two independent caps (history 3 + events 2) → real worst case 5 concurrent scans on one loop. → a single global `scanLoad` counter (`OFFLOOP_MAX_INFLIGHT=3`) shared by both; per-principal rate buckets stay per-surface. New `scanLoad.ts`; `history.ts` refactored to use it. e2e asserts a 3rd concurrent scan → 503 and fan-out still rises. |
| PM-2 | must | **Per-bucket player cap.** O(k²) spread + hull assume k≤64, but the DB read path enforces no distinct-player cap. → `EVENTS_MAX_PLAYERS_PER_BUCKET=64`; once a bucket's player map is full, a *new* playerId is dropped (counted). k≤64 ⇒ ≤4096 sync ops/bucket. |
| PM-3 | must | **Final-bucket flush.** Close-on-index-advance never closes the last bucket. → after the paged scan, flush the open bucket into `series` before detectors (history `flushSprint` analogue). |
| PM-4 | must | **Run-duration formula pinned.** `durationS = qualifyingBucketCount · bucketMs / 1000`, compared `≥ MIN_S − SECONDS_EPS`; plus the `≥2 buckets` floor. Fixture: exactly 3×1 s qualifying buckets → high_tempo fires (3.0 s). |
| PM-5 | must | **Runs break across data gaps.** Empty buckets are skipped, so series entries can be non-contiguous. → a high_tempo/stoppage run terminates when the next emitted bucket's index is **not** `prevIdx+1` (a skipped/empty bucket closes the run); stoppage's per-step centroid movement is only evaluated between consecutive-index buckets. No event ever spans a data hole. |
| PM-6 | must | **Min-participation gate.** Detectors ignore buckets with `count < MIN_PLAYERS_FOR_EVENTS (3)` (a run must be ≥2 buckets all meeting the floor), so a single dropped-out child's track can't fabricate a max-confidence team event. `TacticalEvent.minCount` carries the run's min count; the UI shows it. Sub-floor buckets are series-only (data-quality signal). |
| PM-S1 | should | All-rows-same-ms → one bucket; mitigated by PM-3 (flush) + PM-2 (cap). Degenerate fixture (all rows same ms, k at cap) added to the SLO test. |
| PM-S2 | should | **Hull degeneracy.** After monotone-chain, if the dedup'd hull has `<3` vertices (collinear/coincident) → `surfaceAreaM2=0`. Fixtures: 3 collinear, 3 coincident → 0. |
| PM-S3 | should | **Shoelace abs.** `surfaceAreaM2 = |shoelace(hull)| / 2` (winding-independent, never negative). |
| PM-S4 | should | **Transition min-duration.** Displacement must accrue over `≥2` consecutive bucket STEPS (≥3 buckets in the window) — the stronger of the two options the finding offered — so a single noisy 1-step centroid jump can never emit. |
| PM-S5 | should | **useEvents in-memory only** — never localStorage/sessionStorage/IndexedDB (centroid is child-derived location; must not outlive logout). Folded into §3 + §0.2. |
| PM-S6 | should | **Ship `detectorParams`.** The result now carries the resolved structural params (§2.4) so two deployments with different env tuning are distinguishable/auditable/reproducible; e2e asserts presence; UI labels them "proposed." |
| PM-S7 | should | **Stoppage over-claim.** Gated by PM-6's count floor; §1.3 wording softened to "segments low-movement time over reporting players" (not an absolute team-dead-time claim). |
| PM-N1 | nit | §0.6 note: per-page sync work = `EVENTS_SCAN_CHUNK` rows + (buckets-closed-per-page × O(cap²)) geometry, both bounded ⇒ the between-pages yield keeps the per-page hold within the history ~1–2 ms budget. |
| PM-N2 | nit | **null spd.** Stored rows always have a real `spd` (ingest guarantees it); the code coerces `null→0` explicitly (history `foldRow` convention) — a null counts as 0 in the mean and below HSR. |
| PM-N3 | nit | **Audit line pinned:** `{username, session, from, to, scannedRows}` only — NO playerId branch (no player dimension on this surface), mirroring history's username+counts-never-a-value pattern. |

**Post-build review (2026-06-16, 4 lenses + adversarial verify): 3 confirmed (1 must + 2 should) + 5 nits —
ALL test-coverage / env-hardening gaps, ZERO feature-code bugs (the implementation verified correct). Folded:**

| ID | Sev | Fix folded |
|---|---|---|
| PB-1 | must | **PM-1 shared cap had no cross-surface test** — `events-e2e` (events-only concurrency) would pass even with a private events counter (the exact pre-PM-1 bug). → new `test/scan-load.ts`: with `OFFLOOP_MAX_INFLIGHT=2`, `eventsGate` ×2 then `historyGate` → `busy`, and the reverse direction; asserts the COMBINED `_scanInflight()`. |
| PB-2 | should | **PM-S5 (useEvents never persists the centroid series) was prose-only.** → `review.spec.ts` now scrapes `localStorage`+`sessionStorage` (the `live.spec.ts` roster-name pattern) and asserts no events payload persisted, plus no player identifier in the rendered DOM. |
| PB-3 | should | **Stoppage 8.0 s duration boundary unpinned** (the 9-vs-7 bucket gap skipped the threshold). → `test/events.ts` now pins exactly-8-buckets → fires / exactly-7 → no-fire, exercising the `>= MIN − EPS` comparator at the boundary. |
| PB-N1 | nit | **NaN env footgun**: a non-numeric `EVENTS_MAX_SPAN_MS`/`MAX_BUCKETS` silently voids the scan ceiling / output bound. → env parsing hardened with `Number.isFinite` fallbacks (a security bound on a children's-location surface). |
| PB-N2 | nit | `events-e2e` now asserts `no-store` on the 403/400/503 paths too (not just 401/200). |
| PB-N3 | nit | `events-e2e` now also asserts no-cookie + a VALID id → 401 (proves the no-id-oracle from both sides). |
| PB-N4 | nit | `review.spec.ts` adds the no-identifier-in-DOM assertion (the team-aggregate guarantee, checked on the render not just the server body). |
| PB-N5 | nit | `events-e2e` metrics guard now asserts `ft_events_*` lines carry no `session=`/`player=` label (tests the real control, not absent needles). |
