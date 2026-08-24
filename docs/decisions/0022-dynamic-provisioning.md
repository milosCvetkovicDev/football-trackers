# 22. Dynamic device provisioning: NVS broker host + mDNS + captive-portal Wi-Fi setup

Date: 2026-06-17

> **Amended (audit Phase 4, 2026-08-24):** the setup portal and the serial console now also collect a
> per-fixture **Session ID** (`session_id` in NVS, mirroring `mqtt_host`'s default-with-override pattern) —
> see audit F-6 and firmware/README.md. Player/session ids are validated to `[A-Za-z0-9._-]{1,64}` at
> enrollment (audit F-3).

## Status

Accepted — implemented and **verified on real hardware 2026-06-17** (mDNS resolve + connect, captive-portal AP
lifecycle, regression). Extends [ADR-0014](0014-firmware-secret-provisioning.md) (NVS secrets via serial enroll).

## Context

The first bring-up exposed two friction points:
- **Broker address was compiled in** (`MQTT_HOST` in `main.cpp`), so pointing a device at a different broker
  (home Mac vs field AP) meant a firmware edit + reflash. The Mac's DHCP IP also changes between networks.
- **Provisioning was serial-only** (the `enroll` console) — fine for a bench with a USB cable, but not for a
  non-technical operator setting up devices at a pitch.

The coach app cannot provision the device's Wi-Fi (the device is unreachable from the app until it is already
online — chicken-and-egg), so any "pick a network" UI must live on the device.

## Decision

Three additive firmware capabilities (all on built-in ESP32 networking — `WebServer` / `DNSServer` / `ESPmDNS`,
**no new library**):

1. **`mqtt_host` in NVS** (optional; falls back to the compiled `MQTT_HOST`). Settable via `set host …` and the
   portal — change the broker **without a reflash**.
2. **mDNS broker resolution** — a `name.local` host is resolved via Bonjour/mDNS to an IP at connect time. So the
   same device finds the broker on **any shared network** (home Wi-Fi, field AP, hotspot) **with no IP edit and no
   reflash** — only the Wi-Fi selection changes. A literal IP/hostname is passed through unchanged.
3. **Captive-portal Wi-Fi setup** — on first boot (or the `portal` serial command) the device raises a
   WPA2 setup AP `ft-setup-XXXX` (fixed printed password). A phone connects, a captive page **scans + lists**
   nearby Wi-Fi, the operator picks one and enters Wi-Fi password / player id / MQTT password / broker host, and
   Save writes NVS + reboots. It runs **concurrently with the serial console** (the console's line-wait pumps the
   portal); whichever path saves, the device reboots. `quit` on a configured device tears the portal down.

## Consequences

- **+** Broker + Wi-Fi are runtime-configurable; no reflash to move a device between networks.
- **+** With an mDNS `name.local` host, home↔field is seamless (re-pick Wi-Fi only).
- **+** Phone-based setup for non-technical operators; serial path retained (pipe-friendly provisioning unchanged).
- **+** No new dependency (built-in ESP32 libs); +~5% flash.
- **−** A WPA2 setup AP is briefly exposed during provisioning (fixed password, printed to serial) — acceptable
  as it is only up while un-provisioned or during an explicit `portal`. Per-device secrets still live in NVS
  ([ADR-0014](0014-firmware-secret-provisioning.md)).
- **−** mDNS depends on the broker host advertising its `.local` name (macOS/Bonjour does automatically; a Linux
  field box needs Avahi). A literal IP is the fallback.

## Alternatives considered

- **WiFiManager library** — rejected: an extra dependency; the project's ethos is minimal deps / own the stack,
  and a hand-rolled portal keeps the existing NVS scheme as the single source of truth.
- **Provision Wi-Fi from the coach app** — impossible: the device isn't reachable from the app until it is online.
- **Keep the hardcoded IP** — the status quo; requires a firmware edit + reflash per network (what we replaced).

## References
- [ADR-0014](0014-firmware-secret-provisioning.md) — NVS secrets + serial enrollment (extended here).
- [ADR-0013](0013-field-network-security.md) — the field Wi-Fi network this enables seamless movement onto.
- [local-bench-runbook](../dev/local-bench-runbook.md) · [firmware/README](../../firmware/README.md).
