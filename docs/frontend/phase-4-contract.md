---
name: phase-4-contract
description: "Frozen build contract for FE Phase 4 — coaching polish: age-banded speed zones (live colour + review breakdown), live distance/min, isolated-player cue, server-side sprint/accel-decel aggregates. Per-session age band via a server config store (ADR-0019)."
status: frozen
created: 2026-06-15T16:40:57Z
updated: 2026-06-15T16:57:13Z
---

# Phase 4 — coaching polish · FROZEN BUILD CONTRACT

**Status:** FROZEN 2026-06-15 (pre-mortem folds into §9). **Drivers:** security #1 → performance #2 → cost #3.
Implements [ADR-0019](../decisions/0019-age-banded-zones-session-config.md) within the youth-football domain
spec [metric-definitions.md](../requirements/metric-definitions.md). The last phase of
[improvement-plan.md](improvement-plan.md). Source of truth the parallel build agents code against.

## §0 — Scope + standing invariants
**In scope (GPS-derivable coaching, per the plan):** age-banded speed-zone **colouring** + **distance/min**
live; an **isolated-player** cue live; **post-match aggregates** server-side (review-only): per-zone distance
breakdown, **sprint** efforts (count/distance/max), **accel/decel** effort counts. Per-session age band via a
server config store (ADR-0019).
**Explicitly DEFERRED (not Phase 4):** IMU PlayerLoad (§5.1, no hardware), metabolic power / HMLD (§5.2), sRPE
(§5.3), ACWR / monotony (§6, cross-session), individualized MSS/MAS thresholds (§3.3). Do not build these.

Inherited invariants (unchanged from Phase 1–3, NON-NEGOTIABLE):
1. **No child name** in the telemetry DB, any history row, any Prometheus label/HELP, any log line, or any
   client persistence. The age band + thresholds are NOT names/location → not sensitive, but their config
   endpoint still uses the session-scoped authz posture for uniformity.
2. **Load metrics stay OFF the live path.** Sprint/accel/decel counts are computed server-side, review-only
   (§3/plan). Live carries only: zone colour, distance + distance/min, the isolated cue. (Distance/min is a
   volume metric, allowed live; it is a best-effort live glance — see §3.)
3. **One Bun event loop.** The aggregate extension folds into the EXISTING paged history scan (§3.1 Phase-3) —
   no new scan, no new synchronous hold; the per-player effort state machines are O(1) per row.
4. **Reuse, don't drift.** Reuse the roster store pattern for the config store; the Phase-3 GET authz gate
   (`sessionGetGate`) for the config + (extended) history routes; the homography/rAF/`useRef`-Map render model.
5. **Firmware is owned elsewhere — do NOT touch `firmware/src/main.cpp`.** No firmware change is needed.

## §1 — Domain constants (from metric-definitions.md — single source of truth, do NOT invent)
- **Bands:** `U12 | U14 | U16 | U19`. Default when a session is unconfigured: **U14** (documented).
- **Zones (m/s), zones 1–3 fixed, HSR+Sprint per band (§3.1/§3.2):**
  - Z1 Walking `[0, 2.0)`, Z2 Jogging `[2.0, 4.0)`, Z3 Running `[4.0, HSR)`, Z4 HSR `[HSR, Sprint)`, Z5 Sprint `[Sprint, ∞)`.
    Half-open intervals: a speed EXACTLY at a threshold lands in the HIGHER zone. Implement as a descending
    `>=` cascade (`v≥sprint→5; v≥hsr→4; v≥run→3; v≥jog→2; else 1`) — client `speedZone` and the server zone
    breakdown MUST use this identical cascade so live colour and review breakdown never disagree at a boundary.
  - HSR/Sprint thresholds (m/s): U12 `4.44 / 5.28`, U14 `4.86 / 5.83`, U16 `5.28 / 6.39`, U19 `5.50 / 6.94`.
