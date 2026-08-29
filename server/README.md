# server/ — Bun + Elysia ingest, live fan-out, persistence

Standalone app, no build step (Bun runs the `.ts` directly). The MQTT ingest and the Elysia
HTTP/WebSocket server run in **one process** on the Bun event loop: subscribe → validate every
field at the boundary → enrich → `bun:sqlite` insert → WS pub/sub fan-out, every step instrumented.

```
bun install
bun start          # bun --watch for dev (bun run dev)
bun run typecheck  # bunx tsc --noEmit
bun run test       # THE GATE: all suites, sequential (test/run-all.ts — see below)
```

`bun run test` is `test/run-all.ts`, **not** bare `bun test`: it refuses to start if any file in
`test/` is neither a declared suite nor a declared non-suite, so adding a test file without wiring
it in fails loudly instead of quietly shrinking the gate.

## Environment

Every numeric knob goes through `src/env.ts` — an invalid value falls back to the default LOUDLY
(warn at parse, listed again in the boot `config resolved` line), never to `NaN`.

- `PORT` (default 3000; public `/live`), `METRICS_PORT` (default 9464; loopback `/health` + `/metrics`)
- `MQTT_URL` (default `mqtt://127.0.0.1:1883`), `MQTT_USERNAME`/`MQTT_PASSWORD` (the broker runs
  `allow_anonymous false` + per-device ACLs — see [`mosquitto/`](mosquitto/README.md))
- `DB_PATH` (default `./telemetry.db`), `LOG_LEVEL` (default `info`), `APP_VERSION` (default `dev`)
- `RETENTION_DAYS` (default 30; raw-fix retention window — `≤0` disables the purge, a malformed
  value fails safe to 30)

## Auth & access control

Phase 2 — named login → cookie-on-upgrade ([ADR-0015](../docs/decisions/0015-frontend-auth-transport.md),
[ADR-0008](../docs/decisions/0008-authentication-access-control.md)). The bundled shared `LIVE_TOKEN` is
**gone**. Coaches/admins log in by name; the server mints an HttpOnly session cookie that the browser
auto-attaches to the same-origin `/live` upgrade, and `/live` authorises the **principal** against the
requested session server-side.

- `AUTH_ACCOUNTS_FILE` (default `./auth-accounts.json`, not committed) — argon2id-hashed accounts,
  loaded at boot and reloaded every `AUTH_ACCOUNTS_RELOAD_SECONDS` (default 15) so edits/revocations
  apply without a restart.
- `AUTH_COOKIE_SECURE` (default `true`; set `false` only on `http://localhost` dev / isolated LAN —
  emits a loud boot warning), `AUTH_SESSION_TTL_SECONDS` (default 43200 = 12 h, absolute).
- `ALLOWED_ORIGINS` — **strict** comma-separated browser-Origin allow-list (CSWSH/CSRF defence): an
  **absent** Origin is rejected on `/auth` + `/live`; empty + non-anon ⇒ loud boot warning (rejects
  all browser clients).
- `ALLOW_ANONYMOUS_LIVE=true` + `ANON_SESSIONS` (comma list) — isolated-LAN bypass only: skips login
  for the **live pitch**, and only for the listed sessions (never wildcard). It is **not** a general
  read bypass: `/roster` (names), `/history` (bulk raw location) and `/events` answer **403
  `login_required`** to the anon principal — only `/live`, `/sessions`, `/auth/me` and `/config`
  (one age-band enum) are open. Signing in on such a stack is optional and still works:
  `currentPrincipal` resolves the cookie first and falls back to the anon principal, so a coach who
  logs in gets their real identity and is named in the audit log. Loud boot warning +
  `ft_anon_mode_active=1`.
- `PUBLIC_HOST` — the bind interface. Defaults to `0.0.0.0`, but to **`127.0.0.1` whenever
  `ALLOW_ANONYMOUS_LIVE=true`**: a feed that needs no login must not also be LAN-reachable, and an
  Origin allow-list cannot substitute (it is CSWSH defence, and an absent Origin — what every
  non-browser client sends — can't be authenticated). Override it where something else confines the
  port, such as a container whose published port is pinned to loopback; that combination logs a loud
  warning.
- Login DoS controls: `AUTH_LOGIN_BURST` (5) / `AUTH_LOGIN_WINDOW_S` (30) per-IP bucket,
  `MAX_INFLIGHT_LOGINS` (4) concurrent-hash cap, `AUTH_MAX_SESSIONS_PER_USER` (8) per-account session
  cap (so one principal can't evict another's sessions), `AUTH_MAX_SESSIONS` (1000) global backstop.
  The per-username failure soft-lock is detect-don't-deny (signals `429` on repeated wrong attempts +
  a WARN log, but never refuses the correct password) — so it can't be abused to lock a coach out of
  a live match.
