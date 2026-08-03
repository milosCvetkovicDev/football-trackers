---
name: phase-3-contract
description: "Frozen build contract for FE Phase 3 — roster names (ADR-0016), device-health-on-/live, review/replay (ADR-0017). Wire shapes, endpoints, file-ownership map, security invariants, test plan."
status: frozen
created: 2026-06-15T14:43:19Z
updated: 2026-06-15T15:07:02Z
---

# Phase 3 — identity, health, review · FROZEN BUILD CONTRACT

**Status:** FROZEN 2026-06-15 (adversarial pre-mortem folded in — see §9). **Date:** 2026-06-15.
**Drivers (unchanged):** security #1 (the payload is the live location of minors) → performance #2
(50-player real-time on a sun-throttled tablet) → cost #3 (self-hosted, minimal deps).

Implements the three accepted Phase-3 ADRs:
[ADR-0016 roster/names](../decisions/0016-player-name-roster.md) ·
[ADR-0017 review data source](../decisions/0017-review-replay-data-source.md), within
[ADR-0010 retention/minimisation](../decisions/0010-location-data-retention.md),
[ADR-0008 auth](../decisions/0008-authentication-access-control.md),
[ADR-0015 auth transport](../decisions/0015-frontend-auth-transport.md).

This is the single source of truth the parallel build agents code against. **Freeze before code.**

---

## §0 — Standing invariants (NON-NEGOTIABLE; every workstream inherits these)

1. **NAMES NEVER ENTER THE PSEUDONYMOUS STORES.** No `displayName`/`name` field may appear in:
   the MQTT wire contract, the telemetry DB schema or any row, any `/sessions/:id/history` row,
   **any** Prometheus label or HELP line, **any** structured log line (`log.{info,warn,error}`), or
   any client-side persistence (localStorage/sessionStorage/IndexedDB/Cache). Names exist in exactly two
   places: (a) the access-controlled roster store at rest (§1.1), and (b) coach-screen render + the
   operator's own CLI/console. The `playerId` is pseudonymous and may appear anywhere it already does.
2. **Fail closed.** A missing/malformed roster file → 0 names (ids-only view), never a crash, never names
   from a stale cache. A history read error → an explicit error to the coach, never a partial-silent result.
3. **One Bun event loop.** The MQTT ingest (~100 msg/s, up to ~500 at 50 players) + WS fan-out share the
   loop with every new endpoint. No new synchronous work may block it: history reads page + yield (§3),
   roster reads are async (`node:fs/promises`), the device-health fan-out is O(1) per status frame.
4. **Reuse the Phase-2 authz posture verbatim** for every new HTTP endpoint, in THIS order (matches the
   existing `/auth/me` + `/sessions` GET handlers so an unauthenticated caller learns nothing about a
   session id before authn): Origin allow-list → `currentPrincipal(cookie)` (401 if none) → `validSessionId`
   (400) → `authorizedFor(principal, id)` (403). **Origin policy differs by method:** the GET data reads
   (`/roster`, `/history`) use a **LENIENT** check — a same-origin browser GET via `fetch()` sends NO Origin
   header (browsers omit it on same-origin GET/HEAD), so *absent* Origin is allowed; a *present* Origin must
   be allow-listed (rejects a cross-origin fetch, which is already cookie-less under SameSite=Lax — defense
   in depth). The STRICT "absent → 403" rule stays only on the state-changing POST `/auth/*` and the WS
   upgrade, where browsers DO send Origin. (A strict check on a GET read 403s the real coach UI — caught in
   integration; see §9.) No endpoint is reachable on the loopback metrics port. (CSRF synchronizer token is NOT required on these
   GET routes — they are side-effect-free reads; any future Phase-3 endpoint that mutates state must be a
   POST and require `X-CSRF-Token: principal.csrf` exactly as Phase-2 §3/§4 does.)
7. **Read endpoints are bulk-export surfaces — bound + observe them.** The two new data endpoints
   (`/roster`, names; `/history`, raw children's location) inherit the Phase-2 DoS posture: a per-principal
   token bucket (429), an audit log line per request (success AND reject; pseudonymous fields only), and
   `Cache-Control: no-store` on every response. `/history` additionally gets a concurrent-scan inflight cap
   (503). This bounds — does not eliminate — what a stolen 12h cookie can drain, and makes a drain visible.
5. **Firmware is owned elsewhere — do NOT touch `firmware/src/main.cpp`.** The device already publishes the
   `.../status` topic this phase consumes; no firmware change is needed or permitted here.
6. **Pin, don't drift.** Reuse `validSessionId`, `currentPrincipal`, `authorizedFor`, `originOkStrict`,
   `MAX_TRACKED_PLAYERS`, the homography, the `useRef`-Map + rAF render model. Add; don't rewrite.

---

## §1 — Workstream A: player names (ADR-0016)

### §1.1 Roster store — `server/src/roster.ts` (NEW)
The one place names live at rest. Modelled **exactly** on `auth.ts`'s accounts loader (fail-closed,
async, periodic reload, size-capped) so its security properties carry over.

