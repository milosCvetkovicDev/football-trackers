# Observability

How we see what the system is doing — live, during a session, across ten wearables, a broker, an
ingest process, and a coach tablet. The driving question is operational, not academic:

> **"Player 7's dot is frozen. Is the tracker dead, out of battery, off WiFi, getting a bad GPS fix,
> or is the server dropping packets?"** — and we should be able to answer it in seconds, from data.

A QoS0, 10 Hz, battery-powered, field-deployed pipeline fails in a dozen quiet ways. Observability
here is a first-class feature, not an afterthought, and — like the rest of the project — it is
**self-hosted and fully owned** (no SaaS, no per-seat telemetry bill), consistent with
[NFR-OWN-1](../requirements/non-functional-requirements.md).

---

## The four pillars

| Pillar | What | Where it lives |
|---|---|---|
| **Metrics** | Prometheus counters/gauges/histograms on `GET /metrics` | [`server/src/metrics.ts`](../../server/src/metrics.ts) |
| **Logs** | Structured JSON (ndjson), one event per line, level-gated | [`server/src/log.ts`](../../server/src/log.ts) |
| **Health** | Liveness + readiness on `GET /health` | [`server/src/server.ts`](../../server/src/server.ts) |
| **Device self-telemetry** | The wearable reports its own health on a `.../status` topic | [`firmware/src/main.cpp`](../../firmware/src/main.cpp) |

The fourth pillar is the one most DIY systems miss. The server can only see packets that *arrive*; it
is blind to *why* they stopped. So each wearable publishes a low-rate health frame — battery, WiFi
RSSI, free heap, flash-backlog size, fix quality, device-side publish/stash counters — and the
ingest turns it into per-player metrics. That is what makes "dead battery vs weak WiFi vs bad fix"
answerable.

---

## Signal flow

```
[wearable ESP32]                         [Bun/Elysia server]                 [Prometheus]   [Grafana]
 ├─ telemetry (10 Hz) ─┐                  ingest.ts:                          scrapes        dashboards
 └─ status (0.2 Hz) ───┤── MQTT ──▶  parse/validate/enrich ──▶ metrics.ts ──▶ /metrics ─────▶ + alerts
   battery, rssi, heap,│                  counts, latencies,    (registry)     every 5–15s
   backlog, fix, pub/  │                  per-player gauges
   stash counters      │                  │
                       │                  ├─▶ bun:sqlite (timed, error-counted)
                       │                  └─▶ WS fan-out ──▶ [coach tablet]
                       │                       (ws_clients, ws_sent)
              structured JSON logs ──▶ stdout ──▶ (optional) Loki/Vector
```

Metrics are the primary signal (cheap, aggregatable, alertable). Logs are for the post-mortem detail
a counter can't hold. Health is for liveness probes and the e2e readiness gate.

---

## Metric catalogue

All metrics are prefixed `ft_`. Labels are deliberately **low-cardinality** — `session`, `player`,
`reason` — and the player count per session is bounded (≤ ~20), so there is no label explosion.

**Label caps (audit S-5).** The broker ACL scopes a device to its own `player` id but leaves the `session` topic
segment as `+`, so one device could mint a fresh `{session}` series per publish (200 garbage publishes → 201
series). Each label name admits a bounded number of distinct values per process — `session` ≤ 32, `player` ≤ 256 —
and everything else reads as one `_other` bucket. **Admission is a privilege** (`server/src/metrics.ts`): the
sessions the configuration names (`ANON_SESSIONS`, the roster, session-config, account assignments) are seeded at
boot and can never be displaced, and beyond that only *fully validated* traffic (a frame that passed coercion and
the rate limit, or an authorized WS join) claims a slot — junk publishes, however many, stay in `_other`
(`capLabelPeek` never reserves). One visible consequence: the FIRST valid packet of a brand-new stream is counted
in `ft_telemetry_received_total` under `_other` (it fires before its own validation admits the label) — a
one-packet blur; `published` and every gauge use the admitted label exactly. A real squad never approaches the
caps; a flood shows up as `_other` growing. The ingest rate-limit buckets are swept once idle long enough to have
fully refilled (≥ `INGEST_BUCKET_IDLE_MS`, default 60 s).

