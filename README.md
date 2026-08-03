# football-trackers

Personal, open DIY system for **real-time** tracking of youth football players.
Each player wears a small ESP32 + GNSS device that streams position at 10 Hz over
WiFi to a local broker; a NestJS service ingests, server-stamps, and fans out to a
live coach view. This is a private hobby project — not connected to any work platform.

## Docs
Product & business requirements live in [`docs/`](docs/README.md): [vision](docs/product/vision.md),
[market analysis](docs/product/market-analysis.md), [BRD](docs/requirements/business-requirements.md),
[functional](docs/requirements/functional-requirements.md) / [non-functional](docs/requirements/non-functional-requirements.md)
requirements, [metric definitions](docs/requirements/metric-definitions.md), [architecture](docs/architecture/system-architecture.md),
[observability](docs/architecture/observability.md), [hardware BOM](docs/architecture/hardware-bom.md),
and [decision records](docs/decisions/README.md).

## Why DIY
Commercial trackers are either cheap-but-closed (no real-time, no open data) or
have an API but cost a subscription per player. Goal here: real-time + fully owned.

## Architecture

```
[10x wearable]                 [field AP / laptop]                 [coach tablet]
ESP32 + NEO-M8N  --WiFi-->  Mosquitto MQTT  --> Bun/Elysia ingest --WS--> React live view
   (10 Hz UBX-PVT)            (QoS0)            parse + serverTs        pitch + dots
                                               + WS fan-out
                                               + bun:sqlite persist
                                               (TimescaleDB optional later)
```

MQTT topics:
- `football-trackers/session/{sessionId}/player/{playerId}/telemetry` — `{id, pl, ts, lat, lon, spd, hdg, fix, sats, pdop}`
- `football-trackers/session/{sessionId}/player/{playerId}/status` — device health (battery, RSSI, heap, backlog, fix), ~every 5 s

(`ts` = device millis, ordering only; `serverTs` is the authoritative timestamp.)
The server exposes Prometheus metrics on `/metrics` — see [observability](docs/architecture/observability.md).

## Repo layout

```
football-trackers/
  firmware/            ESP32 firmware (PlatformIO / Arduino)
    platformio.ini
    src/main.cpp
  server/              Bun + Elysia ingest + live fan-out (standalone app)
    src/
      types.ts         wire contract (RawTelemetry/Telemetry) + topic regex
      db.ts            bun:sqlite persistence
      ingest.ts        MQTT subscribe -> validate -> enrich -> persist + fan-out
      server.ts        Elysia entry: /live WS + /health, wires ingest
    test/              self-contained, hardware-free e2e (spawns broker+server)
  client/              Bun + Vite + React coach live view
    src/
      homography.ts    4-corner GPS->pitch projective transform (+ unit tests)
      useLiveTelemetry.ts  /live WS -> useRef Map (no per-packet re-render)
      PitchCanvas.tsx  rAF canvas render: pitch + player dots
```

## Hardware (1 prototype, sourced in Serbia)
- MCU: WEMOS Lite ESP32 (LOLIN32 Lite) — onboard LiPo charging
- GNSS: GY-GPSV3 NEO-M8N (u-blox, up to 10 Hz)
- Battery: LP-503759CL Li-Po 3.7V 1350 mAh
- Jumper wires (F-F) + male 2.54 mm header strip
- Tools: micro-USB cable, soldering iron, multimeter (verify LiPo polarity!)

## Firmware
PlatformIO: `cd firmware && pio run -t upload && pio device monitor`.
**Secrets are NOT in source** — the WiFi PSK and this device's MQTT username (= `PLAYER_ID`) / password live in
NVS, set once over serial on first boot via the `enroll` console
([ADR-0014](docs/decisions/0014-firmware-secret-provisioning.md)), so the same image flashes to every device
and only NVS differs. Full build / enrollment / rotation / flash-encryption runbook:
[`firmware/README.md`](firmware/README.md).
Wiring (Serial2): M8N TX -> GPIO16, M8N RX -> GPIO17, plus 3V3 + GND. First fix: outdoors, 30-60 s cold start.