- `TRUST_PROXY` (default `false`) — the login rate-limiter keys on the **socket peer** (unspoofable)
  by default. Set `true` **only** behind a single trusted reverse proxy (Caddy) that appends the real
  client to `X-Forwarded-For`; the server then uses the rightmost XFF hop. Leaving it false anywhere
  a client can reach the port directly prevents an attacker spoofing `X-Forwarded-For` to dodge the
  per-IP login throttle.

Provision a coach (the running server picks it up within `AUTH_ACCOUNTS_RELOAD_SECONDS`; password via
stdin or a hidden TTY prompt — never a process argument):

```
bun run auth-user.ts add coach --role coach --sessions test   # also: remove <user> | list
```

Login flow: `POST /auth/login {username,password}` (present allow-listed `Origin` required) →
`Set-Cookie` + `{username,role,sessions,wildcard,anonymous,csrf}` (no token in the body) → the client
opens `/live?sessionId=…` **same-origin** and the cookie rides the upgrade. The client must therefore
be served from the relay origin — **Vite proxy in dev, Caddy in prod** (cookie-on-upgrade is
same-origin-only). `POST /auth/logout` (header `X-CSRF-Token`) deletes the token server-side, so a
replayed cookie is rejected.

Endpoints: `/live` (WS, cookie-authed), `/auth/login`, `/auth/logout`, `/auth/me`, `/sessions` on
`PORT`; `/health` (readiness) + `/metrics` (Prometheus) on `METRICS_PORT`, **bound to 127.0.0.1**.
Logs are structured JSON.

## The test gate, suite by suite

**All of the suites below run in one command** — `bun run test` (32 suites, ~64 s, sequential).
That is the gate CI runs; the individual commands are for working on one area at a time.

```
bun run test/e2e.ts              # asserts fan-out, fix<2 drop, sqlite persist
bun run test/mosquitto-pub-demo.ts   # the literal mosquitto_pub -> WS path from the root README
bun run test/retention.ts        # 30-day purge, per-player erasure, byte-level secure_delete
```

Auth & access control (Phase 2 — see [the contract](../docs/frontend/phase-2-auth-contract.md),
[ADR-0015](../docs/decisions/0015-frontend-auth-transport.md)):

```
bun run test/auth-e2e.ts         # cookie login → session-bound /live authz, logout revocation, reload revocation
bun run test/ws-origin.ts        # CSWSH: forged/absent Origin rejected, allow-listed Origin + cookie admitted
bun run test/auth-loader.ts      # accounts-file fail-closed loader (malformed/oversize/dup-username/bad-hash)
bun run test/auth-dos.ts         # /auth/login DoS guards: 415 / 413 / 429 / 503
bun run test/auth-cli.ts         # auth-user.ts add/remove/list (mode 0600, argon2id verify, no plaintext leak)
```

Identity, device-health & review/replay (Phase 3 — names, a second `/live` health envelope, off-loop
history; see [the contract](../docs/frontend/phase-3-contract.md),
[ADR-0016](../docs/decisions/0016-player-name-roster.md),
[ADR-0017](../docs/decisions/0017-review-replay-data-source.md)):

```
bun run test/roster-loader.ts    # fail-closed roster loader (missing/oversize/malformed/dup-id), no name in any log
bun run test/roster-cli.ts       # roster-user.ts set/remove/list (mode 0600, no name leaked on a validation error)
bun run test/roster-e2e.ts       # GET /sessions/:id/roster authz matrix + per-principal 429 + no-store + no name leak
bun run test/erasure-e2e.ts      # right-to-erasure: roster set -> purge-player -> rosterEntriesErased + DB rows + file
bun run test/erasure-audit.ts    # the five audit-2026-08-03 §4.5 erasure defects stay fixed
bun run test/boundary.ts         # wire fields coerced, env knobs fall back loudly, metrics never non-finite, labels capped
bun run test/history.ts          # GET /sessions/:id/history: aggregate/raw correctness, composite cursor, DoS gates, SLO
bun run test/history-e2e.ts      # live history endpoint: authz, rate-limit/inflight caps, opaque errors, no-store
bun run test/device-health-e2e.ts # a .../status frame -> minimised {event:'status'} on /live
bun run test/session-config-loader.ts # fail-closed age-band config loader (missing/oversize/malformed/bad-band)
bun run test/session-config-cli.ts # session-config.ts set/remove/list (mode 0600, bad band can't corrupt the file)
bun run test/config-e2e.ts       # GET /sessions/:id/config authz + {ageBand,thresholds}; unconfigured -> U14 default
```