**Wire boundary (audit S-1/S-2).** Every device frame is validated field by field before it becomes a row, a WS
frame or a sample (`server/src/wire.ts`): telemetry fields must be finite JSON numbers **within physical ranges**
(`spd ≥ 0`, `hdg` 0–360, `fix` an integer 0–5, `sats` 0–128, `pdop` 0–100, `ts ≥ 0`) and ids bounded strings —
anything else is `ft_telemetry_dropped_total{reason="bad_payload"}`; frames over 1 KiB are `too_large` (the server
enforces the shipped broker's `message_size_limit` itself). A status frame needs a numeric `up ≥ 0`; every other
field takes a sentinel when missing, invalid **or physically impossible** (a wrapped `pct` of 250 must not read
healthy): `pct → -1`, `batt → 0`, and `rssi → -127` — deliberately not 0, which is the *strongest* possible signal
and would render a signal-less device as a green card; `-127` classifies as **bad**, so the coach investigates.
The registry itself refuses non-finite values as a last line of defence (a string `fix` of
`3\nft_injected_metric 999` once forged a metric line and `undefined` once broke the whole scrape).

### Pipeline
| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `ft_telemetry_received_total` | counter | session, player | Packets received from MQTT |
| `ft_telemetry_replayed_total` | counter | — | Accepted fixes whose GPS time predates arrival by >5 s — backlog replay after an outage (Phase 4) |
| `ft_telemetry_dropped_total` | counter | reason | Dropped pre-fan-out: `bad_topic`, `too_large`, `bad_json`, `bad_payload`, `id_mismatch`, `out_of_range`, `rate`, `no_fix`, `duplicate` (a crash-mid-flush re-send, already stored) |
| `ft_telemetry_published_total` | counter | session | Fanned out to WS rooms |
| `ft_ingest_duration_seconds` | histogram | — | Server-side time: receipt → persisted → fanned out |
| `ft_db_write_duration_seconds` | histogram | — | SQLite insert latency |
| `ft_db_errors_total` | counter | — | Failed inserts |

### Data quality & freshness (per player)
| Metric | Type | Meaning |
|---|---|---|
| `ft_fix_type` | gauge | Last fix type (0 none / 2 2D / 3 3D) |
| `ft_satellites` | gauge | Last satellites-in-view |
| `ft_pdop` | gauge | Last positional DOP (lower is better) |
| `ft_player_last_seen_timestamp_seconds` | gauge | Unix time of last accepted fix → **staleness = `time() - this`** |

### Transport & fan-out
| Metric | Type | Meaning |
|---|---|---|
| `ft_mqtt_connected` | gauge | Broker link (1/0) |
| `ft_mqtt_reconnects_total` | counter | Reconnect attempts |
| `ft_ws_clients` | gauge (per session) | Connected coach tablets |
| `ft_ws_messages_sent_total` | counter (per session) | **Telemetry** envelopes pushed (meaning unchanged) |
| `ft_ws_status_envelopes_sent_total` | counter (per session) | **Device-health** envelopes pushed — the Phase 3 second `/live` envelope (`{event:'status'}`) fanned out from the `.../status` topic ([ADR-0016](../decisions/0016-player-name-roster.md) phase). The `{session}` label is safe here: a WS room already requires auth to join, so it leaks nothing a coach with that room can't see (unlike the `/roster` + `/history` request counters below, which carry **no** session label) |
| `ft_ws_rejected_total` | counter (per reason) | Rejected `/live` upgrades — `auth` / `origin` / `no_session` / `not_authorized_for_session` (principal not assigned to the requested session, [ADR-0015](../decisions/0015-frontend-auth-transport.md)) |

### Auth & access control (Phase 2 — [ADR-0015](../decisions/0015-frontend-auth-transport.md) / [ADR-0008](../decisions/0008-authentication-access-control.md))
Named login + cookie-on-upgrade. All low-cardinality and PII-free: the `result` label is bounded
`{success|failure|throttled}` and there is **no username label** (coach usernames are audited in structured
`auth login`/`auth logout` logs, never a metric; child names appear nowhere). `/metrics` is loopback-only.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `ft_auth_logins_total` | counter | result | Login attempts by outcome: `success` / `failure` (bad creds, identical for unknown-user) / `throttled` (per-IP bucket, per-user soft-lock, or concurrent-hash cap) |
| `ft_auth_sessions_active` | gauge | — | Live auth sessions (logged-in cookie principals); falls on logout / expiry sweep / account-removal |
| `ft_anon_mode_active` | gauge | — | `1` if the isolated-LAN anon `/live` bypass is on (scoped to `ANON_SESSIONS`, never wildcard), else `0` |

> **Auth alerting / DoS-lockout note.** A children's-location feed is a brute-force and CSWSH target, so
> watch the auth signals: **alert if `ft_anon_mode_active == 1` on any internet-exposed deploy** — the
> isolated-LAN login bypass must never be live in production. A sustained `rate(ft_auth_logins_total{result="throttled"})`
> is a login flood (or a misconfigured client hammering the per-IP bucket); a rising
> `rate(ft_auth_logins_total{result="failure"})` is credential-stuffing — once a username crosses the failure
> threshold its further wrong attempts surface as `throttled` (the soft-lock is detect-don't-deny: it signals
> throttling + a WARN audit log but never refuses the correct password, so it can't lock a coach out mid-match).
> Unbounded growth in `ft_auth_sessions_active` means tokens are minting faster than they expire/log out — but
> note each account is now bounded to `AUTH_MAX_SESSIONS_PER_USER` (8) live tokens, so growth is ≈ active
> coaches × 8, well under the `AUTH_MAX_SESSIONS` (1000) global backstop. The `not_authorized_for_session` slice of
> `ft_ws_rejected_total` is an authorisation probe: an authenticated principal repeatedly trying sessions it is
> not assigned to (cross-session/club reads — STRIDE-EoP).

### Phase 3 data endpoints — roster names + review/replay history ([ADR-0016](../decisions/0016-player-name-roster.md) / [ADR-0017](../decisions/0017-review-replay-data-source.md))
The two new read endpoints are **bulk-export surfaces** — `/roster` returns child names, `/history` returns
raw children's location — so they are instrumented to make a drain *visible* and *bounded*. Every label here is
low-cardinality and PII-free: the `result`/`mode` labels are bounded enumerations, and there is **no `session`,
`player`, username, or name label on any of them** — a per-session count on the (loopback-only but
unauthenticated) `/metrics` would itself enumerate which sessions have coaches/data, and the same "no child name
in any label or HELP line" guard that holds for the rest of the catalogue holds here (verified by the e2e
`/metrics` + log scrape). Names live only in the roster store at rest and on the coach screen, never in a metric.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `ft_roster_requests_total` | counter | result | `GET /sessions/:id/roster` by outcome: `ok` / `rate_limited` (per-principal token bucket, 429) / `unauthorized` / `forbidden` / `bad_session` / `forbidden_origin` |
| `ft_history_requests_total` | counter | result | `GET /sessions/:id/history` by outcome: `ok` / `rate_limited` (429) / `busy` (inflight cap, 503) / `unauthorized` / `forbidden` / `bad_session` / `bad_params` / `forbidden_origin` / `internal` |
| `ft_history_read_seconds` | histogram | mode | Wall time of a paged history read (`mode` ∈ `aggregate` \| `raw`) — the **[ADR-0017](../decisions/0017-review-replay-data-source.md) off-the-live-loop SLO**: a read pages the index in `HISTORY_SCAN_CHUNK`-row batches and yields between them, so a long review query must not freeze live fan-out |
| `ft_history_rows_scanned_total` | counter | mode | Telemetry rows scanned by history reads — the **bulk-export volume signal** (a sudden spike against one principal is a scrape; cross-check the `history read` audit log) |
| `ft_config_requests_total` | counter | result | `GET /sessions/:id/config` (Phase 4, [ADR-0019](../decisions/0019-age-banded-zones-session-config.md)) by outcome: `ok` / `unauthorized` / `forbidden` / `bad_session` / `forbidden_origin`. The age band is config, not a name/location, so this endpoint has no rate-limit/no-store — but, like the others, **no session/player label** here. The Phase-4 coaching aggregates (zone breakdown, sprint, accel/decel) ride the existing `ft_history_*` history metrics — no new metric, and **no name/age value in any label** |
| `ft_events_requests_total` | counter | result | `GET /sessions/:id/events` (tactical event detection, [ADR-0020](../decisions/0020-tactical-event-detection.md)) by outcome: `ok` / `rate_limited` (429) / `busy` (503) / `unauthorized` / `forbidden` / `bad_session` / `bad_params` / `forbidden_origin` / `internal`. Team-aggregate surface — **no session/player/name label** |
| `ft_events_read_seconds` | histogram | — | Wall time of a paged tactical-events read — the **[ADR-0020](../decisions/0020-tactical-event-detection.md) off-the-live-loop SLO**. Shares the live event loop with `/history`, so the **inflight cap is the *shared* `scanLoad` slot** (`OFFLOOP_MAX_INFLIGHT`, default 3, history + events combined): `busy` (503) on either surface means the COMBINED concurrent-scan cap was hit |
| `ft_events_rows_scanned_total` | counter | — | Telemetry rows scanned by tactical-events reads — the **bulk-export volume signal** (same role as `ft_history_rows_scanned_total`; cross-check the `events read` audit log) |
| `ft_client_events_total` | counter | kind | **The only metric sourced from the browser** (Phase 5, audit §6 "Client": *no client observability*). `kind` ∈ `ws_gave_up` \| `ws_manual_retry` \| `render_error` \| `fetch_timeout` — a **closed vocabulary validated at the route**, so cardinality is fixed at four by construction and an unrecognised value is refused (400) rather than admitted as a new series. Deliberately **no session or player label**: which sessions have a struggling tablet is not a question `/metrics` should answer to whoever can scrape it. All four are seeded present-at-0 at boot so `increase()` can fire on the first occurrence |
| `ft_client_beacon_buckets` | gauge | — | Retained per-principal beacon rate-limit buckets — a **memory** signal. The beacon is the one limiter that admits the anonymous principal, whose key is the client IP rather than a bounded username set, so an unswept map would grow one entry per distinct source address forever. It must plateau around the number of clients reporting; a monotonic climb means the sweep stopped |
| `ft_client_beacon_requests_total` | counter | result | `POST /sessions/:id/client-beacon` by outcome: `ok` / `bad_kind` / `rate_limited` (429) / `unauthorized` / `forbidden` / `bad_session` / `forbidden_origin` / `too_large` / `bad_json` / `unsupported_media_type`. Same session gate as `/roster` + `/config`, but **strict** Origin (a POST always carries one) and a 256-byte body cap |

> **SLO / alerting note.** `ft_history_read_seconds` is the observable side of the ADR-0017 guarantee that a
> review read never stalls the shared event loop. The hard gate is the `test/history.ts` SLO case: over a
> ≥270k-row pre-seeded DB, a concurrent aggregate query must keep `ft_ws_messages_sent_total` accumulating
> throughout (the loop never freezes). Watch a rising `rate(ft_history_requests_total{result="busy"})` (concurrent
> scans hitting the inflight cap) or `rate(..{result="rate_limited"})` (one principal iterating tight) alongside
> `ft_history_rows_scanned_total` as the bulk-export / drain signal; the per-request audit log (success **and**
> reject, pseudonymous fields only — never a name) carries the `username`/`session`/`scannedRows` detail a counter
> can't hold. The `/roster` + `/history` rate-limiters are per-principal so one coach can never starve another.
> **`/events` (ADR-0020) is identical** in posture, with one sharpening: its inflight cap is the *shared*
> `scanLoad` slot, so the loop-protection bound holds across history **and** events together. Its gate is the
> `test/events-e2e.ts` SLO case — 5 concurrent scans over a ≥270k-row DB must keep `ft_ws_messages_sent_total`
> rising while the shared cap rejects the excess with `busy` (503).

### Device health (from `.../status`)
| Metric | Type | Meaning |
|---|---|---|
| `ft_device_battery_volts` / `ft_device_battery_percent` | gauge | Battery (percent `-1` if unmetered) |
| `ft_device_wifi_rssi_dbm` | gauge | WiFi signal at the wearable |
| `ft_device_free_heap_bytes` | gauge | Free heap (memory-leak / crash early warning) |
| `ft_device_uptime_seconds` | gauge | Uptime (resets reveal brown-outs/reboots) |
| `ft_device_backlog_bytes` | gauge | **Flash backlog size — rising = can buffer but can't reach broker** |
| `ft_device_boot_count` | gauge | NVS boot counter (Phase 4) — climbing with short uptimes = brownout/watchdog loop |
| `ft_device_reset_reason` | gauge | Last boot's `esp_reset_reason()` code (Phase 4): 0 unknown, 1 poweron, 3 sw, 4 panic, 5 int-wdt, **6 task-wdt (the Phase-4 watchdog fired)**, 7 other-wdt, 9 brownout; -1 = pre-Phase-4 firmware |
| `ft_device_published` / `ft_device_stashed` | gauge | Device-side cumulative publish vs stash (reset on reboot) |
| `ft_device_status_last_seen_timestamp_seconds` | gauge | Last status frame → device-silence detector |

### Retention & data minimisation (ADR-0010)
The raw store is bounded in time so a breach can't leak an indefinite trace of a child. These make the
guarantee *observable* — see [ADR-0010](../decisions/0010-location-data-retention.md) and
[`server/src/retention.ts`](../../server/src/retention.ts).

| Metric | Type | Meaning |
|---|---|---|
| `ft_oldest_raw_fix_age_seconds` | gauge | Age of the oldest raw fix still stored (0 if empty) — the **data-minimisation SLI** |
| `ft_retention_rows_purged_total` | counter | Rows the sweep deleted (seeded present-at-0 at boot, so `rate()`/"stays 0" rules bind) |
| `ft_retention_last_run_timestamp_seconds` | gauge | Unix time the sweep last ran (success **or** caught failure) — liveness |
| `ft_retention_sweep_failures_total` | counter | Sweep stages that threw (telemetry purge **and** roster prune count separately; caught; the server keeps serving) |
| `ft_retention_roster_sessions_pruned_total` | counter | Roster sessions dropped because no fix remained and the provisioning stamp aged past the window (present-at-0) |

> **Alerting note (avoids false flaps):** the oldest fix legitimately ages to `RETENTION_DAYS` **plus up
> to one sweep interval** before the next sweep removes it, so an alert needs headroom **and** a `for:`
> dwell — see the `RawDataOverRetained` rule below. Don't alert on `> RETENTION_DAYS*86400` with no
> headroom; it fires every sweep cycle.

### Process / build
`ft_process_uptime_seconds`, `ft_process_resident_memory_bytes`, `ft_build_info{version,runtime}`.

---

## The `.../status` wire contract

Topic: `football-trackers/session/{sessionId}/player/{playerId}/status` (published ~every 5 s,
best-effort — **not** backlogged, because stale health helps no one). Packet (`DeviceStatus` in
[`server/src/types.ts`](../../server/src/types.ts)):

```json
{ "id":"trk-01-AB12", "pl":"01", "ts":812345, "up":812, "heap":210400,
  "rssi":-67, "batt":3.92, "pct":68, "fix":3, "sats":11, "pub":8120, "stash":0, "backlog":0 }
```

This extends the one-pipeline/one-wire-contract rule: the firmware builds it, the server recovers
`session`/`player` with `STATUS_TOPIC_RE` and maps fields → device gauges.

---

## SLIs & SLOs

Targets for a session in progress (the only time most of these matter):

| SLI | Target (SLO) | Metric |
|---|---|---|
| **Freshness** — fixes arrive ~continuously | 99% of active players have staleness < 1.5 s | `time() - ft_player_last_seen_timestamp_seconds` |
| **Fix quality** | ≥ 95% of accepted packets `fix == 3`; median `pdop < 2.5` | `ft_fix_type`, `ft_pdop` |
| **Ingest latency** | p99 `ft_ingest_duration_seconds` < 50 ms | histogram |
| **Drop rate** (excl. `no_fix` warm-up) | < 5% | `dropped_total` / `received_total` |
| **End-to-end live latency** | < 1 s ([NFR-RT-1](../requirements/non-functional-requirements.md)) | dominated by WiFi+broker, not the in-process p99 above |
| **Battery endurance** | no device < 15% mid-session | `ft_device_battery_percent` |
| **Coverage** | no growing per-device backlog | `ft_device_backlog_bytes` |
| **Data minimisation** (ADR-0010) | oldest raw fix ≤ `RETENTION_DAYS` + 1 sweep; sweep runs hourly | `ft_oldest_raw_fix_age_seconds`, `ft_retention_last_run_timestamp_seconds` |

> Note on latency: we measure **server-side processing** latency only. End-to-end "fix age" cannot
> be computed from the device clock — `ts` is explicitly non-authoritative (the two-timestamp design
> in [CLAUDE.md](../../CLAUDE.md) / [system-architecture.md](system-architecture.md)). The sub-1 s
> NFR-RT-1 budget is mostly WiFi + broker; the in-process p99 is a small, separately-tracked slice.

---

## Alerting (Prometheus rules)

```yaml
groups:
  - name: football-trackers
    rules:
      - alert: PlayerStale          # dot frozen — no fresh fix
        expr: time() - ft_player_last_seen_timestamp_seconds > 15
        for: 10s
      - alert: DeviceSilent         # no health heartbeat — likely powered off
        expr: time() - ft_device_status_last_seen_timestamp_seconds > 20
        for: 10s
      - alert: PoorFixQuality
        expr: ft_fix_type < 3 or ft_pdop > 5
        for: 30s
      - alert: LowBattery
        expr: ft_device_battery_percent >= 0 and ft_device_battery_percent < 15
      - alert: BacklogGrowing       # buffering to flash but can't reach broker
        expr: ft_device_backlog_bytes > 0 and deriv(ft_device_backlog_bytes[1m]) > 0
        for: 30s
      - alert: HighDropRate
        expr: |
          sum(rate(ft_telemetry_dropped_total{reason!="no_fix"}[2m]))
            / clamp_min(sum(rate(ft_telemetry_received_total[2m])), 1) > 0.05
        for: 1m
      - alert: MQTTDown
        expr: ft_mqtt_connected == 0
        for: 15s
      - alert: HighIngestLatency
        expr: histogram_quantile(0.99, sum(rate(ft_ingest_duration_seconds_bucket[5m])) by (le)) > 0.05
        for: 1m
      - alert: DBErrors
        expr: increase(ft_db_errors_total[5m]) > 0
      # --- retention / data minimisation (ADR-0010): the privacy guarantee must self-report ---
      - alert: RawDataOverRetained   # children's location kept past the window
        # headroom (+1 day) absorbs the up-to-one-sweep lag; for: rides out a single late sweep
        expr: ft_oldest_raw_fix_age_seconds > (30 + 1) * 86400   # match RETENTION_DAYS
        for: 2h
      - alert: RetentionSweepWedged  # the purge job hasn't run — timer dead / never scheduled
        expr: time() - ft_retention_last_run_timestamp_seconds > 2 * 3600   # 2x sweep interval
        for: 10m
      - alert: RetentionSweepErroring
        expr: increase(ft_retention_sweep_failures_total[2h]) > 0
      # --- auth / access control (ADR-0015 / ADR-0008): the children's-location gate must self-report ---
      - alert: AnonModeOnPublicDeploy   # isolated-LAN login bypass left enabled in production
        expr: ft_anon_mode_active == 1
        for: 1m
      - alert: LoginFlood               # per-IP / per-user / concurrency throttles tripping repeatedly
        expr: rate(ft_auth_logins_total{result="throttled"}[5m]) > 0.2
        for: 5m
      - alert: AuthSessionGrowth        # tokens minting faster than they expire/log out, nearing the cap
        expr: ft_auth_sessions_active > 0.8 * 1000   # 0.8 * AUTH_MAX_SESSIONS
        for: 15m
      # --- the coach's VIEW (Phase 5, audit C-1/C-2 + §6). Everything above measures the server; these
      # are the only signals that say whether anyone can actually SEE the pitch. A dark tablet on a
      # touchline is invisible from here without them. ---
      - alert: CoachViewDark            # a tablet exhausted its reconnect budget — that coach sees nothing
        expr: increase(ft_client_events_total{kind="ws_gave_up"}[10m]) > 0
      - alert: CoachViewCrashing        # a render threw into an error boundary (kind only; never the message)
        expr: increase(ft_client_events_total{kind="render_error"}[30m]) > 0
      - alert: CoachViewReadsTimingOut  # review/roster reads hitting FETCH_DEADLINE_MS — server slow or link bad
        expr: increase(ft_client_events_total{kind="fetch_timeout"}[15m]) > 2
```

> **Why these four kinds and nothing else.** The beacon runs on a device displaying children's live
> positions, so it carries a fixed enum and a session id — no player id, no coordinates, no free text,
> no stack trace (an error message routinely interpolates whatever was being rendered). `ws_manual_retry`
> is the quiet one: it means the automatic recovery path failed a coach badly enough that they pressed a
> button, so a rise in it without a matching `ws_gave_up` says the backoff is too slow, not that the
> network is broken.

---

## The stack (self-hosted, owned)

Prometheus scrapes `/metrics`; Grafana dashboards + alerts; optional Alertmanager for
push (Telegram/email to the coach) and Loki/Vector if logs need centralising. All run locally on the
field laptop — same box as the broker and the server.

`prometheus.yml`:
```yaml
global: { scrape_interval: 5s }
scrape_configs:
  - job_name: football-trackers
    static_configs:
      - targets: ['localhost:9464']   # METRICS_PORT — loopback-only /metrics on the field box
rule_files: ['alerts.yml']
```

`docker-compose.yml` (drop next to the server):
```yaml
services:
  prometheus:
    image: prom/prometheus
    # /metrics is loopback-only on the field box, so Prometheus scrapes the host's 127.0.0.1 —
    # use host networking (Linux); the Prometheus UI is then the host's :9090.
    network_mode: host
    volumes: ['./prometheus.yml:/etc/prometheus/prometheus.yml', './alerts.yml:/etc/prometheus/alerts.yml']
  grafana:
    image: grafana/grafana
    ports: ['3001:3000']     # Grafana UI (server already owns :3000)
```

### Suggested Grafana dashboards
- **Session live**: per-player staleness heat-strip, fix type, speed, battery; squad freshness gauge.
- **Pipeline**: received/published/dropped rates, drop reasons, ingest & DB latency p50/p95/p99.
- **Devices**: battery %, RSSI, backlog bytes, uptime (reboot detector) — one row per player.

---

## Runbook — "a player's dot went stale"

Walk the signals from the edge inward:

1. **`ft_device_status_last_seen` stale too?** → the whole device is silent: powered off / crashed /
   out of WiFi range. Check `ft_device_battery_percent` (last value) and `ft_device_uptime` (did it
   reboot?).
2. **Status fresh, but `ft_player_last_seen` stale?** → device is up but not sending *fixes*:
   - `ft_device_backlog_bytes` rising → it has fixes but can't reach the broker (WiFi/broker issue);
     they'll replay on reconnect ([NFR-RES-1](../requirements/non-functional-requirements.md)).
   - `ft_fix_type < 3` / low `ft_satellites` / high `ft_pdop` → poor GPS (indoors, sky blocked).
3. **Fixes arriving but not on the tablet?** → `ft_telemetry_dropped_total{reason}` (bad payload?),
   `ft_mqtt_connected`, `ft_ws_clients` (is the coach tab even connected?), ingest latency.
4. **Whole squad stale at once?** → `ft_mqtt_connected == 0`, broker down, or AP/power on the field.

---

## Runbook — right-to-erasure / lost-device wipe (ADR-0010)

To erase one player's raw location AND their roster name (GDPR request, or a lost/stolen device):

```
# while the Docker stack is up — run it INSIDE the container, against the container's DB_PATH:
docker compose exec -T server bun run purge-player.ts <playerId> [sessionId]

# with the stack down, from the host (the store is the bind-mounted ./server/data):
cd server && DB_PATH=./data/telemetry.db bun run purge-player.ts <playerId> [sessionId]
```

It prints a JSON receipt `{erased:N, rosterEntriesErased:M, walTruncated:true, vacuumed:true, rosterFound:true, …}`
and exits 0. Ids are validated (`[A-Za-z0-9._-]{1,64}`) so a typo cannot become an "erased 0" record filed for the
real player; `rosterFound:false` means no roster file at the path the receipt names — either no names were ever
provisioned, or you ran it from the wrong cwd. **The exit code is the verdict** — read it, not the receipt's presence:

| exit | meaning | what to do |
|---|---|---|
| `0` | erased: rows deleted, roster entry removed, WAL truncated | keep the receipt as the compliance record |
| `3` | **transient** — the erasure did not complete (roster locked by a live writer, DB busy, delete failed); `erased` in the receipt is the TRUE count of rows already gone | re-run; it is idempotent |
| `4` | rows and roster entry erased but the on-disk rebuild did not complete (a reader pinned the WAL, or a live writer held the checkpoint lock — the `error` says which) — residue may remain | re-run the **same** command (idempotent) until it exits `0` |
| `5` | **permanent** — fix something, do not just retry: `DB_PATH` is the wrong file (missing, empty, not SQLite, read-only for this user), the disk is too full for the rebuild (~2.5× the store), or the roster is unreadable / malformed / unwritable / a name sits in a structure the rewrite cannot reach | fix the path, permissions, disk or file (the receipt prints the absolute paths it used and `retry:false`); retrying unchanged erases nothing, forever |

`rosterFound` is `null` on a receipt emitted before the roster was read (a lock or path problem), `false` when there
is no file at the path named. Exit `0`/`4` receipts carry `deleteMs`, `vacuumMs`, `checkpointMs`, `totalMs` and
`storeBytes` — how long the store was under the knife; on a ~1 GB store expect tens of seconds to ~2 minutes in
total (the secure-delete batches dominate, not the VACUUM), during which the live server's inserts time out.

Why the VACUUM and the checkpoint matter: `PRAGMA secure_delete` ([`db.ts`](../../server/src/db.ts)) zeroes pages
that are *freed* — but a leaf page a surviving player still occupies is rebalanced in place and keeps the erased
rows' bytes in its unused gap (the Phase 2b checker found ~0.2–0.5 % of an erased player's rows recoverable that
way in the everyday round-robin ingest layout). The CLI therefore runs `VACUUM` (every page rebuilt), then a
`wal_checkpoint(TRUNCATE)` so the rebuilt pages replace the old ones in the main file and the WAL shrinks to 0
bytes; `journal_size_limit = 0` makes every later WAL reset truncate too. **VACUUM holds the write lock for a time
proportional to store size** (the live server pauses; on a big store, seconds) — erase between sessions, not
mid-match. Before Phase 2b an erasure receipt of `{"erased":300}` left the identifier ~9,000× in the sidecar
(audit §4.5 a).