- **Distance gating (§2.1):** accumulate a per-segment distance ONLY when `v ≥ 0.4 m/s` (walking floor) AND
  `fix ≥ 2` AND `pdop ≤ 5`; else the segment contributes 0 (GNSS jitter otherwise manufactures phantom distance).
  This gate applies to the base `distanceM`, every `zoneDistanceM` bin, AND `sprintDistanceM` — all from the SAME
  filtered base. **Server reality:** every STORED row already has `fix ≥ 2` (ingest drops `fix<2` before persist),
  so the server gate reduces to `v≥0.4 AND pdop≤5` — but `pdop` is NOT in `FixRow`/the read SELECT today and MUST
  be added (see §4.1). Client: `Telemetry` already carries `fix`+`pdop`, so the live accumulator applies all three
  — the live and server gates are therefore EQUIVALENT (a hard requirement: the two distances must not disagree).
- **Sprint = an effort (§3.4):** count one when `v` ≥ the band's Sprint threshold for **≥ 1.0 s** (≥10 samples),
  and efforts are separated by a **≥ 1.0 s** dip below threshold (else one effort). Report count, distance
  (accumulated while above threshold), max speed. (Stricter entry-accel variant: NOT in scope.)
- **Accel/decel efforts (§4):** on **smoothed** `v` — a **trailing causal** 5-sample moving average
  `ṽ_i = mean(v_{i-4..i})` (a *centred* filter needs 2-sample lookahead the forward-only keyset scan cannot
  provide; the trailing average is the standard GPS-streaming substitute, ~0.2 s lag) — then `a = Δṽ/Δt` using
  the REAL `Δt = (serverTs_i − serverTs_{i-1})/1000` (variable; fixes drop), clamp `|a| ≤ 8`. Bands: Moderate
  `|a| ≥ 2.0`, High `|a| ≥ 3.0` m/s². An effort counts when `a` crosses the band and is **sustained ≥ 0.3 s**
  (≥3 samples); efforts within 0.3 s merge. Count per band, per direction (accel vs decel). GPS-derived →
  label as a trend estimate, not lab-grade. The per-player velocity ring + effort state live in the player's
  `Acc` (keyed by playerId), so the global interleaved scan order never mixes one player's samples into another's.

## §2 — Session-config store (age band) — server
### §2.1 `server/src/sessionConfig.ts` (NEW) — modelled EXACTLY on `roster.ts`
- File `SESSION_CONFIG_FILE` (default `./session-config.json`), shape:
  `{ "sessions": { "<sessionId>": { "ageBand": "U14" } } }`. CLI writes 0o600.
- `loadSessionConfig(file?): Promise<Map<string, AgeBand>>` — async fail-closed: missing→empty (default band
  applies); size > cap (1_000_000)→empty WARN; malformed/no `sessions`→empty WARN (content-free error, no file
  snippet — though this file has no names, keep the roster-loader hygiene); per-entry: `ageBand` must be one of
  the 4 bands else drop that entry WARN. Periodic reload (`SESSION_CONFIG_RELOAD_SECONDS`, default 15, re-entrancy
  guarded), `initSessionConfig()` awaited by server.ts before serving.
- `ageBandFor(sessionId): AgeBand` — configured band or the **U14 default** (so zones always resolve).
- `thresholdsFor(band): { jogMps:2.0, runMps:4.0, hsrMps:number, sprintMps:number }` — the §1 table (the ONE
  place the band→threshold mapping lives server-side). `thresholdsForSession(id) = thresholdsFor(ageBandFor(id))`.
- The band→threshold table is shared with the client ONLY via the API (§2.3) — the client never re-implements it.
### §2.2 CLI `server/roster-user.ts`-style — `server/src/sessionConfig.ts` + `server/session-config.ts` CLI (NEW)
- `set <sessionId> <ageBand>` (validate band ∈ the 4), `remove <sessionId>`, `list`. 0o600. Mirror `roster-user.ts`.
  package.json script `config`. (Age band is not a name → CLI may print it freely; no value-redaction needed.)