- **File:** `AUTH_ROSTER_FILE` env (default `./roster.json`). Shape:
  ```json
  { "sessions": { "<sessionId>": [ { "playerId": "07", "displayName": "Alex M." } ] } }
  ```
- **At-rest posture:** the CLI writes it mode `0o600`; at-rest confidentiality is OS full-disk encryption,
  the same defence-in-depth posture as `telemetry.db` (db.ts) and `auth-accounts.json`. Documented, not invented.
- **`loadRoster(file?): Promise<Map<string, Map<string,string>>>`** (sessionId → playerId → displayName):
  - async (`readFile`/`stat` from `node:fs/promises`) — NEVER blocks the loop.
  - size cap `ROSTER_MAX_BYTES` (1_000_000) → over cap = 0 names (fail closed, WARN).
  - missing file → empty map (no warn beyond a one-time info; ids-only is a valid posture).
  - malformed JSON / no `sessions` object → 0 names (fail closed, WARN).
  - per-entry validation: `playerId` matches `SESSION_ID_RE`-style bound (`/^[A-Za-z0-9._-]{1,64}$/`),
    `displayName` is a non-empty string `≤ ROSTER_NAME_MAX` (64) chars; drop bad entries (WARN **without the
    name value** — log the playerId only).
  - per-session player cap `ROSTER_MAX_PLAYERS_PER_SESSION` (64, == `MAX_TRACKED_PLAYERS`): excess dropped (WARN).
  - **duplicate `playerId` within one session → reject that whole session's roster** (ambiguity = privilege/identity
    confusion hazard, mirrors the accounts dup-username rule), 0 names for that session, ERROR (no name value).
  - `file` param is for unit-test fixtures only (mirrors `loadAccounts`).
  - **The loader MUST NOT log any `displayName` value** (invariant §0.1). Counts + playerIds only.
- **`initRoster()`**: load + start a periodic reload (`AUTH_ROSTER_RELOAD_SECONDS`, default 15, re-entrancy
  guarded like `auth.ts.reload`). Awaited by `server.ts` before serving. Emits an info with the session/entry
  COUNT (never names).
- **`rosterFor(sessionId): { playerId: string; displayName: string }[]`**: the endpoint's data source. Returns
  `[]` for an unknown session (a session may legitimately have no roster → ids-only).
- **`purgeRosterPlayer(playerId, sessionId?): number`**: delete a player's roster entry from one session (or all),
  **rewrite the file** mode `0o600`, reload in-memory. Returns entries removed. Used by §1.4 erasure. (Operates on
  the file directly so the running server picks it up on its next reload AND a one-shot CLI run is authoritative.)

### §1.2 Roster endpoint — in `server/src/server.ts` (createApp), helper logic may live in roster.ts
`GET /sessions/:id/roster` on the PUBLIC app (coaches need it; never the loopback metrics app):
- authz (§0.4 order): Origin allow-list (LENIENT — this is a GET read: absent Origin OK for a same-origin
  browser GET, present Origin must be allow-listed; 403 `forbidden_origin`) → `currentPrincipal(cookie)` (401
  `{authenticated:false}`) → `validSessionId(id)` (400 `bad_session`) → `authorizedFor(p, id)`
  (403 `forbidden_session`). **currentPrincipal before validSessionId** so an unauthenticated probe can't
  use 400-vs-401 to learn whether a session id is well-formed.
- **per-principal rate limit:** after authz, a token bucket keyed on `p.username ?? 'anon'` —
  `ROSTER_RATE_BURST` (default 20), refilling `ROSTER_RATE_PER_MIN` (default 30). Excess → 429
  `{error:'rate_limited'}`. Module-level `Map<string,{tokens,last}>` (same shape as `auth.ts` `ipBuckets`),
  swept of entries idle > 2× the window. Buckets are per-principal so one coach can't starve another.
- body on success: `{ sessionId, roster: [{ playerId, displayName }] }` for **that one session only** (never a
  multi-session dump — a wildcard admin still fetches one session per call). `roster: []` is valid.
- **`Cache-Control: no-store`** on EVERY response (success, 4xx, 5xx) — the server-enforced complement of
  §1.5's "never persisted": without it a name-bearing 200 lands in the browser disk cache and survives logout.
- **audit log:** success → `log.info('roster read', { username: p.username, session: id, playerCount })`;
  reject → `log.warn('roster rejected', { reason, session: id, username: p.username ?? null })`. **NO
  displayName, NO playerId value** in either line (counts + pseudonymous ids only — §0.1).
- **identified data:** the response body carries names by design (ADR-0016 "honest scope"), gated by
  auth+origin+session-scope+rate-limit+no-store; it is NEVER logged and NEVER cached beyond client memory.