On a **Linux** host Docker creates the bind-mounted `./server/data` root-owned (the bun image runs as root), so the
host-side form fails with a read-only store (exit 5, `retry:false`) — use the `docker compose exec` form there.

To verify on disk yourself, scan the exact files as bytes and fail loudly if they are not there — a plain
`strings | grep` passes silently on a missing file and false-fails when a short id is a substring of a session id:

```
cd server && bun -e 'const fs=require("node:fs");const id=process.argv[1];const f=process.env.DB_PATH??"./data/telemetry.db";
let n=0;for(const p of [f,f+"-wal"]){if(!fs.existsSync(p)){if(p===f){console.error("no such file:",p);process.exit(5)}continue}
const b=fs.readFileSync(p);let i=b.indexOf(id);while(i!==-1){n++;i=b.indexOf(id,i+1)}}console.log(n?"RESIDUE "+n:"clean");process.exit(n?1:0)' <playerId>
```
(the gate's `server/test/erasure-audit.ts` does the same scan with long, distinctive ids).

Two residuals the CLI **cannot** reach from its separate process — clear them by hand:
1. **In-memory Prometheus series.** The running server holds per-player gauges
   (`ft_player_last_seen_timestamp_seconds{player=…}`, fix/sats/pdop, device-health) that linger until
   **restart**. They are pseudonymous and exposed only on the loopback `/metrics` port, but for a full
   wipe **restart the server** after the purge.
2. **Backups.** Any file-level copy of `telemetry.db` taken before the wipe still holds the data — purge
   or rotate backups per your retention policy.

Names also expire on their own: the retention sweep drops a roster session once none of its fixes remain
and its provisioning stamp (`sessionMeta.<id>.updatedAt`, written by `roster-user.ts set`) is older than
`RETENTION_DAYS` — counted by `ft_retention_roster_sessions_pruned_total` and logged at WARN with the session id.
A sweep tick that lands while a purge or `roster-user.ts` holds the roster lock skips that hour's prune (WARN, not a
sweep failure).
A roster entered *before* a match (no fixes yet, fresh stamp) is kept — **but the bound is real: names for a session
that never receives a fix expire `RETENTION_DAYS` after the last `set`.** Provisioning more than a month ahead?
Re-run `roster-user.ts set` closer to the date to renew the stamp. Every writer of `roster.json` (the sweep, the
purge CLI, `roster-user.ts`) takes a lock file beside it (`roster.json.lock`, holder pid inside) for the milliseconds of
the file round-trip — never across the DB delete — so no two can race. A lock whose holder is dead is broken at once;
a live holder is waited for (3 s) and then reported by pid and age.

