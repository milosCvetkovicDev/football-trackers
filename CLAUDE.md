# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A DIY real-time tracking system for youth football players. Each player wears an
**ESP32 + u-blox NEO-M8N** device that streams GNSS position at **10 Hz** over WiFi →
**Mosquitto MQTT** → a **Bun + Elysia** ingest service that server-stamps, persists, and
fans out to a live coach view over WebSocket. Private hobby project; not wired to any
work platform.

Two independently-scoped parts:

- **`firmware/`** — a complete, buildable PlatformIO/Arduino sketch for the wearable.
- **`server/`** — a standalone **Bun + Elysia** app (no build step; Bun runs the `.ts`
  directly). The MQTT ingest and the Elysia HTTP/WebSocket server run in the **same
  process** on the Bun event loop. (Migrated from an earlier NestJS implementation.)
- **`client/`** — the coach live view: **Vite + React + TS**, a plain `WebSocket` to
  `/live`, positions in a `useRef` Map, rendered on a `<canvas>` via `requestAnimationFrame`
  with a GPS→pitch homography.

## Commands

Server (from `server/`):
```
bun install
bun start          # run; bun --watch for dev (bun run dev)
bun run typecheck  # bunx tsc --noEmit (Bun does not typecheck at runtime)
bun run test       # THE GATE: all 25 suites, sequential, ~35 s (test/run-all.ts)
bun run test:e2e   # one suite; every suite also has its own test:* script
bun run test/mosquitto-pub-demo.ts   # the README's literal mosquitto_pub -> WS path
```
`bun run test` is `test/run-all.ts`, not bare `bun test`. It refuses to start if any file in
`test/` is neither a declared suite nor a declared non-suite — so adding a test file without
wiring it in fails loudly instead of quietly shrinking the gate.
Env: `PORT` (default 3000), `MQTT_URL` (default `mqtt://127.0.0.1:1883`), `DB_PATH`
(default `./telemetry.db`). Every numeric knob goes through `src/env.ts` — an invalid value (e.g. `6h`) falls back to
the default LOUDLY (warn at parse, listed again in the boot `config resolved` line), never to `NaN`.
The broker is mosquitto (`brew install mosquitto`).

Client (from `client/`):
```
bun install
bun run dev        # Vite dev on :5173; VITE_PROXY_TARGET is the same-origin proxy upstream
bun run build      # vite production build
bun run typecheck  # tsc --noEmit
bun run lint       # eslint .
bun run test       # unit suites (homography, interpolate, ws/validate, zones)
bun run e2e        # Playwright, driven by the hardware-free simulator
```
The e2e gate binds **sixteen** ports across four stacks: the shared happy-path one
(:3000/:9464/:1884/:5173) plus three dedicated stacks spun up inside specs — auth
(:3201/:9466/:1885/:5273), review (:3202/:9476/:1896/:5274) and the 50-player frame-budget run
(:3210/:9474/:1894/:5283).
Only the happy-path four are env-overridable, which is enough in practice because :3000 is the
one that collides. If something else holds it, move the block rather than shutting that down:
`PW_SERVER_PORT=3300 PW_HEALTH_PORT=9564 PW_BROKER_PORT=1984 PW_VITE_PORT=5373 bun run e2e`
— see [client/e2e/ports.ts](client/e2e/ports.ts), the single source both the config and the
specs read (the other twelve are hardcoded in `e2e/fixtures.ts` and the review spec).
Review needs its own **auth-ON** stack because Phase 2 scoped the anonymous principal to the live
pitch: `/roster`, `/history` and `/events` answer 403 without a real login, so the review specs
sign in.

Firmware (from `firmware/`):
```
pio run                                   # compile only
pio run -t upload && pio device monitor   # flash + serial @115200
```
Non-secret config is at the top of `firmware/src/main.cpp` (`DEVICE CONFIG`): `MQTT_HOST`,
`MQTT_PORT` — with `MQTT_HOST` and `SESSION_ID` as compiled DEFAULTS only (both live in NVS since
ADR-0022 / audit Phase 4 F-6: `set host` / `set session` in the enroll console; session is the unit of
coach access control, so real fixtures set it per device). **Secrets are NOT in source:** the WiFi PSK
and per-device MQTT username (= `PLAYER_ID`) / password live in NVS, set once via the serial `enroll`
console, so one image flashes to every device ([ADR-0014](docs/decisions/0014-firmware-secret-provisioning.md),
[firmware/README.md](firmware/README.md)).

