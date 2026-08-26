# Frontend improvement plan — coach live view (`client/`)

**Status:** Plan (design) · **Date:** 2026-06-15 · **Source:** six-expert FE panel (rendering, live-ops UX,
frontend security, React/TS architecture, accessibility, football-coaching) + chair synthesis + adversarial
verification.

Takes the coach SPA from "working prototype" to a production-grade, secure, glanceable tool across a
**pitch-side tablet (primary, outdoor, always-on, touch)**, a **phone (portrait)**, and a **desktop (review,
mouse)**. Drivers, in order: **security** (the payload is children's live location) → **performance**
(multi-player real-time) → **cost** (self-hosted, minimal dependencies).

## Starting state (pre-Phase-1 baseline, for context)
React 19 + Vite 8 + TS, ~451 lines. Plain WS to `/live?sessionId&token`; latest-fix-per-player in a `useRef`
Map; rAF canvas with a 4-corner GPS→pitch homography. **The `useRef`-Map + rAF model and the homography are
correct — preserve them.** Gaps: bundled `LIVE_TOKEN` + token-in-URL; canvas not DPR-scaled (blurry on the
target devices); dots teleport at 10 Hz (`spd`/`hdg` unused); ids-only (no names); no device-health surfacing;
silent infinite reconnect on auth failure; build-time-only config; no outdoor mode / wake-lock; canvas-only
a11y; only the homography is tested.

## What the adversarial pass changed (carried into the plan)
- **DPR is mandatory but *costs* budget** (4–9× fill) — it is the budget's main threat on a sun-throttled
  tablet, not its guardian. Pair it with **decoupling render from 60 fps** (dirty-flag / cap ~30 fps; data is
  only 10 Hz) and **measure** at 50 players before claiming "within budget." Clamp DPR ≤2 if a device fails.
- **Interpolation must be guarded, not absolute** — see [ADR-0018](../decisions/0018-live-position-smoothing-honesty.md):
  interpolate only across <~200 ms gaps, snap otherwise, never extrapolate.
- **Cookie-on-upgrade is same-origin-only** — pin the topology + Vite proxy ([ADR-0015](../decisions/0015-frontend-auth-transport.md)).
- **Names preserve pseudonymity of the *stores*, not the screen** ([ADR-0016](../decisions/0016-player-name-roster.md)).
- **History reads must run off the live loop** and be verified as an SLO ([ADR-0017](../decisions/0017-review-replay-data-source.md)).
- **Domain:** speed/sprint zones **must be age-banded** for children (adult thresholds are a measurement
  artefact — see [metric-definitions](../requirements/metric-definitions.md)); keep load metrics (sprint
  counts, accel/decel, ACWR) **off** the live path — they are review-only.

## Phased plan
Items are tagged by driver and note server dependencies. **Phase 1 is the Minimum Safe Increment** and is
entirely client-side (no server changes, no firmware).

### Phase 1 — MSI · client-only · **shipped 2026-06-15**
Built via five parallel agents over disjoint files (rendering, connection/data-integrity, CSP,
a11y/resilience, testing) + integration. Verified green: `tsc`, ESLint, Bun unit tests (homography +
interpolation honesty + inbound-WS-frame validation), `vite build`, and the simulator-driven
Playwright gate — 4 live/a11y/failure-state specs + the 50-player frame-budget gate (**p95 9.4 ms**,
DPR-crisp checked separately). The strict CSP's `connect-src` is derived from `VITE_WS_URL` at
build/dev time (a hardcoded host silently kills the feed). All items below landed:

| Item | Driver | Notes |
|---|---|---|
| DPR-crisp canvas, ResizeObserver-driven backing store, homography `dst`/`pxPerM` recomputed from the live CSS box | perf/usability | clamp DPR ≤2; **decouple render from 60 fps** (dirty-flag/cap) |
| Static-pitch layer separated from the dynamic player layer; data-gated rAF; pause on `visibilitychange` | perf | battery on the always-on tablet |
| Guarded two-fix interpolation + heading arrow + live speed + short trail | perf/usability | [ADR-0018](../decisions/0018-live-position-smoothing-honesty.md) honesty rule |
| Explicit failure/empty states — **stop the silent infinite reconnect**; distinguish unauthorized / wrong-session / no-players / disconnected | security/usability | interpret the server's `1008` close |
| React error boundary; wrap the homography solve so a degenerate-corner config shows UI, not a white screen | usability | |
| Strict CSP + self-hosted assets (SRI) on `index.html` | security | script-injection / exfiltration backstop |
| Accessible DOM mirror (role=img label + ~1 Hz player/health table) + ARIA live region for status; status by **shape + text**, not colour alone; honour `prefers-reduced-motion` | a11y | |
| Outdoor high-contrast mode + screen **wake-lock** | usability | primary tablet |
| Input hardening on inbound WS frames; bound the player Map | security | |
| Playwright e2e driven by the **simulator** (`--record`/`--replay` = deterministic visual checks) + a 50-player **frame-budget measurement gate**; client lint + CI | cost/quality | |

### Phase 2 — auth & security core · **shipped 2026-06-15** ([ADR-0015](../decisions/0015-frontend-auth-transport.md), implements [ADR-0008](../decisions/0008-authentication-access-control.md))
Named login (argon2id + HTTP-only cookie) → **cookie on the WS upgrade**; **bundled token killed**; Vite
same-origin dev proxy; **principal-bound session authz** in `server.ts` `open()` (`ft_ws_rejected{reason="not_authorized_for_session"}`); the Phase-1 failure states wired to real auth outcomes (`unauthorized` → re-check the cookie, `forbidden session` → terminal "not authorized for this session").

Built via parallel streams over disjoint files (server auth core + routes, client `useAuth`/`Login`,
`App`/`useLiveTelemetry`, CSP/Vite proxy, server + client tests, simulator, docs) against a **frozen contract**
that a 4-lens adversarial security pre-mortem hardened before any code was written — every must-fix (server-side
logout revocation, strict Origin, anon scoped to `ANON_SESSIONS`, argon2id login DoS controls + constant-work
dummy hash, accounts-reload revocation path, CSRF synchronizer token) folded in up front. The server auth core
was smoke-verified first as the sequential dependency; the full path is verified by the server auth e2e + client
Playwright auth specs through the simulator (`--secure` provisions a default coach account; anonymous standalone
exercises the isolated-LAN bypass), with the standing guard that no child name reaches a metric label or log line.
New auth metrics (`ft_auth_logins_total{result}`, `ft_auth_sessions_active`, `ft_anon_mode_active`) and the
`not_authorized_for_session` reject reason are in [observability](../architecture/observability.md).

### Phase 3 — identity, health, review · **shipped 2026-06-15** ([ADR-0016](../decisions/0016-player-name-roster.md), [ADR-0017](../decisions/0017-review-replay-data-source.md))
- Player **names** via an authenticated per-session roster ([ADR-0016](../decisions/0016-player-name-roster.md)):
  `GET /sessions/:id/roster` off a fail-closed roster store (`server/src/roster.ts`) + a `roster-user.ts` CLI +
  `roster.json` (`0o600`); `purge-player` now erases the roster entry too. The client (`useRoster`) joins
  `playerId → displayName` **render-only** — names never enter the telemetry store, any DB/history row, a metric
  label/HELP line, a log line, or client persistence.
- **Device health** (battery / GPS fix / backlog) surfaced per player — a second `/live` envelope
  `{event:'status', data: DeviceHealth}` from the existing `.../status` data, minimised to coach-relevant fields;
  shown as A11yMirror columns + a small canvas health cue. A coach can finally tell a stationary player from a
  dropped tracker.
- **Review/replay mode** ([ADR-0017](../decisions/0017-review-replay-data-source.md)) — a Live⇄Review shell;
  `GET /sessions/:id/history` (aggregate default + raw keyset-paged) reads **off the live loop** (single-threaded
  paging + yields, worker deferred) under per-principal rate-limit + inflight cap + audit log; the client
  (`useHistory` + `ReviewView`) renders an aggregate table + occupancy heatmap + raw scrub on the live homography.

Built the same way as Phase 1/2: a **frozen contract** ([phase-3-contract](phase-3-contract.md)) hardened by an
adversarial **pre-mortem** (5 lenses, names-never-leak + bulk-export-DoS + event-loop-SLO the headline risks) →
**parallel slices** over disjoint files → **integration** of the shared files → a post-build **security review**.
Verified green: `tsc`/ESLint (server + client), all server tests (incl. `roster-e2e`, `erasure-e2e`, the `history`
SLO case over ≥270k pre-seeded rows, `device-health-e2e`), client units, and the Playwright live/review specs —
with the standing guard that no child name reaches a store, label, log line, or `localStorage`/`sessionStorage`.

### Phase 4 — coaching polish · **shipped 2026-06-15** ([ADR-0019](../decisions/0019-age-banded-zones-session-config.md), [phase-4-contract.md](phase-4-contract.md))
Age-banded speed-zone colouring + live distance/min; a positions-only "isolated player" cue; post-match
aggregates (zone breakdown, sprint + accel/decel efforts, distance/min) computed **server-side**, off the live
path. The youth thresholds (U12–U19) are transcribed verbatim from [metric-definitions](../requirements/metric-definitions.md)
§3.2 — adult zones do not transfer to children; the per-session age band lives in a server config store + CLI
and is served (resolved) from `GET /sessions/:id/config`, so live colour and the review breakdown use the same
band. **Deferred** (need IMU or cross-session data, not GPS-v1): PlayerLoad, metabolic power/HMLD, sRPE, ACWR,
individualized MSS/MAS. Built via the same frozen-contract → pre-mortem → parallel slices → integration →
post-build review flow (pre-mortem fixed the pre-existing *ungated-distance* phantom-distance bug; post-build
caught a sprint-effort merge/off-by-one). That completes the four-phase roadmap.

### Beyond the roadmap — tactical event detection (Track A) · **shipped 2026-06-16** ([ADR-0020](../decisions/0020-tactical-event-detection.md), [event-detection-contract](event-detection-contract.md))
A NEW initiative past the four-phase plan. Off-loop `GET /sessions/:id/events` reconstructs **time-bucketed
team-shape snapshots** (centroid, compactness/stretch, convex-hull surface area, spread, mean speed, HSR
fraction) from the stored trace and detects three **heuristic** phases — high-tempo, transition, stoppage —
rendered as a review-mode timeline (`EventTimeline`). Team-aggregate (no playerId/name, ever), honesty-labelled
(confidence + provenance; **movement-derived, not confirmed ball events**), with the *entire* history security
posture and a **shared** off-loop inflight cap (`scanLoad.ts`). The naive reading of "football events"
(passes/shots) is **Track B** — not derivable from one-team 10 Hz GPS; it needs new sensing (IMU+ML or camera+CV)
and is deferred (ADR-0020 §6). Same flow as the phases: frozen contract → 5-lens pre-mortem (6 must-fix) →
parallel slices → post-build review (3 confirmed + 5 nits, all test-coverage/env-hardening).

### Beyond the roadmap — coach-view reliability · **shipped 2026-08-26** (audit Phase 5, [ADR-0024](../decisions/0024-client-reliability-signals.md))
Not a feature phase: the [2026-08-03 production-readiness audit](../audit/2026-08-03-production-readiness.md)
found that several things this plan assumed were true only on a desk. **C-1** — a match-day LAN has no NTP, so
every freshness comparison mixed the TABLET's clock with a SERVER-stamped `serverTs`; a tablet 10 s fast
rendered an EMPTY PITCH over a healthy 10 Hz feed, and a slow one kept a dead tracker alive forever, defeating
[ADR-0018](../decisions/0018-live-position-smoothing-honesty.md)'s honesty rule outright. Fixed with
`serverClock.ts` (a running minimum of `Date.now() - serverTs`) feeding every age computation — fed ONLY
by the new `{event:'hello'}` envelope (the server's clock, first frame on every socket) and by `.../status`
frames, never by telemetry: a Phase-4 replayed fix carries its GPS time, and an adversarial review showed a
page loading during a backlog drain would otherwise infer an offset of hours and draw stale fixes as live
dots — the honesty rule failing in its dangerous direction. **C-2** — the
reconnect give-up was terminal for the rest of the match, with no button and no `online` listener; recovery
existed only by accident (toggle to Review and back). Now `conn.retryable` + `reconnectNow()` + a "Reconnect
now" control — plus a **stall watchdog**, because the same review found the recovery unreachable in the
commonest field failure of all: a transport that stops carrying bytes without ever closing (the tablet
behind the clubhouse, the AP dropping the flow), where the socket stays OPEN and the phase stayed 'live'
while the pitch quietly emptied. And from §6: the pitch's four corners moved out of the bundle into per-session config (they were
pointing at a bench in Belgrade); error boundaries scoped so a Review crash no longer white-screens the shell;
a deadline on every fetch; retries that actually re-fetch (re-pressing Apply was a no-op); off-pitch players
pinned to the canvas edge instead of silently clipped while still being counted; 44 px touch targets; and the
first client→server write — a four-value beacon so a dark tablet is visible from `/metrics` (ADR-0024). Gated
by a Playwright `reliability` project that kills and restarts a real server, skews the browser clock 30 s, and
induces a real Review crash.

## Server contracts the FE depends on
| Endpoint | Purpose | Auth / shape |
|---|---|---|
| `POST /auth/login` (+ session cookie) | named login | argon2id; HTTP-only/Secure/`SameSite=Lax` |
| `GET /sessions` | principal-scoped list (no-rebuild switcher) | principal-authed |
| `GET /sessions/:id/roster` | `playerId → displayName` | principal-authed, session-scoped, in-memory only |
| `GET /sessions/:id/config` | age band → youth zone thresholds (Phase 4) **+ the session's four pitch corners** (Phase 5) | principal-authed, session-scoped; `pitch` omitted when unset |
| `GET /sessions/:id/history?…` | review/replay source (+ Phase-4 zone/sprint/effort aggregates) | principal-authed, session-scoped, **off-loop/paged** |
| `GET /sessions/:id/events?…` | tactical events ([ADR-0020](../decisions/0020-tactical-event-detection.md)): team-shape series + heuristic phases | principal-authed, session-scoped, **off-loop**, inflight cap **shared** with history |
| device-health on `/live` | per-player battery/GPS/backlog | second envelope from `.../status` |
| `POST /sessions/:id/client-beacon` | the coach view reports its OWN failures ([ADR-0024](../decisions/0024-client-reliability-signals.md)) | principal-authed, session-scoped, **strict Origin**, closed four-value body, rate-limited |

## Testing & verification
Drive everything from the **simulator** ([`server/test/simulate.ts`](../../server/test/simulate.ts)):
`--record`/`--replay` for deterministic visual/e2e checks; the 50-player ramp for the frame-budget gate
(crisp **and** within-budget verified separately); the secured-broker mode for auth-path tests; a guard that
no name reaches a metric label or log line.

## Success criteria
Crisp on a retina tablet in sunlight; smooth, **honest** motion (no fabricated positions); real names without
weakening store-level pseudonymity; **no bundle-baked shared token**; runtime session switching; a working
review mode; accessible status/alerts; minimal new dependencies; all exercisable via the simulator.

## Decisions
[ADR-0015 auth transport](../decisions/0015-frontend-auth-transport.md) ·
[ADR-0016 roster / names](../decisions/0016-player-name-roster.md) ·
[ADR-0017 review data source](../decisions/0017-review-replay-data-source.md) ·
[ADR-0018 smoothing honesty rule](../decisions/0018-live-position-smoothing-honesty.md).