## Server
Bun + Elysia, standalone (no build step). The MQTT ingest runs alongside the
Elysia HTTP/WS server in one process and fans out over native WS pub/sub.
```
cd server && bun install
bun start          # PORT=3000 (override w/ PORT), MQTT_URL, DB_PATH env
```
Env: `PORT` (default 3000; public `/live`), `METRICS_PORT` (default 9464; loopback `/health`+`/metrics`), `MQTT_URL` (default `mqtt://127.0.0.1:1883`),
`DB_PATH` (default `./telemetry.db`), `LOG_LEVEL` (default `info`), `APP_VERSION` (default `dev`),
`RETENTION_DAYS` (default 30; raw-fix retention window — `≤0` disables the purge, a malformed value fails safe to 30).

**Auth (Phase 2 — named login → cookie-on-upgrade; [ADR-0015](docs/decisions/0015-frontend-auth-transport.md),
[ADR-0008](docs/decisions/0008-authentication-access-control.md)).** The bundled shared `LIVE_TOKEN` is **gone**.
Coaches/admins log in by name; the server mints an HttpOnly session cookie that the browser auto-attaches to the
same-origin `/live` upgrade, and `/live` authorises the **principal** against the requested session server-side.
Security env:
- `AUTH_ACCOUNTS_FILE` (default `./auth-accounts.json`, not committed) — argon2id-hashed accounts, loaded at boot
  and reloaded every `AUTH_ACCOUNTS_RELOAD_SECONDS` (default 15) so edits/revocations apply without a restart.
- `AUTH_COOKIE_SECURE` (default `true`; set `false` only on `http://localhost` dev / isolated LAN — emits a loud
  boot warning), `AUTH_SESSION_TTL_SECONDS` (default 43200 = 12 h, absolute).
- `ALLOWED_ORIGINS` — **strict** comma-separated browser-Origin allow-list (CSWSH/CSRF defence): an **absent**
  Origin is now rejected on `/auth` + `/live`; empty + non-anon ⇒ loud boot warning (rejects all browser clients).
- `ALLOW_ANONYMOUS_LIVE=true` + `ANON_SESSIONS` (comma list) — isolated-LAN bypass only: skips login for the
  **live pitch**, and only for the listed sessions (never wildcard). It is **not** a general read bypass:
  `/roster` (names), `/history` (bulk raw location) and `/events` answer **403 `login_required`** to the anon
  principal — only `/live`, `/sessions`, `/auth/me` and `/config` (one age-band enum) are open. Signing in on
  such a stack is optional and still works: `currentPrincipal` resolves the cookie first and falls back to the
  anon principal, so a coach who logs in gets their real identity and is named in the audit log. Loud boot
  warning + `ft_anon_mode_active=1`.