Local dev stack (Docker Compose) — broker + server with one command; the coach view (Vite) runs on the **host**
(its `/live` WS proxy doesn't relay the upgrade from inside a container):
```
./server/mosquitto/dev-provision.sh 01   # ONCE: broker accounts + .env (ft.passwd is gitignored)
docker compose up -d                     # mosquitto (1883, authenticated) + server (127.0.0.1:3007)
cd client && VITE_PROXY_TARGET=http://127.0.0.1:3007 bun run dev   # http://localhost:5173
```
The broker mounts `server/mosquitto/` — the **same authenticated config + per-device ACLs as the field
broker**, not an anonymous dev one — so `docker compose up` fails loudly until provisioning has run, and every
bench run exercises the real auth path. The server's port is published on **127.0.0.1 only** (the stack needs
no login for the live view, so it must not be LAN-reachable — hence `127.0.0.1`, not `localhost`, in the proxy
target: the bind is IPv4-only). Re-running provisioning rotates the credentials, so follow it with
`docker compose up -d` — `restart` does **not** re-read `.env`.
Names and Review need a real login even here (`/roster`, `/history`, `/events` → 403 `login_required`); the
anon view offers a "Sign in for names & review" button. Provision a coach with
`cd server && AUTH_ACCOUNTS_FILE=./auth-accounts.json bun run auth-user.ts add coach --role coach --sessions test`.
A real wearable connects to this Mac's **Wi-Fi** IP on 1883 (set firmware `MQTT_HOST` to it); device + Mac must be
on the same Wi-Fi (a wired dock Ethernet was found isolated from the Wi-Fi). Full runbook +
troubleshooting: [docs/dev/local-bench-runbook.md](docs/dev/local-bench-runbook.md)
([ADR-0021](docs/decisions/0021-local-dev-docker-stack.md)).

## Architecture (the parts that span files)

**One pipeline, one wire contract.** The MQTT topic + JSON packet shape bind firmware →
broker → server. Change either side and you change both:

- Topic: `football-trackers/session/{sessionId}/player/{playerId}/telemetry`
- Packet (terse keys, `RawTelemetry` in `server/src/types.ts`):
  `{id, pl, ts, lat, lon, spd, hdg, fix, sats, pdop, sq, gts}` — `sq` = per-device monotonic sequence
  (server dedupes replays on `(player_id, seq)`), `gts` = the fix's GPS-UTC epoch ms (0 = GPS time not
  yet valid; a sane `gts` becomes the row's `serverTs`, so replayed outages keep their real span)
- The firmware builds topic+packet in `main.cpp`; the server subscribes with the MQTT `+`
  wildcard (`TELEMETRY_TOPIC`) and recovers `sessionId`/`playerId` by re-matching the
  concrete topic with `TOPIC_RE` (`server/src/ingest.ts`).
- **Second topic, same shape rule:** `.../status` carries device health (`DeviceStatus` in
  `types.ts`, recovered with `STATUS_TOPIC_RE`) ~every 5 s — battery, RSSI, heap, backlog,
  fix quality, device-side pub/stash counters, plus (Phase 4) `rst` (reset reason), `boot`
  (boot count) and `ver` (firmware version). Best-effort, **not** backlogged.

**Three timestamps, by design (Phase 4).** `ts` is the *device* clock (`millis()`), ordering only and
explicitly **not** authoritative. `gts` is the fix's GPS-UTC time — near-exact when valid, and the
server TRUSTS it as the row's `serverTs` only inside a sanity window (≤ 2 s ahead, ≤ 6 h behind
arrival; `wire.ts`), which is what lets a replayed outage span its real duration (audit F-2). Outside
that window — or when `gts` is 0/absent — `serverTs = Date.now()` at ingest, the fallback source of
truth. The split lives across `main.cpp`, `types.ts` and `wire.ts` — preserve it.

**Ingest → fan-out → persist** (`server/src/ingest.ts`): MQTT QoS0 → JSON-parse → validate every field at the
boundary (`src/wire.ts`: finite numbers + bounded ids, else `bad_payload`; `fix < 2` → `no_fix`) → enrich into `Telemetry` →
`insertTelemetry()` (bun:sqlite) → `publish(sessionId, t)`. The publish callback is wired
in `server.ts` to Elysia's native WS pub/sub: `server.publish('session:'+id, …)`. Every step
is instrumented — drops are counted **by reason**, latencies timed — see Observability below.

