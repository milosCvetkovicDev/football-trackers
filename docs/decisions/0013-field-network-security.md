# ADR-0013 — Match-day field network: one dedicated, internet-isolated WPA2 AP

**Status:** Accepted · **Implementation:** not yet procured · **Date:** 2026-06-14 · **Decided by:** field-network expert panel (3 advisors + chair)

## Context
[ADR-0007](0007-mqtt-security.md) accepts **plaintext MQTT on the LAN**, but that trade is only sound if the
field LAN is genuinely isolated and trustworthy. The owner did not know what AP to use and delegated the
decision to an expert panel (wireless-security, field-ops/Serbia-sourcing, security-integration). All three
converged on the same answer.

## Decision
**One dedicated, internet-isolated, single-purpose outdoor 2.4 GHz WPA2-PSK-AES access point** — "one dumb
closed AP, configured once, sticker on it." It is the **outer ring** of defence-in-depth; the load-bearing
inner controls are the per-device MQTT creds + topic ACLs + `id_mismatch` reconcile ([ADR-0007](0007-mqtt-security.md))
and the WS auth ([ADR-0008](0008-authentication-access-control.md)).

- **Hardware:** MikroTik **wAP 2nD (RBwAP2nD)**, 2.4 GHz-only, weatherproof, includes PoE injector, ~€45–55
  (uspon.rs / jakov.rs). Powered from the field box PoE or a 12 V battery via the bundled injector (no mains).
  Acceptable equivalents: any outdoor 2.4 GHz WPA2-AES AP with client-isolation + WPS-disable (TP-Link
  EAP110-Outdoor / Cudy / OpenWrt unit, ~€25–70). **Not** 5 GHz-only units (ESP32 is 2.4 GHz). See
  [hardware-bom.md](../architecture/hardware-bom.md).
- **Settings:** WPA2-PSK **AES/CCMP only** (no TKIP, no WPA3/mixed transition); a **20+ char random PSK** from
  a password manager (never a club name/date/`changeme`); **client isolation ON** (verify the device→broker
  path still works); boring non-attributable SSID (e.g. `net-7f3a`, not the club name); **no internet uplink**
  of any kind; fixed clear channel 1/6/11 at 20 MHz; tight DHCP pool; lock the admin plane (change default
  password, disable WPS/UPnP/cloud-admin); update AP firmware once.
- **Broker TLS:** **deferred** ([ADR-0007](0007-mqtt-security.md)) — but use **TLS-PSK** (cheap on ESP32, not
  full mTLS) the moment any trigger fires (see below).

## Consequences
- **+** Makes ADR-0007's "isolated, trustworthy LAN" assumption *literally true*, which is the precondition the
  plaintext-MQTT trade rests on — for ~€85–120 one-off, one-person-operable.
- **+** Internet-isolated + non-identifying SSID removes remote attack surface and lowers evil-twin lure.
- **−** Shared WPA2 PSK across all wearables is a single point of failure (a lost device leaks the key) →
  contained by per-device MQTT ACLs + the rotation playbook, not eliminated.
- **−** Single AP/battery is a liveness SPOF (data is not lost — LittleFS backlog replays); carry spares.

### Broker-TLS-PSK triggers (record verbatim; any one flips it to required-now)
1. the AP is ever shared with other traffic or given any internet uplink;
2. you must run on venue/guest WiFi you don't control, or an AP without working client isolation;
3. you cannot guarantee a strong, unique, uncommitted PSK (e.g. a lost-device incident makes rotation impractical);
4. a credible **targeted** threat to a specific child (known stalker / harassment).

### Lost/stolen wearable playbook
Rotate the AP PSK (+ re-flash remaining devices) **and** independently revoke that device's MQTT credential +
ACL on the broker; record the `PLAYER_ID`/MAC as decommissioned. A stolen PSK grants WiFi association, **not**
data access (the inner per-device auth + WS auth still gate location). Routine cadence: rotate on any device
loss, on roster/season turnover, or at least once per season.

## Hard gate (non-negotiable, from the board's critical risk #1)
Plaintext-on-LAN must **not** go live with real children until ALL of the following hold:
1. the [ADR-0007](0007-mqtt-security.md) / [ADR-0008](0008-authentication-access-control.md) auth controls are
   merged;
2. the firmware `WIFI_PASS="changeme"` placeholder is removed — WiFi PSK + per-device MQTT creds load from NVS,
   not committed source ([ADR-0014](0014-firmware-secret-provisioning.md));
3. **recovered-device exposure is consciously resolved** — either ESP32 flash encryption is enabled so a
   lost/stolen wearable's flash cannot be dumped, **or** that residual risk is explicitly accepted in writing.
   NVS-not-in-source stops the repo/artifact leak but **not** a physical flash dump (`esptool` over USB
   recovers plaintext NVS in seconds); and because the WPA2 PSK is **shared** across wearables (see
   Consequences), one recovered device leaks the whole fleet's WiFi until the PSK is rotated.
   See [ADR-0014](0014-firmware-secret-provisioning.md).

> **Status (2026-06-14):** (1) shipped earlier. (2) **closed** — WiFi PSK + per-device MQTT creds load from
> NVS via a serial enrollment console ([ADR-0014](0014-firmware-secret-provisioning.md)); no secret remains in
> source or the build artifact. (3) **open** — flash encryption is documented but not enabled, and the
> recovered-device residual risk is not yet formally accepted. The dedicated isolated AP hardware is also still
> to be procured.

## Alternatives considered
- **WPA2-Enterprise / RADIUS / per-user certs** — rejected: poor ESP32 802.1X support, over-engineering at one-pitch / 10–20-device scale.
- **WPA3-SAE / mixed mode** — rejected: flaky on ESP32; transition mode reintroduces downgrade/TKIP weakness. Pin WPA2-AES.
- **Venue/home WiFi** — rejected: breaks the isolation assumption (becomes a TLS-required trigger).