- `PUBLIC_HOST` — the bind interface. Defaults to `0.0.0.0`, but to **`127.0.0.1` whenever
  `ALLOW_ANONYMOUS_LIVE=true`**: a feed that needs no login must not also be LAN-reachable, and an Origin
  allow-list cannot substitute (it is CSWSH defence, and an absent Origin — what every non-browser client sends
  — can't be authenticated). Override it where something else confines the port, such as a container whose
  published port is pinned to loopback; that combination logs a loud warning.
- Login DoS controls: `AUTH_LOGIN_BURST` (5) / `AUTH_LOGIN_WINDOW_S` (30) per-IP bucket, `MAX_INFLIGHT_LOGINS` (4)
  concurrent-hash cap, `AUTH_MAX_SESSIONS_PER_USER` (8) per-account session cap (so one principal can't evict
  another's sessions), `AUTH_MAX_SESSIONS` (1000) global backstop. The per-username failure soft-lock is
  detect-don't-deny (signals `429` on repeated wrong attempts + a WARN log, but never refuses the correct
  password) — so it can't be abused to lock a coach out of a live match.
- `TRUST_PROXY` (default `false`) — the login rate-limiter keys on the **socket peer** (unspoofable) by default.
  Set `true` **only** behind a single trusted reverse proxy (Caddy) that appends the real client to
  `X-Forwarded-For`; the server then uses the rightmost XFF hop. Leaving it false anywhere a client can reach
  the port directly prevents an attacker spoofing `X-Forwarded-For` to dodge the per-IP login throttle.
- `MQTT_USERNAME`/`MQTT_PASSWORD` (the broker runs `allow_anonymous false` + per-device ACLs — see
  [`server/mosquitto/`](server/mosquitto/README.md)).

Provision a coach (the running server picks it up within `AUTH_ACCOUNTS_RELOAD_SECONDS`; password via stdin or a
hidden TTY prompt — never a process argument):
```
bun run auth-user.ts add coach --role coach --sessions test   # also: remove <user> | list
```

Login flow: `POST /auth/login {username,password}` (present allow-listed `Origin` required) → `Set-Cookie` +
`{username,role,sessions,wildcard,anonymous,csrf}` (no token in the body) → the client opens `/live?sessionId=…`
**same-origin** and the cookie rides the upgrade. The client must therefore be served from the relay origin —
**Vite proxy in dev, Caddy in prod** (cookie-on-upgrade is same-origin-only). `POST /auth/logout` (header
`X-CSRF-Token`) deletes the token server-side, so a replayed cookie is rejected.
Endpoints: `/live` (WS, cookie-authed), `/auth/login`, `/auth/logout`, `/auth/me`, `/sessions` on `PORT`;
`/health` (readiness) + `/metrics` (Prometheus) on `METRICS_PORT`, **bound to 127.0.0.1**. Logs are structured JSON.

Quick end-to-end test (no hardware) — start a broker + the server, then:
```
mosquitto_pub -t 'football-trackers/session/test/player/01/telemetry' \
  -m '{"id":"trk-01","pl":"01","ts":1,"lat":44.8125,"lon":20.4612,"spd":3.2,"hdg":90,"fix":3,"sats":11,"pdop":1.2}'
```
Connect a WS client to `/live?sessionId=test` and watch for `{event:"telemetry"}`
frames. Or run the fully self-contained version (spawns its own broker+server).

**All of the suites below run in one command** — `bun run test` from `server/` (~20 s, sequential).
That is the gate CI runs; the individual commands are for working on one area at a time.
```
bun run test/e2e.ts              # asserts fan-out, fix<2 drop, sqlite persist
bun run test/mosquitto-pub-demo.ts   # the literal mosquitto_pub path above
bun run test/retention.ts        # 30-day purge, per-player erasure, byte-level secure_delete
```
Auth & access control (Phase 2 — see [the contract](docs/frontend/phase-2-auth-contract.md), [ADR-0015](docs/decisions/0015-frontend-auth-transport.md)):
```
bun run test/auth-e2e.ts         # cookie login → session-bound /live authz, logout revocation, reload revocation
bun run test/ws-origin.ts        # CSWSH: forged/absent Origin rejected, allow-listed Origin + cookie admitted
bun run test/auth-loader.ts      # accounts-file fail-closed loader (malformed/oversize/dup-username/bad-hash)
bun run test/auth-dos.ts         # /auth/login DoS guards: 415 / 413 / 429 / 503
bun run test/auth-cli.ts         # auth-user.ts add/remove/list (mode 0600, argon2id verify, no plaintext leak)
```
Identity, device-health & review/replay (Phase 3 — names, a second `/live` health envelope, off-loop history;
see [the contract](docs/frontend/phase-3-contract.md), [ADR-0016](docs/decisions/0016-player-name-roster.md),
[ADR-0017](docs/decisions/0017-review-replay-data-source.md)):
```
bun run test/roster-loader.ts    # fail-closed roster loader (missing/oversize/malformed/dup-id), no name in any log
bun run test/roster-cli.ts       # roster-user.ts set/remove/list (mode 0600, no name leaked on a validation error)
bun run test/roster-e2e.ts       # GET /sessions/:id/roster authz matrix + per-principal 429 + no-store + no name leak
bun run test/erasure-e2e.ts      # right-to-erasure: roster set -> purge-player -> rosterEntriesErased + DB rows + file
bun run test/history.ts          # GET /sessions/:id/history: aggregate/raw correctness, composite cursor, DoS gates, SLO
bun run test/history-e2e.ts      # live history endpoint: authz, rate-limit/inflight caps, opaque errors, no-store
bun run test/device-health-e2e.ts # a .../status frame -> minimised {event:'status'} on /live (no heap/up/pub/stash/name)
bun run test/session-config-loader.ts # fail-closed age-band config loader (missing/oversize/malformed/bad-band)
bun run test/session-config-cli.ts # session-config.ts set/remove/list (mode 0600, bad band can't corrupt the file)
bun run test/config-e2e.ts       # GET /sessions/:id/config authz + {ageBand,thresholds}; unconfigured -> U14 default
```
Phase 4 (coaching metrics — [ADR-0019](docs/decisions/0019-age-banded-zones-session-config.md)) adds youth
age-banded speed zones (live colour + review breakdown), live distance/min, an isolated-player cue, and
server-side sprint + accel/decel effort aggregates; `test/history.ts` covers the sprint/accel correctness.
Set a session's age band: `bun run session-config.ts set <sessionId> <U12|U14|U16|U19>`.
Tactical event detection (Track A — [ADR-0020](docs/decisions/0020-tactical-event-detection.md),
[contract](docs/frontend/event-detection-contract.md)) adds an off-loop `GET /sessions/:id/events`: a bucketed
team-shape series (centroid/compactness/hull) + heuristic phase events (high-tempo / transition / stoppage),
rendered as a review-mode timeline. Movement-derived, **never** confirmed ball events (passes/shots need new
sensing — see the status list). The inflight cap is **shared** with `/history` (one global off-loop-scan slot):
```
bun run test/events.ts           # detectors (boundaries + geometry) + readEvents (bucketing, player cap, final flush, adaptive bucketing)
bun run test/events-e2e.ts       # endpoint authz (no id oracle) + no-store + opaque 400 + the off-loop SLO under concurrent scans + shared cap (503)
bun run test/scan-load.ts        # the off-loop inflight cap is genuinely SHARED across /history + /events (both directions)
```
Erase one player's raw location (GDPR / lost device — see [ADR-0010](docs/decisions/0010-location-data-retention.md)):
```
bun run purge-player.ts <playerId> [sessionId]   # exit 0 + JSON receipt; exit 3 = not erased, retry
```

### Simulate a device fleet (no hardware)
While the real wearables are in transit, [`test/simulate.ts`](server/test/simulate.ts) is a virtual fleet:
N MQTT clients publishing the **exact** firmware wire contract (10 Hz telemetry + 5 s status) with
believable movement around the pitch, so the real server + coach view run unchanged.
```
bun run sim                                          # attach to a broker+server you already run
bun run sim --standalone --players 10                # turnkey: spawn its own broker + server
bun run sim --standalone --players 8 --faults --duration 30   # inject bad fixes / OOR / id-mismatch / rate bursts / dropouts
bun run sim --standalone --ramp 10,30,50 --stage-seconds 15   # load ramp; prints ingest p99 + drop rate per stage
bun run sim --standalone --secure --players 10 --faults       # + auth: per-player MQTT creds + %u ACLs + a named coach login (argon2id)
bun run sim --standalone --faults --duration 20 --record /tmp/run.ndjson   # capture the published stream
bun run sim --standalone --replay /tmp/run.ndjson             # re-publish it with the original timing (deterministic)
```
In `--standalone` it prints the exact same-origin `VITE_PROXY_TARGET=… bun run dev` to open the coach view
against the spawned stack. On stop it scrapes `/metrics` and reports what the server actually saw (received /
published / drops-by-reason / p99 / RSS). `--secure` provisions per-player MQTT accounts (username ==
`playerId`) + topic ACLs exactly like the e2e (confirming the broker blocks cross-player spoofing) **and** a
named coach login so the coach view exercises the real Phase-2 cookie auth; otherwise `/live` runs in the
isolated-LAN anonymous posture scoped to `ANON_SESSIONS` (dev only, no login). The coach account
(`coach` / `sim-coach-pw`, assigned to the run session) is provisioned in **both** postures — under `--secure`
it is the only way in; in the anonymous posture it is optional and buys names + Review, which the anon
principal no longer receives. `--record`/`--replay` reproduce an identical run for repeatable debugging.

## Client (coach live view)
Bun + Vite + React. Connects a plain WebSocket to `/live?sessionId=...`, keeps the
latest fix per player in a `useRef` Map, and renders dots on a `<canvas>` via
`requestAnimationFrame`. GPS->pitch is a homography from the 4 corner coords. Phase 1 hardening
(see [docs/frontend/improvement-plan.md](docs/frontend/improvement-plan.md)) adds a DPR-crisp,
~30fps-capped canvas; an honest bounded-interpolation motion model ([ADR-0018](docs/decisions/0018-live-position-smoothing-honesty.md):
snap across gaps, never extrapolate); explicit connection failure states (no silent infinite
reconnect); an accessible DOM mirror + ARIA live region; a strict CSP; and an outdoor high-contrast
mode + screen wake-lock.
```
cd client && bun install
bun run dev        # http://localhost:5173 ; same-origin via Vite proxy: VITE_PROXY_TARGET (default http://localhost:3000), VITE_DEFAULT_SESSION (default test)
bun run typecheck  # tsc --noEmit
bun run lint       # eslint (flat config, react-hooks)
bun test           # unit: homography + interpolation honesty + inbound-WS-frame validation
bun run e2e        # Playwright smoke + a11y + explicit-failure-state, driven by the simulator (first: bunx playwright install chromium)
bun run e2e:frame-budget   # 50-player frame-budget + DPR-crisp gate (verified separately)
```
Set your pitch's four GPS corners in `src/config.ts`. The app now opens with a **login screen**
([ADR-0015](docs/decisions/0015-frontend-auth-transport.md)): sign in with a coach/admin account, then it
connects to `/live` **same-origin** so the session cookie rides the upgrade — Vite proxies `/live`, `/auth`, and
`/sessions` to `VITE_PROXY_TARGET`, so no `VITE_LIVE_TOKEN`/`VITE_WS_URL` (both removed) and no per-client WS URL.
Add this app's origin (`http://localhost:5173`) to the server's `ALLOWED_ORIGINS`, and in dev set the server's
`AUTH_COOKIE_SECURE=false` (reach it via `http://localhost`, a secure context). With the server running and a
coach signed in, a `mosquitto_pub` of the README packet renders a dot at pitch centre. The CSP is
`connect-src 'self'` (same-origin WS + fetch + HMR) — no host to configure.

## Local dev with Docker Compose (+ bench-testing a real wearable)
One command brings up the device-facing backend (MQTT broker + ingest/WS server); the coach view (Vite) runs on
the host. Full walkthrough + troubleshooting: [docs/dev/local-bench-runbook.md](docs/dev/local-bench-runbook.md)
([ADR-0021](docs/decisions/0021-local-dev-docker-stack.md)).
```
./server/mosquitto/dev-provision.sh 01   # ONCE: broker accounts + .env (ft.passwd is gitignored)
docker compose up -d                     # broker (1883, authenticated) + server (127.0.0.1:3007)
cd client && VITE_PROXY_TARGET=http://127.0.0.1:3007 bun run dev   # coach view -> http://localhost:5173
```
- A real wearable connects to **this Mac's Wi-Fi IP** on 1883 — set the firmware `MQTT_HOST` to it; the device and
  the Mac must be on the **same Wi-Fi** (a wired dock Ethernet was found to be isolated from the Wi-Fi).
- The coach view runs on the **host**, not in the stack — Vite's `/live` WebSocket proxy doesn't relay the upgrade
  from a container.
- **The broker is authenticated** — it mounts the same `allow_anonymous false` config + per-device ACLs the field
  broker uses, so `docker compose up` fails loudly until `dev-provision.sh` has created the accounts, and every
  bench run exercises the real auth path. Re-running provisioning rotates credentials; follow it with
  `docker compose up -d`, because `restart` does not re-read `.env`.
- **The server is published on `127.0.0.1` only.** It runs in anon live mode (no login for the pitch view), and a
  no-login feed of children's positions must not also be reachable from the Wi-Fi. That makes the coach view
  this-machine-only; a pitch-side tablet is the Caddy + real-auth deployment, not this stack. Use
  `http://127.0.0.1:3007` (not `localhost`) as the proxy target — the bind is IPv4-only.
- **Names and Review still need a real login here.** `/roster`, `/history` and `/events` answer 403
  `login_required` for the anonymous principal; the anon view shows pseudonymous ids and a "Sign in for names &
  review" button. Provision a coach with
  `cd server && AUTH_ACCOUNTS_FILE=./auth-accounts.json bun run auth-user.ts add coach --role coach --sessions test`.

## Status / next
- [x] Hardware ordered (1-2 prototype sets)
- [x] Firmware skeleton (10 Hz -> MQTT, LittleFS backlog on dropout)
- [x] Bun/Elysia ingest + WS fan-out + bun:sqlite persist (e2e verified, no hardware)
- [x] Observability: Prometheus `/metrics`, JSON logs, device `.../status` health topic (e2e verified)
- [x] Security MSI: token-gated `/live` (+ Origin/CSWSH check), per-device MQTT creds + topic ACLs, server-side `id_mismatch` reject (e2e verified). Architecture-board reviewed — see [target-architecture](docs/architecture/target-architecture.md) + [ADRs 0006–0014](docs/decisions/README.md)
- [x] Data minimisation ([ADR-0010](docs/decisions/0010-location-data-retention.md)): 30-day raw-fix auto-purge (batched), per-player `secure_delete` erasure CLI, self-reporting retention metrics (unit + e2e verified)
- [x] React live view: 4-corner pitch homography, useRef Map + rAF canvas (browser-verified, no hardware)
- [x] FE Phase 1 (client-only MSI): DPR-crisp/~30fps-capped canvas, honest bounded interpolation ([ADR-0018](docs/decisions/0018-live-position-smoothing-honesty.md)), explicit failure states, accessible mirror + ARIA, strict CSP (connect-src derived from `VITE_WS_URL`), outdoor mode + wake-lock — typecheck/lint/unit + Playwright e2e through the simulator (p95 9.4 ms @ 50 players, DPR-crisp verified). See [improvement-plan](docs/frontend/improvement-plan.md)
- [x] FE Phase 2 (auth & security core): named login (argon2id + HttpOnly cookie) -> **cookie-on-upgrade**; bundled `LIVE_TOKEN` killed; principal-bound session authz on `/live` (`ft_ws_rejected{reason="not_authorized_for_session"}`); accounts file + `auth-user.ts` CLI; Vite same-origin proxy + `connect-src 'self'`; strict Origin; isolated-LAN anon scoped to `ANON_SESSIONS` ([ADR-0015](docs/decisions/0015-frontend-auth-transport.md), implements [ADR-0008](docs/decisions/0008-authentication-access-control.md)) — verified by the server auth e2e + client Playwright auth specs through the simulator
- [x] FE Phase 3 (identity, health, review): per-session roster **names** via authenticated `GET /sessions/:id/roster` (`roster-user.ts` CLI + `roster.json`, render-only client join, erasure-coupled in `purge-player`) ([ADR-0016](docs/decisions/0016-player-name-roster.md)); per-player **device health** as a second `/live` envelope (`{event:'status'}`) from the `.../status` topic; **review/replay** via off-loop/paged `GET /sessions/:id/history` (aggregate + heatmap default, raw scrub on demand) ([ADR-0017](docs/decisions/0017-review-replay-data-source.md)) — names never reach the store/DB/metrics/logs/client-persistence; verified by the Phase-3 server tests + Playwright live/review specs. See [improvement-plan](docs/frontend/improvement-plan.md)
- [x] Tactical event detection — **Track A** ([ADR-0020](docs/decisions/0020-tactical-event-detection.md), [contract](docs/frontend/event-detection-contract.md)): off-loop `GET /sessions/:id/events` — a bucketed team-shape series (centroid/compactness/hull) + heuristic **high-tempo / transition / stoppage** phases, rendered as a review-mode timeline; team-aggregate (no name/playerId, ever), honesty-labelled (confidence + provenance), the inflight cap **shared** with `/history`. Movement-derived, **not** confirmed ball events. Built frozen-contract → 5-lens pre-mortem (6 must-fix folded) → parallel slices → post-build review; verified by `test/events.ts` + `test/events-e2e.ts` (270k-row off-loop SLO + shared-cap 503) + the Playwright review spec
- [x] Validate full pipeline on ONE device (2026-06-17): real ESP32+NEO-M8N assembled → flashed → enrolled → **device → Wi-Fi → broker → server → live view** all confirmed end-to-end (server received the device's `.../status` health + 10 Hz telemetry; indoors all positions correctly dropped `no_fix`, a synthetic `fix=3` packet rendered a dot). Local Docker stack + the bench runbook: [docs/dev/local-bench-runbook.md](docs/dev/local-bench-runbook.md). **Remaining:** the outdoor real-GPS dot + the LiPo battery (untethered field use)
- [ ] Persistence at scale: TimescaleDB hypertable (sqlite is fine for now)
- [ ] Football events — **Track B** (passes/shots/tackles): **not** derivable from GPS one-team positions — needs a calf IMU @200-500 Hz + ML, or one elevated 4K camera + CV (a separate sensing/ML research spike; the camera route reopens the out-of-scope child-video DPIA). Scoped but deferred in [ADR-0020](docs/decisions/0020-tactical-event-detection.md) §6