Phase 4 (coaching metrics — [ADR-0019](../docs/decisions/0019-age-banded-zones-session-config.md))
adds youth age-banded speed zones (live colour + review breakdown), live distance/min, an
isolated-player cue, and server-side sprint + accel/decel effort aggregates; `test/history.ts` covers
the sprint/accel correctness. Set a session's age band:
`bun run session-config.ts set <sessionId> <U12|U14|U16|U19>`.

Tactical event detection (Track A — [ADR-0020](../docs/decisions/0020-tactical-event-detection.md),
[contract](../docs/frontend/event-detection-contract.md)) adds an off-loop
`GET /sessions/:id/events`: a bucketed team-shape series (centroid/compactness/hull) + heuristic
phase events (high-tempo / transition / stoppage), rendered as a review-mode timeline.
Movement-derived, **never** confirmed ball events. The inflight cap is **shared** with `/history`
(one global off-loop-scan slot):

```
bun run test/events.ts           # detectors (boundaries + geometry) + readEvents (bucketing, player cap, final flush)
bun run test/events-e2e.ts       # endpoint authz (no id oracle) + no-store + opaque 400 + off-loop SLO + shared cap (503)
bun run test/scan-load.ts        # the off-loop inflight cap is genuinely SHARED across /history + /events
```

## Data lifecycle CLIs

Erase one player's raw location (GDPR / lost device —
[ADR-0010](../docs/decisions/0010-location-data-retention.md)); erases the live store **and every
backup**, re-counting to prove it:

```
bun run purge-player.ts <playerId> [sessionId]   # exit 0 + JSON receipt; 3 = transient, re-run; 4 = rebuild incomplete, re-run; 5 = permanent, fix first
```

Backups are verified `VACUUM INTO` copies with rotation bounded by both `BACKUP_KEEP` and
`RETENTION_DAYS` ([ADR-0025](../docs/decisions/0025-operability-lifecycle.md)):

```
bun run backup     # backup-db.ts: one verified copy + rotation (--list, --no-rotate, --rotate-only)
```

## The simulator — a virtual device fleet (no hardware)

[`test/simulate.ts`](test/simulate.ts): N MQTT clients publishing the **exact** firmware wire
contract (10 Hz telemetry + 5 s status) with believable movement around the pitch, so the real
server + coach view run unchanged.

```
bun run sim                                          # attach to a broker+server you already run
bun run sim --standalone --players 10                # turnkey: spawn its own broker + server
bun run sim --standalone --players 8 --faults --duration 30   # inject bad fixes / OOR / id-mismatch / rate bursts / dropouts
bun run sim --standalone --ramp 10,30,50 --stage-seconds 15   # load ramp; prints ingest p99 + drop rate per stage
bun run sim --standalone --secure --players 10 --faults       # + auth: per-player MQTT creds + %u ACLs + a named coach login
bun run sim --standalone --faults --duration 20 --record /tmp/run.ndjson   # capture the published stream
bun run sim --standalone --replay /tmp/run.ndjson             # re-publish it with the original timing (deterministic)
```

In `--standalone` it prints the exact same-origin `VITE_PROXY_TARGET=… bun run dev` line to open the
coach view against the spawned stack. On stop it scrapes `/metrics` and reports what the server
actually saw (received / published / drops-by-reason / p99 / RSS). `--secure` provisions per-player
MQTT accounts (username == `playerId`) + topic ACLs exactly like the e2e (confirming the broker
blocks cross-player spoofing) **and** a named coach login so the coach view exercises the real
Phase-2 cookie auth; otherwise `/live` runs in the isolated-LAN anonymous posture scoped to
`ANON_SESSIONS` (dev only, no login). The coach account (`coach` / `sim-coach-pw`, assigned to the
run session) is provisioned in **both** postures — under `--secure` it is the only way in; in the
anonymous posture it is optional and buys names + Review, which the anon principal no longer
receives. `--record`/`--replay` reproduce an identical run for repeatable debugging.
