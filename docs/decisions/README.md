# Architecture Decision Records

Key decisions behind football-trackers, with context and rationale. Captured from the original
requirements discussion (June 2026).

| ADR | Decision |
|---|---|
| [0001](0001-build-vs-buy.md) | Build a DIY system instead of using a commercial tracker |
| [0002](0002-wifi-vs-ble-transport.md) | WiFi (not BLE) as the field transport |
| [0003](0003-realtime-vs-store-and-sync.md) | Real-time streaming (not store-and-sync) |
| [0004](0004-wearable-hardware-baseline.md) | ESP32 (WEMOS Lite) + NEO-M8N wearable baseline |
| [0005](0005-technical-metrics-sensor-strategy.md) | Leg IMU and/or camera CV for technical metrics |
| [0006](0006-local-core-cloud-relay.md) | Local core + cloud relay; devices never face the internet |
| [0007](0007-mqtt-security.md) | Per-device MQTT identity + topic ACLs; plaintext on an isolated LAN |
| [0008](0008-authentication-access-control.md) | Auth: argon2 + session cookies, roles, mTLS for the field↔relay link |
| [0009](0009-tls-edge-caddy.md) | Caddy as the TLS-terminating edge (auto-HTTPS, only :443 public) |
| [0010](0010-location-data-retention.md) | 30-day local retention + erasure; cloud holds aggregates only |
| [0011](0011-persistence-engine-threshold.md) | Keep bun:sqlite; swap to TimescaleDB only on a trigger |
| [0012](0012-overlay-network-for-remote-access.md) | Overlay network (WireGuard/Tailscale) for Profile-B remote access; defer the bespoke relay |
| [0013](0013-field-network-security.md) | One dedicated, internet-isolated WPA2 AP for match day; broker TLS-PSK deferred behind triggers |
| [0014](0014-firmware-secret-provisioning.md) | Per-device firmware secrets in NVS, set by a serial enrollment console (one shared image) |
| [0015](0015-frontend-auth-transport.md) | FE auth: cookie-on-upgrade + principal-bound session authz; reject the bundle-baked token |
| [0016](0016-player-name-roster.md) | Player names via an authenticated per-session roster; location stores stay pseudonymous |
| [0017](0017-review-replay-data-source.md) | Post-match review/replay: one renderer, history read off the live loop |
| [0018](0018-live-position-smoothing-honesty.md) | Live position smoothing with a strict interpolation honesty rule (no fabricated positions) |
| [0019](0019-age-banded-zones-session-config.md) | Youth age-banded speed zones from a per-session server config store (single source of truth) |
| [0020](0020-tactical-event-detection.md) | Tactical event detection from GPS (Track A: movement-derived phases); ball events (passes/shots) deferred (Track B) |
| [0021](0021-local-dev-docker-stack.md) | Local dev stack: Docker Compose backend + host-run coach view |
| [0022](0022-dynamic-provisioning.md) | Dynamic provisioning: NVS broker host + mDNS (`name.local`) + captive-portal Wi-Fi setup |
| [0023](0023-camera-cv-offline-analysis.md) | Offline camera/CV match analysis (`vision/`, build-spec form): realises Track B / Path 2; prototyped on public footage, youth-footage gate deferred |

Format: Context → Decision → Consequences → Alternatives considered.

ADR-0006–0014 realise the [target architecture](../architecture/target-architecture.md) (security + dual
deployment profile) derived from the [architecture brief](../architecture/architecture-brief.md) and the
[architecture board review](../architecture/reviews/2026-06-14-architecture-board-review.md). 0012 (overlay)
amends 0006; 0013 was decided by a field-network expert panel; 0014 closes 0013's hard gate.
ADR-0015–0018 come from the [FE improvement panel](../frontend/improvement-plan.md) (six experts + adversarial
verification): 0015 implements 0008 for the browser; 0016 extends 0010's pseudonymity to name display; 0017
reuses the 30-day raw store (0010) for review without stalling live ingest; 0018 governs honest motion.
ADR-0019 (Phase-4 coaching metrics) sources youth zone thresholds per session; 0020 adds GPS-only tactical event
detection (Track A) and scopes the ball-event sensing (Track B); 0021 is the local Docker dev/bench stack used for
the first real-device bring-up ([local-bench-runbook](../dev/local-bench-runbook.md)).
ADR-0023 realises 0020's deferred Track B / 0005's camera Path 2 as a standalone offline `vision/` CV subproject
(Veo/Trace-style player+ball tracking → top-down radar + stats), prototyped on **public** footage only; it
**inherits, does not discharge**, 0020 §6's child-video DPIA — the real-youth-footage gate stays deferred to a future ADR.