- metric: `ft_roster_requests_total{result}` where result ∈
  `{ok|rate_limited|unauthorized|forbidden|bad_session|forbidden_origin}`. **No playerId/name/session label**
  — a per-session count would let an unauthenticated `/metrics` scraper enumerate which sessions have coaches.

### §1.3 Provisioning CLI — `server/roster-user.ts` (NEW), `package.json` script `roster`
Modelled on `auth-user.ts`. `AUTH_ROSTER_FILE` env. Writes mode `0o600`.
- `set <sessionId> <playerId> <displayName>` — upsert one entry (validate playerId shape + name length).
  **Validation-error messages MUST NOT interpolate the `displayName` value** (emit `displayName too long
  (max 64 chars)`, never the value) — stderr may be captured by a non-interactive caller (cron, log-shipper),
  which is NOT the operator's interactive console. Printing the name on the SUCCESS path / in `list` is in
  scope (operator console). Mirror `auth-user.ts`, which likewise never echoes the password on failure.
- `remove <sessionId> <playerId>` — exit 0 if removed; clear error + exit 1 if absent; never corrupt the file.
- `list [sessionId]` — print sessionId/playerId/displayName (the operator's OWN console — names are expected here).
- Names on the operator's terminal/CLI are in scope (operator is the data controller). Names in app logs are NOT.

### §1.4 Erasure coupling — `server/purge-player.ts` (EDIT)
After the telemetry-row purge (inside the SAME try/catch, so a roster-write failure surfaces as the existing
exit-3 error receipt — never a silent partial erasure), also call `purgeRosterPlayer(playerId, sessionId)` and
include `rosterEntriesErased` in the JSON receipt. A player absent from the roster → `rosterEntriesErased: 0`
and **still exit 0** (the erasure goal — player not present — is met regardless), matching the DB-purge
0-rows semantics. Update the file-header NOTE (currently "roster store … not built yet").
ADR-0016 + ADR-0010 both list this as owed the moment a roster ships.

### §1.5 Client name resolution — `client/src/useRoster.ts` (NEW) + render-only join
- `useRoster(sessionId): Map<string,string>` (playerId → displayName). Fetches `GET /sessions/:id/roster`
  (`credentials:'same-origin'`) on session select; holds the map in memory (useState). **NEVER persisted**
  (no localStorage/sessionStorage/IndexedDB/Cache — ADR-0016). Empty/failed fetch → empty map → ids-only
  render (no error surfaced; names are an enhancement, not a gate). Re-fetch on sessionId change.
- **Stale-roster guard (§8 Q6 — must never paint session A's name on a session B dot):** the `useEffect`
  (a) synchronously resets the map to empty at the start of the effect body (`setRoster(new Map())`) so the
  new session never renders with old names while the fetch is in flight; and (b) creates an `AbortController`,
  passes `.signal` to `fetch`, and in cleanup calls `controller.abort()` + sets a `disposed` flag so a late
  resolve is a no-op. (The `<LiveView key=session:epoch>` remount already covers the picker path, but this is
  the explicit belt for any future in-place sessionId change — same defensive pattern as `useLiveTelemetry`.)
- The map is passed to `PitchCanvas` + `A11yMirror` (and the review views) as a prop and joined at render:
  `displayName ?? playerId`. **It is NEVER written into the telemetry `store` Map** — the store stays
  pseudonymous; the join is render-only (ADR-0016). The cap-eviction `console.warn` keeps using playerId only.

---

## §2 — Workstream B: device health on `/live`

A second WS envelope so a coach can tell a stationary player from a dropped tracker — battery, GPS, backlog.

### §2.1 Wire contract — minimised `DeviceHealth`
The `.../status` topic already carries the full `DeviceStatus` (types.ts). Fan out a **minimised** subset
(data-minimisation: the coach needs health, not device internals; `/metrics` still has the rest):
```ts
interface DeviceHealth {
  playerId: string;   // pseudonymous — NO name
  sessionId: string;
  serverTs: number;   // server stamp at status receipt (authoritative; device ts is ordering-only)
  battPct: number;    // -1 if unmetered
  battVolts: number;
  rssi: number;       // WiFi dBm — weak-signal vs dead-tracker
  fix: number;        // last GNSS fix type
  sats: number;
  backlogBytes: number; // rising ⇒ device can't reach the broker (the "dropped vs stationary" signal)
}
```
**Dropped from the fan-out:** `heap`, `up`(time), `pub`, `stash` (pure device internals; remain on `/metrics`).
Envelope on the wire: `{ event: 'status', data: DeviceHealth }`. **Best-effort, NOT persisted** (mirrors `DeviceStatus`).

### §2.2 Server — `server/src/ingest.ts` (EDIT `handleStatus` + `IngestDeps`) + `server/src/server.ts` (wire it)
- `IngestDeps` gains `publishStatus(sessionId: string, h: DeviceHealth): void`.
- `handleStatus(session, player, payload, publishStatus)`: after the existing gauge writes, build the minimised
  `DeviceHealth` (stamp `serverTs = Date.now()`), then `publishStatus(session, h)`.
- `server.ts` wires `publishStatus` → `server.publish(wsRoom(session), JSON.stringify({event:'status', data:h}))`
  and `metrics.wsStatusSent.inc({session})`. **Only authorised sockets are subscribed to `wsRoom(session)`** (the
  §0.4 authz already gates the room), so a health envelope only reaches coaches authorised for that session.
- new metric `ft_ws_status_envelopes_sent_total{session}` (counter). Existing `ft_ws_messages_sent_total` keeps its
  "telemetry envelopes" meaning (HELP unchanged). The `{session}` label is intentional here (matches the WS
  fan-out metric convention; WS rooms already require auth to join, so the label leaks nothing a coach with that
  room can't see) — deliberately UNLIKE the roster metric, which carries no session label (§1.2) because that
  endpoint is unauthenticated-scrapeable on /metrics and a per-session count would enumerate staffed sessions.

### §2.3 Client — `validate.ts`, `useLiveTelemetry.ts`, `contracts.ts`, `types.ts`, `A11yMirror.tsx`, `PitchCanvas.tsx`
- `client/src/types.ts`: add the `DeviceHealth` interface (mirror server) + extend the envelope union to
  `{event:'telemetry',data:Telemetry} | {event:'status',data:DeviceHealth}`.
- `client/src/ws/validate.ts`: add `validateDeviceHealth(data): DeviceHealth | null` (strict finite-number +
  bounded-string, same defensive posture as `validateTelemetry`). **It MUST `return` a freshly-constructed object
  literal with exactly the nine known fields — NEVER `return d as DeviceHealth`** — so any stray
  `name`/`displayName` field is structurally stripped, not merely "not read" (the structural guarantee, not
  consumer discipline, is what upholds §0.1 on this path). Add `parseLiveFrame(raw): {kind:'telemetry',
  data:Telemetry} | {kind:'status',data:DeviceHealth} | null`. **Keep `parseTelemetryFrame` exported** (its
  unit test stays green).
- `client/src/useLiveTelemetry.ts`: **replace the `parseTelemetryFrame(ev.data)` call at line 122 with
  `parseLiveFrame(ev.data)`** (leaving the old call in place silently drops every `{event:'status'}` frame —
  the health columns would stay `—` forever) and route on `kind`: `'telemetry'` → existing `upsert`; `'status'`
  → upsert into a second `health = useRef<Map<string, DeviceHealth>>`, bounded by `MAX_TRACKED_PLAYERS` and GC'd
  the same way; `null` → drop. Health for an unknown player is fine (it can arrive before/after a fix). Return
  `health` on the `LiveTelemetry` contract.
- **Cleanup must clear BOTH refs on unmount/sessionId-change:** add `store.current.clear()` AND
  `health.current.clear()` to the effect's cleanup. Telemetry has a `DROP_MS` safety net but `DeviceHealth` has
  **no TTL eviction**, so without the clear, a playerId that collides across sessions shows session A's
  battery/backlog the instant one new health frame arrives. (Belt for any non-remount session change.)
- `client/src/contracts.ts`: `LiveTelemetry` gains `health: RefObject<Map<string, DeviceHealth>>`. Add a small pure
  classifier `deviceHealthLevel(h, now): 'ok'|'warn'|'bad'` (low battery / rising backlog / weak signal / stale
  status) so canvas + mirror agree, by shape+text not colour alone.
- `client/src/A11yMirror.tsx`: add columns — **Name** (`displayName ?? playerId`), **Battery** (`pct%` or volts /
  "—"), **Signal** (rssi dBm bucketed to word + value), **GPS** (`fix`/`sats` → "3D · 11 sats"), **Device**
  (ok/backlog/offline by word). "—" when no health frame yet. Status by word, not colour alone (existing a11y rule).
- `client/src/PitchCanvas.tsx`: render `displayName ?? playerId` as the dot label; add a SMALL health cue (e.g. a
  thin low-battery arc or an "offline/backlog" ring) — keep it cheap (perf #2; the A11yMirror table is the
  authoritative health surface). No per-frame allocation; read `health.current.get(playerId)`.

---

## §3 — Workstream C: review/replay (ADR-0017)

### §3.1 History endpoint — `server/src/history.ts` (NEW) + `server/src/db.ts` (read helpers) + `server/src/server.ts` (route)
`GET /sessions/:id/history` on the PUBLIC app, **same authz posture + order as §0.4** (Origin → currentPrincipal
→ validSessionId → authorizedFor). Then, before any DB work, two DoS gates and a rate limit (below). Query params
(all validated; reject out-of-range with 400):
- `from`, `to` (epoch ms): finite, `to > from`, span ≤ `HISTORY_MAX_SPAN_MS` (default 24h) — bounds the scan.
- `mode`: `aggregate` (default) | `raw`.
- `mode=raw` additionally REQUIRES `player` (one playerId, `validSessionId`-shape charset) and accepts a COMPOSITE
  keyset cursor as **two** params `cursor_ts` (epoch ms) + `cursor_rowid` (int) — both-or-neither (400 if only one)
  — plus `limit` (default 2000, hard max 10000). Returns one page + `nextCursor`. **Never `.all()` a match.**
- **Opaque errors:** every 4xx/5xx body is an error CODE only (`{error:'bad_params'|'rate_limited'|'busy'|…}`) —
  it MUST NOT echo `player`/`from`/`to`/`cursor_*`/`mode` (a misconfigured client could pass a name as `player`;
  never reflect it). Server error logs may carry `{session, mode, err}` but NOT the raw `player` query value.

**DoS + bulk-export controls (children's raw location — the most sensitive read):**
- **inflight cap:** module-level `historyInflight`; if `≥ HISTORY_MAX_INFLIGHT` (default 3) → 503 `{error:'busy'}`
  BEFORE any DB work; else `++`, do work in try/finally, `--` in finally. Mirrors `auth.ts`'s inflight cap; bounds
  worst-case interleaved synchronous scan steps between event-loop yields to 3×.
- **per-principal rate limit:** token bucket keyed `p.username ?? 'anon'`, `HISTORY_RATE_BURST` (default 30) /
  `HISTORY_RATE_PER_MIN` (default 60) → 429 `{error:'rate_limited'}`. 60/min comfortably covers a coach scrubbing
  a long window; it caps tight programmatic iteration. (Chosen over a per-(principal,session) hourly quota — one
  bucket map, easier to reason about; the inflight cap + audit log carry the rest. A tighter quota can layer on later.)
- **audit log:** success → `log.info('history read', { username: p.username, session: id, mode, from, to,
  scannedRows })` (+ `playerId` for raw — pseudonymous, OK per §0.1); reject → `log.warn('history rejected',
  { reason, session: id, username: p.username ?? null })`. `scannedRows` is the bulk-export detection signal.
- **`Cache-Control: no-store`** on EVERY response — raw GPS pages + bboxes are location data; no disk-cache survival.

**Read strategy — off the live loop (chosen: single-threaded keyset paging, ADR-0017 sanctioned).**
Both modes read via a keyset-paged iterator over the existing `idx_telemetry_session_ts` index
(`WHERE session_id=? AND server_ts>=? AND server_ts<? AND (server_ts,rowid) > (?,?)` ordered by
`server_ts,rowid LIMIT chunk`), accumulating in JS and **`await`-yielding between chunks** (`setTimeout(0)`),
like `retention.purgeOlderThan`'s batch loop. Chunk `HISTORY_SCAN_CHUNK` (default **1000**, env-overridable):
sizing arithmetic — at ~500k bun:sqlite rows/s a 10k page holds the loop ~20 ms, but the fan-out interval at
50 players×10 Hz is ~2 ms, so 10k would burst-starve fan-out; **1000 holds ~1–2 ms ≈ the fan-out interval**, at the
cost of ~more chunks (a 90-min 10-player match ≈ 540k rows ≈ 540 chunks ≈ a few seconds wall-time, acceptable for a
background read). The §5 SLO test is the gate; if it fails, drop the chunk further or escalate to the ADR-0017
worker thread — the `history.ts` boundary keeps that swap local. (No separate read-only `Database` handle: one
process, WAL already lets the single connection read concurrently with its own writes; documented in `db.ts`.)

**`mode=aggregate` response** (small, age-appropriate, ADR-0010-aligned default):
```ts
{
  sessionId, from, to, scannedRows,
  players: [{ playerId, fixes, firstTs, lastTs, distanceM, avgSpeedMps, maxSpeedMps,
              bbox: { minLat, minLon, maxLat, maxLon } }],
  heatmap: { cols, rows, bins: number[] }  // occupancy counts, lat/lon grid scaled to the scan's bbox (default 32×20); NO names, NO per-bin playerId
}
```
**`mode=raw` response:** `{ sessionId, playerId, from, to, fixes: [{ serverTs, lat, lon, spd, hdg }],
nextCursor: { serverTs: number, rowid: number } | null }`. `nextCursor` is null on the last page (fewer than
`limit` rows); otherwise it carries the last fix's `(serverTs, rowid)` so the next request resumes UNAMBIGUOUSLY.
**A scalar `serverTs`-only cursor is WRONG** — `server_ts = Date.now()` collides across players at 10 Hz, so a
ts-only resume duplicates or skips the colliding rows. **NO `displayName` in any row or aggregate** — pseudonymous;
the client joins the roster (§1.5) at render.

- db.ts: add `readFixesPage(sessionId, fromTs, toTs, afterTs, afterRowid, limit)` (prepared, composite keyset on
  `(server_ts, rowid)`) + leave the write path untouched. Reads use the existing `db` handle (documented why).
- metrics: `ft_history_read_seconds{mode}` (histogram) + `ft_history_rows_scanned_total{mode}` (counter) +
  `ft_history_requests_total{result}` (result ∈ `{ok|rate_limited|busy|unauthorized|forbidden|bad_session|
  bad_params|forbidden_origin}`). **Label set is `{mode}`/`{result}` ONLY — never a `{session}` or `{player}`
  label** (background op; per-session cardinality adds no SLO value and would enumerate sessions on /metrics).

### §3.2 Client review mode — `client/src/useHistory.ts` (NEW), `client/src/ReviewView.tsx` (NEW), heatmap render
- Mode-aware shell: a **Live ⇄ Review** toggle in `App.tsx`'s `AuthedShell` (only when a session is selected).
  Live mounts `<LiveView>` (unchanged); Review mounts `<ReviewView>`.
- `useHistory(sessionId, {from,to,mode,player?})`: fetch `/sessions/:id/history` (`credentials:'same-origin'`),
  explicit loading/error/empty states (fail closed — an error shows text, never a misleading empty pitch).
- `ReviewView`: a time-window picker (default a sensible recent window), the per-player aggregate table (distance,
  avg/max speed — names via `useRoster`), and the **heatmap overlay rendered on the SAME pitch geometry** as
  `PitchCanvas` (reuse the homography/projector — ADR-0017 "one renderer, two modes"). Raw replay is on-demand:
  pick a player → fetch `mode=raw` pages → a scrubber drives a "virtual now" the canvas renders against. The canvas
  drawing core (homography, dst rect, dot/heatmap draw) is shared, not duplicated.
- Heatmap is occupancy only — no per-cell identity; the aggregate table is identified (names) and must be treated
  as identified data operationally (ADR-0016/0017 honest-scope).

---

## §4 — Consolidated wire / type contracts (the binding shapes)

| Surface | Shape |
|---|---|
| WS telemetry envelope (unchanged) | `{event:'telemetry', data: Telemetry}` |
| WS health envelope (NEW) | `{event:'status', data: DeviceHealth}` (§2.1) |
| `GET /sessions/:id/roster` | `{sessionId, roster:[{playerId, displayName}]}` (§1.2) |
| `GET /sessions/:id/history?mode=aggregate` | aggregates + heatmap (§3.1) — NO names |
| `GET /sessions/:id/history?mode=raw&player=` | paged raw fixes; `nextCursor:{serverTs,rowid}|null`; resume via `?cursor_ts=&cursor_rowid=` (§3.1) — NO names |
| roster file at rest | `{sessions:{<id>:[{playerId,displayName}]}}` (§1.1), 0600 |

`DeviceHealth` is defined once in `server/src/types.ts` and mirrored in `client/src/types.ts` (the existing
RawTelemetry/Telemetry mirroring convention). Terse-vs-enriched split does not apply — health is server-derived.

---

## §5 — Test plan (all hardware-free, via the simulator + Playwright; conventions from existing tests)

Server (plain `.ts`, `assert()` + `process.exit`, run `bun run test/<f>.ts`; add `package.json` scripts):
- `test/roster-loader.ts` — fail-closed `loadRoster`: valid; missing→empty; oversize→empty; malformed→empty;
  bad-name/over-long dropped; dup playerId in a session → that session rejected. **No displayName ever logged —
  verified by capturing `console.error`/stderr during the bad-entry + over-long cases and asserting the name
  value is ABSENT from the captured output** (return-value assertion alone is insufficient — must inspect logs).
- `test/roster-e2e.ts` — live server: `/sessions/:id/roster` authz matrix in §0.4 order (no-cookie → 401 for ANY
  id incl. malformed; bad origin 403; wrong-session 403; bad id 400 *only when authed*; authorised 200 with names);
  **rate-limit** (BURST+N rapid requests from one principal → 429; a second principal unaffected — bucket
  isolation); **`Cache-Control: no-store` on every status code**; **audit log line carries username+session+count
  and NO displayName**; **/metrics + log scrape asserting NO name leak anywhere**.
- `test/roster-cli.ts` — set/remove/list + 0600 + remove-absent doesn't corrupt (mirror `auth-cli.ts`); **`set`
  with a 65-char name exits non-zero and stderr does NOT contain the supplied name string**.
- `test/erasure-e2e.ts` — combined right-to-erasure: `roster-user.ts set` one entry → `purge-player.ts <pl> <sess>`
  → receipt has `rosterEntriesErased:1`, DB rows for the player = 0, entry gone from `roster.json`; a second run
  (nothing left) exits 0 with `rosterEntriesErased:0` and does NOT corrupt the file.
- `test/history.ts` — aggregate correctness (known recorded run → expected fixes/distance/bbox/heatmap sums);
  raw paging (cursor walks the whole window exactly once, no dup/gap) **including a fixture with ≥2 rows sharing
  one `server_ts` to prove the composite `(serverTs,rowid)` cursor neither dups nor skips them**; param validation
  (span cap, to>from, cursor both-or-neither); authz matrix (§0.4 order); rate-limit 429 + inflight 503; opaque
  error bodies (no echoed query value); `Cache-Control: no-store`; **NO name field in any row**.
  **SLO (event-loop non-starvation, must be ABLE to fail):** pre-seed ≥ 270_000 rows for the test session via a
  direct `insertTelemetry()` loop (mirrors `test/retention.ts` seeding; ~few s) — assert the count up front so the
  fixture can't silently regress — THEN, with a 50-player live feed running, issue an aggregate query and poll
  `/metrics`: assert `ft_ws_messages_sent_total` keeps increasing by ≥ ~2% of baseline in every 500 ms window
  throughout the query (i.e. the loop never freezes), and `ft_history_read_seconds{mode="aggregate"}` is present
  afterward. (The old "rate ≠ 0 against 7.5k rows / one chunk" form was vacuous — it could never fail.)
- `test/device-health-e2e.ts` — a status frame published → a `{event:'status'}` envelope arrives on `/live` with
  the minimised fields and **no** `heap`/`up`/`pub`/`stash`/name; gauges still update.
- Extend `test/e2e.ts` /metrics-shape assertions with the new metrics; keep the existing name-absence guard.

Client (`bun run test` for units; Playwright projects for e2e):
- `src/ws/validate.test.ts` (EXTEND) — status-frame validation: valid health accepted as `kind:'status'`; junk
  rejected; **a status frame carrying a `displayName` field → the validated result has NO `displayName`**
  (`(result as any).displayName === undefined`) — the structural-strip regression guard.
- `e2e/review.spec.ts` (NEW Playwright project) — drive review mode off a recorded run (`--record`/`--replay`):
  aggregate table + heatmap render; raw scrub works; names show when a roster is provisioned.
- `e2e/live.spec.ts` (EXTEND) — names render on dots + mirror when a roster exists; **device-health columns
  POPULATE after a status frame** (assert battery/signal/device cells are no longer `—`, not just that a frame
  arrives); ids-only still works with no roster; **rapid A→B session switch never shows a session-A name on a
  session-B dot/cell**; **after names render, `localStorage` + `sessionStorage` contain no roster-name value**
  (`page.evaluate` JSON scrape) — making the never-persist invariant observable, not just declared.
- Simulator (`test/simulate.ts`, EDIT): `--secure` also writes a throwaway `roster.json` for the run session
  (dev names like "Player 01" — NOT real children) and points the server at it; keep `--record`/`--replay` faithful.

---

## §6 — File-ownership map (disjoint; the repo is NOT git → strict no-overlap for parallel agents)

Server (mostly disjoint → parallelisable):
- A-names: `server/src/roster.ts` (new), `server/roster-user.ts` (new), `server/purge-player.ts` (edit),
  `server/test/roster-loader.ts`/`roster-cli.ts` (new).
- C-history: `server/src/history.ts` (new), `server/src/db.ts` (edit: add read helpers only), `server/test/history.ts` (new).
- B-health: `server/src/ingest.ts` (edit `handleStatus`+deps), `server/src/types.ts` (edit: add `DeviceHealth`).
- **Shared, integrator-owned (serialise):** `server/src/server.ts` (roster route + history route + publishStatus
  wiring), `server/src/metrics.ts` (new counters/histogram), `package.json` (scripts). One owner to avoid clobber.

Client (heavily coupled → coordinated, NOT free-for-all parallel):
- `client/src/types.ts`, `contracts.ts` — shared type spine; **integrator-owned, edited first, then frozen** so the
  rest build against stable types.
- B-health: `ws/validate.ts` (+ test), `useLiveTelemetry.ts`.
- A-names: `useRoster.ts` (new).
- C-review: `useHistory.ts` (new), `ReviewView.tsx` (new).
- **Shared, integrator-owned (serialise last):** `A11yMirror.tsx` (names + health columns), `PitchCanvas.tsx`
  (name label + health cue + shared heatmap draw), `App.tsx` (Live⇄Review toggle + pass roster down).

Build order: **types/contracts spine first (server + client) → frozen → fan out the disjoint new modules + tests
in parallel → integrator serialises the shared files (server.ts, metrics.ts, A11yMirror, PitchCanvas, App.tsx) →
verify → post-build security review.**

---

## §7 — Acceptance / definition of done
- `bunx tsc` clean (server + client); ESLint clean; all server tests + client units green; Playwright auth+live+
  review+frame-budget green.
- The name-leak guard passes — **no child name in any store, label, log line (incl. roster/CLI/history error
  paths), or client persistence (localStorage/sessionStorage scrape).**
- The history SLO test passes — over a **pre-seeded DB of ≥ 270k rows** (so the paging/yield path is genuinely
  exercised), a concurrent aggregate query keeps `ft_ws_messages_sent_total` accumulating at ≥ ~2% of baseline
  throughout (the loop is never frozen). `HISTORY_SCAN_CHUNK` and its measured per-chunk hold are recorded here.
- The read-endpoint DoS controls hold: per-principal 429 (bucket-isolated), history 503 inflight cap, and
  `Cache-Control: no-store` on every `/roster` + `/history` response.
- ids-only still works end-to-end with NO roster provisioned (names are an enhancement, never a gate).
- ADRs 0016/0017 flipped to "Implemented"; improvement-plan Phase 3 marked shipped; observability.md gains the new
  metrics; purge-player erasure note updated.

## §8 — Pre-mortem inputs (questions the adversarial pass must answer before freeze)
1. Roster endpoint: can it be turned into a bulk name-export oracle (enumerate sessions, scrape all names)? Is the
   per-request session-scope + authz sufficient, or is a rate-limit / audit-log needed?
2. History endpoint: bulk location-export attack surface — does span-cap + authz + paging actually bound it? Can a
   wildcard admin or a compromised cookie dump a whole session's raw trace cheaply?
3. Event-loop SLO: does paged aggregate reading truly not starve fan-out at 50 players, or is a worker mandatory?
4. Name-leak regressions: every new log/metric/error path — does any of them ever interpolate a displayName?
   (roster loader WARNs, history errors, validate, CLI stderr.)
5. Device-health fan-out: any way a `status` envelope reaches a coach NOT authorised for that session? Any field in
   the minimised set that is actually sensitive? Replay/record faithfulness with the new envelope.
6. Client: does the roster map ever get written to the telemetry store, persisted, or sent anywhere? Does a stale
   roster (reload race / session switch) ever paint the wrong name on a dot?

## §9 — Pre-mortem disposition (5 lenses, 44 findings; 19 confirmed must/should-fix folded above, 18 refuted)
All confirmed findings are folded into §0–§7. The substantive hardening the pre-mortem added beyond the first draft:
- **Read-endpoint DoS/bulk-export controls** (the biggest gap): per-principal rate-limit (429) on `/roster` +
  `/history`, an inflight cap (503) on `/history`, an audit-log line per request (success+reject, no names), and
  `Cache-Control: no-store` on both. Three overlapping rate-limit proposals were reconciled into ONE scheme
  (per-principal bucket + inflight cap + audit log); the per-(principal,session) hourly quota was deliberately
  deferred as redundant for now (cost #3) — it can layer on later without changing the bucket interface.
- **SLO test made able to fail:** the original "rate ≠ 0 while ramping to 50p" was vacuous (≈7.5k rows = one chunk,
  no inter-chunk yield, counter can't hit 0). Replaced with a ≥270k pre-seeded-row fixture + a "counter keeps
  rising ≥2% baseline" assertion. `HISTORY_SCAN_CHUNK` default dropped 10_000 → **1000** (~20 ms → ~1–2 ms hold).
- **Composite replay cursor:** `(serverTs,rowid)` — a ts-only cursor dups/skips rows that share a `Date.now()` ms.
- **Name-leak edges:** CLI validation errors + history error bodies/logs must not interpolate names/params;
  `validateDeviceHealth` must return a fresh literal (structural strip, not "don't read"); roster-loader test
  must capture stderr; client localStorage/sessionStorage scrape proves the never-persist invariant.
- **Client clears:** `useLiveTelemetry` clears BOTH `store` and `health` (no TTL on health) on session change;
  `useRoster` resets-then-AbortController-guards so a slow session-A fetch can't name a session-B dot.
- **Authz order:** `/roster` + `/history` do `currentPrincipal` BEFORE `validSessionId` (no session-id-validity
  oracle to an unauthenticated caller) — matches the existing `/auth/me` + `/sessions` GET handlers.

### Integration finding (caught by the wave-2 real-browser e2e, fixed before sign-off)
- **GET Origin policy was over-specified.** §0.4 originally said "strict Origin (absent → 403)" for the new
  GET endpoints, copied from the POST/WS posture. But browsers OMIT the Origin header on a same-origin GET
  `fetch()`, so `/roster` + `/history` 403'd the real coach UI (`useRoster`/`useHistory` got `forbidden_origin`).
  The server-side e2e missed it because they sent an explicit Origin header; only the Playwright browser run
  surfaced it. Fixed: a `originOkLenient` for the GET reads (absent OK, present must be allow-listed); STRICT
  stays on POST `/auth/*` + the WS upgrade. Regression guards added (no-Origin authed GET → 200) to both
  `roster-e2e.ts` and `history-e2e.ts`. Lesson folded into §0.4.

Refuted (not changed), for the record: the `<LiveView key=session:epoch>` remount already prevents the stale
store/roster race for the picker paths (the explicit clears/AbortController are belts for any future in-place
change); `validSessionId` already works on path-params; the existing pseudonymous-only `/auth/me` + `/sessions`
GETs need no Origin retrofit (no CORS headers + SameSite=Lax already block cross-site body reads, and they carry
no child data); a username metric label was correctly rejected (contradicts the established metrics.ts posture).