> Aggregates and the cloud aggregate copy do not exist yet; when they land, extend `purge-player.ts` to delete
> them in the same call. Tracked in the [board review](reviews/2026-06-14-architecture-board-review.md)
> (action #3, risk #6).

---

## Logs & health

- **Logs**: ndjson via `log.{debug,info,warn,error}(msg, fields)`; level via `LOG_LEVEL`. Parseable
  as-is by Loki/Vector — no reformatting. Errors (e.g. DB insert failure) carry `session`/`player`.
- **Health**: `GET /health` (on `METRICS_PORT`, loopback-only) → `{ ok, mqtt, db, version, uptimeSeconds }` with HTTP
  **200 when `ok`, 503 otherwise**. `mqtt` follows the broker client's connect/close events (it used to latch true
  once and stay green with the broker dead — audit S-4); a hard broker death flips it in milliseconds, a
  TCP-alive-but-wedged broker within ~22 s (MQTT keepalive 15 s × 1.5). `db` probes the **telemetry table** and
  folds in the last insert outcome (a plain `SELECT 1` cannot fail with the table dropped or the disk full — a
  failed insert holds `db:false` for up to 60 s unless a later insert succeeds); honest limit: an idle server
  with an intact file reads true. `ok = mqtt && db`. The 503 is what a compose healthcheck / Playwright's
  webServer wait key on.
- **Config at boot**: one `config resolved` info line lists every env knob with the value in force (secrets
  redacted), and a `config: some env values were INVALID` warn lists any that fell back to their default — a typo'd
  `HISTORY_MAX_SPAN_MS=6h` used to parse as `NaN` and silently void the cap (audit S-3); now it is rejected loudly and
  the default is enforced (`server/src/env.ts`).

---

## Scope

**In:** metrics, structured logs, health, device self-telemetry, alerts, dashboards — verified end to
end (the e2e test asserts `/metrics` reflects the run: `server/test/e2e.ts`).

**Deliberately out (for now):** distributed tracing. Ingest is a single in-process pipeline on one
event loop; a histogram + per-stage timing already localises latency, so spans would add dependency
and overhead for little gain. Revisit if/when the persistence layer moves to TimescaleDB over the
network (a real network hop is worth a span).
