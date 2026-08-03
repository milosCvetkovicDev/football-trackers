# 21. Local dev stack: Docker Compose backend + host-run coach view

Date: 2026-06-17

## Status

Accepted — used for the first real-device end-to-end bring-up (2026-06-17). See
[local-bench-runbook](../dev/local-bench-runbook.md).

## Context

Bringing a real wearable online needs the whole backend running and reachable from the device: an MQTT broker,
the Bun ingest/WS server, and the coach view. Manually starting mosquitto + server + Vite with the right env each
time is error-prone, and the broker must be reachable from the device over Wi-Fi. We want a one-command local
stack that mirrors production's shape without its security (field AP + Caddy + real auth).

Two constraints surfaced during the first bring-up:
- **The host already runs other Docker stacks** that hold ports 3000–3003, so our server can't
  publish on 3000.
- **Vite's `/live` WebSocket proxy does not reliably relay the upgrade when Vite runs inside a container** — the
  server accepts the upgrade (logs `ws open`) but the browser hangs at "connecting". A direct WS to the server
  container works; the same Vite proxy works when Vite runs on the host (the long-standing Playwright topology).

## Decision

Provide [`docker-compose.yml`](../../docker-compose.yml) running **two services — `mosquitto` + `server`** — plus
a mounted broker config. The **coach view (Vite) runs on the host**, not in the stack:

```
docker compose up -d
cd client && VITE_PROXY_TARGET=http://localhost:3007 bun run dev   # http://localhost:5173
```

- Broker published on `1883` (the device reaches it at the Mac's Wi-Fi IP).
- Server published on **`3007`** (not 3000 — taken by other host containers) for the host Vite to proxy to;
  internally the server still listens on 3000.
- Broker is **anonymous**; server runs in **isolated-LAN anon mode** (`ALLOW_ANONYMOUS_LIVE` + `ANON_SESSIONS=test`).
- Pinned images (`eclipse-mosquitto:2`, `oven/bun:1.3`), per the repo's CI/CD docker guardrails.

> **Amended 2026-08-03 — the two security bullets above no longer describe the stack.** The
> [production-readiness audit](../audit/2026-08-03-production-readiness.md) proved both of them exploitable
> *live* on this stack (§4.6, §4.1): an anonymous LAN broker let any host on the Wi-Fi read every child's 10 Hz
> feed or publish forged telemetry the server accepted and persisted as authoritative, and the `0.0.0.0:3007`
> publish put a named child's live position and location history one `curl` away for anything on the subnet —
> while §2 of this very ADR tells the operator to disable Wi-Fi client isolation. Neither was an acceptable
> isolated-LAN trade, because the network this runs on is a home Wi-Fi with guests on it, not an isolated one.
> Changed in Phase 2:
> - the broker mounts [`server/mosquitto/`](../../server/mosquitto/README.md) — the **same authenticated config
>   and per-device ACLs as the field broker**. `deploy/mosquitto/mosquitto.conf` (the anonymous one) is deleted.
>   `./server/mosquitto/dev-provision.sh` creates the accounts; without it compose refuses to start.
> - the server is published on **`127.0.0.1:3007`**, and the server itself defaults to a loopback bind whenever
>   anon mode is on (`PUBLIC_HOST`). The container opts out explicitly, because inside its own namespace the
>   exposure boundary is the publish.
> - anon mode is scoped to the **live pitch**: names and bulk history need a real login even here.
>
> The consequence the original decision did not state: **the coach view is now this-machine-only.** A second
> tablet on the Wi-Fi cannot reach it. That is the correct posture for a stack with no login, and a pitch-side
> tablet is the Caddy + real-auth deployment instead.

The device side needs one firmware edit for the bench — `MQTT_HOST` → the Mac's Wi-Fi IP (field default stays
`192.168.4.1`) — and the device + Mac must share the Wi-Fi (a wired dock Ethernet was isolated from the Wi-Fi).

## Consequences

- **+** One command brings up the device-facing backend; mirrors the production pipeline shape; reproducible.
- **+** Keeps the working WS path (Vite on host) rather than shipping a broken in-container coach view.
- **−** The coach view isn't containerized — a deliberate split (the in-container Vite WS proxy limitation).
- **−** `MQTT_HOST` is compiled into the firmware (no NVS/env override), so the bench needs a one-line edit +
  reflash; and the Mac's DHCP Wi-Fi IP can change.
- **Security:** ~~anonymous broker + anon live mode are acceptable ONLY on an isolated LAN~~ — see the amendment
  above; both were closed in Phase 2 after being demonstrated against this stack. Anon live mode survives, now
  loopback-bound and scoped to the pitch. Never internet-exposed.
  Production keeps the field AP + per-device MQTT auth + cookie auth ([ADR-0007](0007-mqtt-security.md),
  [ADR-0008](0008-authentication-access-control.md), [ADR-0013](0013-field-network-security.md),
  [ADR-0015](0015-frontend-auth-transport.md)).

## Alternatives considered

- **Coach view in the compose stack too** — rejected: the in-container Vite `/live` WS proxy hangs (see Context).
- **Broker native (brew) instead of containerized** — viable, but Compose keeps broker + server lifecycle in one
  place; the broker-in-Docker published port IS reachable from the LAN device (verified), so no need.
- **Map the server to host 3000** — rejected: held by other local containers; used 3007.
- **A phone hotspot to avoid Wi-Fi isolation** — kept as a fallback in the runbook when the router isolates clients.
