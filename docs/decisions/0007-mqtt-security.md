# ADR-0007 — MQTT security: per-device identity, topic ACLs, plaintext on an isolated LAN

**Status:** Accepted · **Implementation:** per-device creds + topic ACL + `id_mismatch` reject **shipped** 2026-06-14 (e2e-verified); firmware loads its creds from NVS, not source, via [ADR-0014](0014-firmware-secret-provisioning.md); broker TLS-PSK deferred behind the [ADR-0013](0013-field-network-security.md) triggers · **Date:** 2026-06-14

## Context
Wearables publish telemetry to mosquitto over the field WiFi. Threats: a forged/compromised device spoofing
**another** player, eavesdropping, and unauthorised publish. The counter-pressure is the ESP32: TLS to a
public broker costs heap/CPU/battery at 10 Hz, and the [relay design](0006-local-core-cloud-relay.md) means
the broker is **never** internet-facing.

## Decision
- **Per-device credentials** (username/password or client cert) — no shared secret across wearables;
  provisioned at flash time with `PLAYER_ID`.
- **Topic ACLs:** device `p07` may publish only to `football-trackers/session/+/player/p07/#`; cannot publish
  as another player.
- **Server-side identity reconciliation:** `ingest.ts` trusts the **topic-derived** session/player and rejects
  packets whose body `pl`/`id` disagree (new counted drop reason `id_mismatch`).
- **Transport:** **plaintext on the isolated field LAN** (LAN trust boundary; devices can't reach the
  internet). Broker TLS (server cert/PSK) is optional, only if the LAN is shared/untrusted.

## Consequences
- **+** A compromised device can spoof only itself; identity can't be forged past the broker ACL + server check.
- **+** Avoids ESP32 TLS cost entirely while the broker stays off the internet.
- **+** No new wire-contract fields; reconciliation reuses the existing topic-regex recovery.
- **−** Plaintext on the LAN means an attacker *on the field LAN* could sniff/inject — mitigated by LAN
  isolation; broker TLS is the documented upgrade if that assumption breaks.

## Alternatives considered
- **mTLS / TLS-PSK on every device** — rejected for MVP: heap/battery cost at 10 Hz for a threat the LAN
  boundary already covers; kept as the upgrade path for an untrusted LAN.
- **One shared broker credential** — rejected: a single leak compromises all devices and enables spoofing.