### §2.3 Endpoint — `GET /sessions/:id/config` (server.ts, integrator)
- Authz: the EXISTING `sessionGetGate` (Origin-lenient → currentPrincipal → validSessionId → authorizedFor),
  same as `/roster`. Body: `{ sessionId, ageBand, thresholds: { jogMps, runMps, hsrMps, sprintMps } }`.
- **No `Cache-Control: no-store` and no rate-limit needed** (not name/location data; it's a tiny static config)
  — but it IS session-scoped + authed for uniformity. metric: `ft_config_requests_total{result}` (bounded labels).
  On a gate rejection, `log.warn('config rejected', {reason, session, username})` (mirrors the roster handler;
  no success-audit needed — the band is not sensitive). The age band carries no name/location, so no name-leak risk.

## §3 — Live path (client) — zone colour, distance/min, isolated cue
### §3.1 Shared spine (integrator-owned, edited first)
- `client/src/types.ts`: `AgeBand`; `ZoneThresholds { jogMps, runMps, hsrMps, sprintMps }`; `SessionConfig
  { ageBand, thresholds }`.
- `client/src/zones.ts` (NEW): pure `speedZone(v, t: ZoneThresholds): 1|2|3|4|5` + `ZONE_LABEL`/`ZONE_COLOR`
  (5 distinct, colour-blind-safe-ish, by shape+text not colour alone in the mirror). NO thresholds table here —
  thresholds come from the server config; this module only classifies a speed against given thresholds + names zones.
- `client/src/config.ts`: `ISOLATION_M` (default 15) + `ISOLATION_MS` (sustained, default 3000) for the cue.
### §3.2 `client/src/useSessionConfig.ts` (NEW) — mirror `useRoster`
- `useSessionConfig(sessionId): SessionConfig | null` — fetch `GET /sessions/:id/config` (`credentials:'same-origin'`,
  AbortController + reset-on-session-change, exactly like `useRoster`). null until first load; the caller falls
  back to **U14 default thresholds client-side** only while null (zones still render — graceful degradation).
  Never persisted. **Transient-failure retention:** keep the last successfully-fetched config for THIS session
  in a ref and return it on a later non-abort fetch error, so a configured session that has a network blip keeps
  its real band rather than silently snapping live zones to U14 while review still uses the real band (provenance
  gap). On session CHANGE the ref resets first (no cross-session bleed, mirroring the roster guard).
### §3.3 `client/src/useLiveTelemetry.ts` (EDIT) — per-player live distance accumulator
- Add a third bounded ref `dist: Map<playerId, { distM, firstTs, lastLat, lastLon, lastTs }>`, updated on each
  ACCEPTED fix in `upsert`: add `haversine(last, cur)` only if the §1 gating holds (v≥0.4, fix≥2, pdop≤5) and the
  serverTs advanced. Bound + GC + **clear on session change** exactly like `store`/`health`. Return `dist` on the
  `LiveTelemetry` contract. (Best-effort live glance: a reconnect/eviction resets a player's running distance —
  acceptable; the authoritative distance is the server review aggregate. Document this.)
### §3.4 Render (integrator-owned, serialise last)
- `PitchCanvas.tsx`: colour the dot (or its speed readout) by `speedZone(spd, thresholds)`; draw an **isolated**
  cue (a distinct dashed ring) when a fresh player's nearest fresh teammate is > `ISOLATION_M` for ≥ `ISOLATION_MS`
  (O(n²) over ≤MAX_TRACKED — fine). Thresholds come from a prop (the fetched config, mirrored into a ref like roster).
  Keep the hot loop allocation-free.
- `A11yMirror.tsx`: add **Zone** (word: walk/jog/run/HSR/sprint), **Distance (m)**, **Dist/min** columns; isolated
  flagged by word, not colour alone. Distance/dist-min read from the `dist` ref; zone from `speedZone`.
- `App.tsx`/`LiveView`: call `useSessionConfig(session)`, pass `config?.thresholds ?? defaultThresholds` + `dist`
  down to canvas + mirror (alongside `roster`/`health`). Pass thresholds to `ReviewView` too.

## §4 — Review path (server aggregates) — zone breakdown + sprint + accel/decel
### §4.1 `server/src/history.ts` + `server/src/db.ts` (EDIT — extend the EXISTING aggregate scan; no new scan)
**One new read column (`db.ts`):** add `pdop: number | null` to `FixRow` and the `readFixesPage` SELECT (it is
already a stored column; its omission was scoped to the raw-replay surface, not analytics). `fix` is NOT added —
ingest drops `fix<2` before persisting, so every stored row already satisfies `fix ≥ 2`. The heatmap (2nd) pass
is unchanged. Effort detection needs only `server_ts, spd, lat, lon` (already scanned) + this `pdop` for the gate.

**Fix the pre-existing ungated distance FIRST:** the current `foldRow` adds `stepMetres(...)` to `distanceM`
UNCONDITIONALLY — no gate — so `distanceM` (and thus the Phase-3 aggregate + the new `distancePerMin`) inflates
with GNSS jitter while a player stands still. Apply the §1 gate to the base `distanceM` too, computing ONE gated
`step` per row reused by both `distanceM` and the zone bin (so `distancePerMin` and `Σ zoneDistanceM` agree).

Extend the per-player `Acc` + `foldRow` (rows arrive ordered by `(server_ts,rowid)`, so per-player order holds):
- **gated step:** `step = (prev set AND r.spd≥0.4 AND (r.pdop==null||r.pdop≤5)) ? stepMetres(prev,cur) : 0`.
  Add `step` to `distanceM` AND to `zoneDistanceM[zone(r.spd)]` (zone via the §1 `>=` cascade with
  `thresholdsForSession(sessionId)`).
- **sprint efforts** (per-player state machine, §3.4): track a run of consecutive samples with `spd ≥ Sprint`;
  accumulate its above-threshold duration (sum of `Δt`) + distance + max speed; close the run when `spd` drops
  below Sprint, and count it as a sprint IFF its duration ≥ 1.0 s (a sub-threshold sample is the ≥1.0 s separator).
  **Scan-end flush (REQUIRED, post-loop):** after the scan, iterate every `Acc` and flush an in-progress run whose
  accumulated duration ≥ 1.0 s (a player sprinting through the window's end). Report `sprintCount`,
  `sprintDistanceM`, `maxSprintSpeedMps`.
- **accel/decel efforts** (§4): per-player **trailing** velocity ring (≤5) in the `Acc` (NOT centred — see §1),
  smoothed `ṽ = mean(last≤5)`, `a = (ṽ−prevṽ)/Δt` with real `Δt`, clamp `|a|≤8`; state machine for ≥0.3 s
  sustained band crossings, merge within 0.3 s; counts `{accelMod, accelHigh, decelMod, decelHigh}`.
- `distancePerMin = distanceM / max(1, (lastTs-firstTs)/60000)` — over the gated `distanceM`.
- Per-player response gains: `zoneDistanceM:number[5]`, `sprint:{count,distanceM,maxSpeedMps}`,
  `effort:{accelMod,accelHigh,decelMod,decelHigh}`, `distancePerMin`. Top-level gains `ageBand` (provenance, from
  `ageBandFor`). **NO names** anywhere. NB the module test `test/history.ts` distance assertion changes once the
  gate lands (seed rows below 0.4 m/s no longer count) — update it with the gate.
### §4.2 Client review display — `ReviewView.tsx` (integrator)
- Per-player aggregate row gains: a small **zone-breakdown** bar (5 segments, `ZONE_COLOR`, % of distance), the
  **sprint** count/distance/max, **accel/decel** counts (labelled "GPS estimate"), and **dist/min**. Names via the
  roster join (render-only, unchanged). Show the `ageBand` provenance in the panel header.
- The client `AggregatePlayer`/`AggregateResult` types (`useHistory.ts`) MUST gain the new fields as **OPTIONAL**
  (`zoneDistanceM?`, `sprint?`, `effort?`, `distancePerMin?`, top-level `ageBand?`) so the UI degrades gracefully
  against a pre-Phase-4 server response, and `ReviewView` renders each new cell only when present.

## §5 — Wire/type contracts (binding shapes)
| Surface | Shape |
|---|---|
| `GET /sessions/:id/config` | `{ sessionId, ageBand, thresholds:{jogMps,runMps,hsrMps,sprintMps} }` |
| history aggregate per-player (extended) | `…prev fields…, zoneDistanceM:number[5], sprint:{count,distanceM,maxSpeedMps}, effort:{accelMod,accelHigh,decelMod,decelHigh}, distancePerMin` |
| history aggregate top-level (extended) | `…prev fields…, ageBand` |
| session-config file at rest | `{sessions:{<id>:{ageBand}}}`, 0o600 |
| `LiveTelemetry` (extended) | `…store, health…, dist: RefObject<Map<string, LiveDist>>` |
`AgeBand`/`ZoneThresholds`/`SessionConfig` defined once in `server/src/types.ts` and mirrored in
`client/src/types.ts` (the established mirror convention).

## §6 — File-ownership map (disjoint; repo is NOT git → strict no-overlap for parallel agents)
Server: **A-config** = `sessionConfig.ts`(new) + `session-config.ts` CLI(new) + tests `session-config-loader.ts`/
`session-config-cli.ts`(new). **B-aggregates** = `history.ts`(edit: Acc/foldRow + zone/sprint/effort) + test
`history.ts`(extend) / new `history-metrics.ts` test. **Integrator-serialised:** `server/src/types.ts`,
`server/src/server.ts` (the `/config` route), `metrics.ts`, `package.json`, `server/test/config-e2e.ts`,
`server/test/simulate.ts` (write a dev session-config), `server/test/history-e2e.ts` (assert new aggregate fields).
Client: **spine (integrator first)** `client/src/types.ts`, `zones.ts`(new), `config.ts`. **C-live** =
`useSessionConfig.ts`(new) + `useLiveTelemetry.ts`(edit: dist). **Integrator-serialised:** `PitchCanvas.tsx`,
`A11yMirror.tsx`, `App.tsx`, `ReviewView.tsx`, `client/src/zones.test.ts`(new unit), `e2e/live.spec.ts` +
`e2e/review.spec.ts`(extend).
Build order: spine (server+client) → frozen → fan out disjoint slices (A-config, B-aggregates, C-live + their
tests) in parallel → integrator serialises shared files → verify → post-build security/correctness review.

## §7 — Acceptance / definition of done
- `tsc`+lint clean (server+client); all server tests + client units green; Playwright live+review green.
- Zone colouring uses the SESSION'S band (config endpoint), live and review agree; an unconfigured session
  defaults to U14 and still renders. Sprint/accel/decel appear ONLY in review, never on the live wire.
- A known recorded run yields expected zone-distance / sprint-count / accel-count (correctness test).
- Name-leak guard still holds (no name in config/aggregate responses, labels, logs).
- ADR-0019 Accepted→Implemented; improvement-plan Phase 4 shipped; observability gains the config metric;
  metric-definitions cross-checked (no invented thresholds).

## §8 — Pre-mortem inputs (the adversarial pass must answer before code)
1. Effort state machines: off-by-one / boundary correctness (exactly-1.0 s sprint, merging within gaps, scan-end
   flush); do they stay O(1) per row and not stall the loop at max span?
2. Smoothing/accel: real `Δt` from `server_ts` (variable, fixes drop) — does the centred average + clamp avoid
   garbage; is a 5-sample ring correct as rows stream interleaved across players?
3. Distance gating consistency: live (client) vs review (server) use the SAME gate (v≥0.4, fix≥2, pdop≤5) — any
   divergence makes the two distances disagree confusingly.
4. Config endpoint: any way it leaks more than {band,thresholds}? Correct authz reuse? Default-band fallback safe?
5. Live distance accumulator: bounded + cleared on session switch + GC'd; reconnect/eviction reset documented &
   not misread as "player stopped"?
6. Isolated cue: O(n²) bound, the sustained-window state, no false "isolated" for a lone fresh player; perf in the
   hot loop (no per-frame allocation).
7. Any name/PII leak via the new aggregate fields, the config endpoint, or the review display.

## §9 — Pre-mortem disposition (4 lenses, 25 findings; 12 confirmed must/should folded above, 10 refuted, 3 nits)
- **Distance gating is real + the existing aggregate is already wrong** (the biggest cluster — 6 findings):
  `foldRow` currently sums `stepMetres` UNGATED → phantom distance while standing still. Fixed: gate the base
  `distanceM` + every `zoneDistanceM`/`sprintDistanceM` by `v≥0.4 AND pdop≤5` (fix≥2 guaranteed at ingest); add
  `pdop` to `FixRow`+the read SELECT (the "no new columns" claim was wrong); update the `test/history.ts` distance
  assertion. Live + server gates are equivalent (client has fix+pdop on `Telemetry`).
- **"Centred" smoothing is impossible in a forward-only scan** (2 findings): a centred window needs lookahead.
  Switched to a **trailing causal** 5-sample average (the standard GPS-streaming substitute), per-player ring in
  `Acc` keyed by playerId so interleaved rows never mix players.
- **Sprint scan-end flush** (REQUIRED post-loop): an in-progress ≥1.0 s sprint at the window edge must be counted.
- **Client provenance**: `useSessionConfig` retains the last-good config on a transient failure (don't snap a
  configured session's live zones to U14 while review uses the real band).
- **Client aggregate types** gain the new fields as OPTIONAL (graceful degradation vs a pre-Phase-4 server).
- nits folded: zone-boundary `>=` cascade (exactly-at-threshold → higher zone); a config reject-audit log; a
  doc note that the live distance is haversine-on-last-known (best-effort, resets on reconnect — not "stopped").
Refuted (not changed): the deferred metrics stay deferred; the O(n²) isolated cue at ≤64 players (≤4096 cheap
distance calcs/frame) is within budget; the config endpoint needs no no-store/rate-limit (band is not sensitive).

### Post-build review disposition (4 lenses on the SHIPPED code; 7 confirmed fixed, 1 refuted, 6 nits)
The post-build pass caught real metric bugs the unit tests missed, all fixed + regression-tested:
- **Sprint separator (§3.4 cl.3) was not implemented** — a brief sub-threshold dip closed the run, overcounting
  efforts. Rewrote the sprint state machine to mirror `feedBand`: a dip < `SPRINT_MIN_SECONDS` MERGES; only a
  ≥1.0 s dip separates. Tests `SM` (merge→1), `SS2` (separate→2).
- **Sprint duration off-by-one** — the entry interval wasn't counted, so 10 samples measured 0.9 s and the exact
  1.0 s boundary never counted. Fixed (`dur = dt ?? 0` on entry). Test `SB` (10 samples → 1).
- **Float-sum drift** (found while fixing the above): Σ of 0.1 s Δt drifts below 1.0 s, so the exact boundary +
  the gap separator need a `SECONDS_EPS` tolerance on every `≥ MIN_SECONDS` compare (sprint + accel).
- **Stale-player isolation false positive** — `isoSince` wasn't cleared when a player went stale, so recovery
  within `ISOLATION_MS` drew an instant cue. Cleared in the stale branch.
- `readRaw` now yields after a page-aligned final page; the live distance gate constants are shared (named in
  config, matching the server); `useHistory` depends on primitive query fields (not the object) so an
  equal-valued query rebuild can't loop. Nits (per-frame string alloc, `shift()` on a 5-element array, aria
  verbosity) skipped as negligible/pre-existing.