**Observability** (`server/src/metrics.ts`, `log.ts`): a zero-dep Prometheus registry on
`GET /metrics` (counters/gauges/histograms, `ft_` prefix; session/player labels are CAPPED — 32/256 distinct values,
overflow → `_other`; non-finite values are refused) plus
structured ndjson logs (`log.{info,warn,error}`, `LOG_LEVEL`). The `.../status` topic feeds
per-player device-health gauges (battery/RSSI/backlog). Full strategy, SLOs, alert rules, and a
runbook in `docs/architecture/observability.md`; the e2e test asserts `/metrics` is correct.

**Live fan-out** (`server/src/server.ts`): Elysia `.ws('/live')`; a client connects to
`/live?sessionId=<id>` and the `open` handler does `ws.subscribe('session:'+id)` (one room
per session). Frames sent to clients are JSON envelopes `{event:'telemetry', data:Telemetry}`.
Fan-out uses Bun's native WS pub/sub directly — **not** socket.io — so the (not-yet-built)
coach UI uses a plain `WebSocket`, not `socket.io-client`. `GET /health` returns
`{ok, mqtt, db, version, uptimeSeconds}` — HTTP 200 when `ok` (= `mqtt && db`), 503 otherwise — where `mqtt`
follows the broker client's connect/close events (true once subscribed, false on close/offline) and `db` is a
`SELECT 1` probe; the e2e tests poll it as a readiness gate to avoid the QoS0 publish-before-subscribe race.
`GET /metrics` is the Prometheus scrape target.

**Persistence** (`server/src/db.ts`): bun:sqlite, WAL mode, one prepared insert per packet
(no batching needed at ~100 msg/s). This is the "local SQLite" option from the original
plan; swap this module for a TimescaleDB writer later without touching `ingest.ts`.

**Field resilience** (`firmware/src/main.cpp` + `firmware/src/resilience.h`, Phase 4): connectivity
is a non-blocking state machine (jittered backoff; the GPS drain never stalls more than one ~3 s TCP
attempt, absorbed by an 8 KB RX buffer). Offline fixes go to a TWO-file LittleFS backlog (2×128 KB,
drop-OLDEST when full) and are replayed PACED (~30 msg/s) from an NVS cursor checkpointed every 20
records — a crash mid-flush re-sends at most one window, which the server dedupes via `sq`. Records
older than 6 h are skipped/purged; `wipe` over serial erases the backlog. The pure logic is
host-tested in `firmware/test/host/` (clang++, also in firmware-ci).

**GPS bring-up** (`main.cpp::gpsBegin`): the NEO-M8N ships at 9600 baud / 1 Hz / NMEA. The
code talks UBX to raise serial baud to 115200, switches to UBX-only output, sets 10 Hz,
enables `autoPVT`, and persists to the module flash — with a 9600 fallback. Unit
conversions happen at publish time (lat/lon ÷1e7 to 7 dp, speed mm/s→m/s, heading ÷1e5,
pdop ÷100).

## Status

Implemented: firmware (10 Hz → MQTT + LittleFS backlog + `.../status` health + NVS-provisioned
secrets via serial `enroll`); Bun/Elysia
ingest + WS fan-out + bun:sqlite persist + observability (Prometheus `/metrics`, JSON logs);
React live view (4-corner pitch homography, useRef Map + rAF canvas); the four-phase coach FE
roadmap (MSI, auth, names/device-health/review, coaching metrics); and **tactical event detection
Track A** (off-loop `GET /sessions/:id/events` — a time-bucketed team-shape series + heuristic
high-tempo/transition/stoppage phases, review-mode timeline; team-aggregate, movement-derived
**not** ball events; [ADR-0020](docs/decisions/0020-tactical-event-detection.md)). The events read
shares the off-loop inflight cap with `/history` via `server/src/scanLoad.ts` (one global
concurrent-scan slot). All e2e/browser-verified without hardware. **First real prototype validated end-to-end
2026-06-17** (device → Wi-Fi → broker → server → live view; the server received the device's real `.../status`
health + 10 Hz telemetry; indoors positions correctly dropped `no_fix`) via the local Docker dev stack + the
bench runbook ([docs/dev/local-bench-runbook.md](docs/dev/local-bench-runbook.md),
[ADR-0021](docs/decisions/0021-local-dev-docker-stack.md)). Remaining: the outdoor real-GPS dot + the LiPo battery
(untethered field use), TimescaleDB at scale, and **Track B** ball-interaction events (passes/shots — need a calf
IMU @200–500 Hz + ML or a 4K camera + CV). See the checklist in `README.md`.
