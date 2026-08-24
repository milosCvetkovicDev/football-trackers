# ADR-0014 — Firmware secret provisioning: per-device creds in NVS, set by a serial enrollment console

**Status:** Accepted · **Implementation:** NVS + serial `enroll` console **shipped** 2026-06-14 (firmware change in `firmware/src/main.cpp`; not yet hardware-verified — needs `pio run`/flash) · **Date:** 2026-06-14

## Context
[ADR-0007](0007-mqtt-security.md) requires **per-device** MQTT credentials (username == `PLAYER_ID`) and
[ADR-0013](0013-field-network-security.md) accepts a **shared WiFi PSK** on the isolated field LAN. Until now
both lived as compile-time constants in `firmware/src/main.cpp` (`WIFI_PASS = "changeme"`, `MQTT_PASS`,
`PLAYER_ID`). That is the "one shared image, one shared secret" anti-pattern: the secret ships in the repo and
in every build artifact, and a per-device password forces a per-device rebuild. ADR-0013's **hard gate**
names this explicitly — *do not track real children until the firmware `WIFI_PASS="changeme"` placeholder is
removed (PSK loaded from NVS, not committed source)*.

## Decision
- **Secrets in NVS, not source.** `WIFI_SSID`, `WIFI_PASS`, `PLAYER_ID` (= the MQTT username) and `MQTT_PASS`
  are read from ESP32 NVS (Arduino `Preferences`, namespace `ft-cfg`) in `setup()`. The compiled image is
  **identical** on every device; only NVS differs. Non-secret deployment config (`MQTT_HOST`, `MQTT_PORT`,
  `SESSION_ID`) stays in source — it is the same on every device, so the "one image" goal still holds.
  > **Amended (audit Phase 4, 2026-08-24):** `SESSION_ID` moved to NVS (`session_id`, `set session` in the
  > enroll console + a portal field, compiled value now only the fallback) — session is the unit of coach
  > access control, so per-fixture sessions must not require a reflash (audit F-6). The "one image" goal
  > still holds: the image stays identical; one more NVS key differs.
- **`PLAYER_ID` is the single source of truth.** It is the topic segment, the MQTT username (broker ACL `%u`,
  see [`server/mosquitto/ft.acl`](../../server/mosquitto/ft.acl)) and the packet `pl` field — one NVS value,
  used everywhere.
- **One-time enrollment over serial.** On boot, if NVS lacks a **complete** credential set the device
  **refuses to connect on placeholders** and drops into an interactive (and pipe-friendly) serial console
  (`set ssid|wifipass|player|mqttpass <value>` → `save`). `save` validates all four fields, writes NVS, and
  reboots. Typing `enroll` during normal operation re-enters the console (PSK rotation per the ADR-0013
  lost-device playbook, no rebuild needed).
- **Authenticated connect unchanged.** `mqtt.connect(clientId, user, pass)` and the auth-failure logging
  (`state=4/5`) from [ADR-0007](0007-mqtt-security.md) are preserved — only the *source* of `user`/`pass`
  moved from constants to NVS globals.
- **Flash encryption: documented opt-in, not auto-enabled — but a named go-live gate.** NVS keeps the secret
  out of the repo and the build artifact, but a recovered device's flash can still be dumped over USB/JTAG.
  ESP32 flash encryption closes that, but enabling it **burns eFuses irreversibly** and complicates
  re-flashing, so it is left as an operator decision (guidance in
  [`firmware/platformio.ini`](../../firmware/platformio.ini)), not a default. Because these are **recoverable
  wearables on real children**, [ADR-0013](0013-field-network-security.md)'s hard gate (#3) requires this be
  consciously resolved before go-live: enable flash encryption, or explicitly accept the recovered-device risk.

## Consequences
- **+** Closes ADR-0013's hard gate: no WiFi PSK or MQTT password in the repo or any build artifact; one image
  flashes to all wearables.
- **+** Per-device password no longer forces a per-device build — provisioning is a 5-line serial step (or a
  piped one-liner) at `pio device monitor` time.
- **+** A device that loses its NVS (or was never enrolled) **fails safe** — it waits in enrollment instead of
  connecting with blanks.
- **+** PSK rotation is a serial `enroll`, not a re-flash, matching the ADR-0013 playbook.
- **−** A recovered device's flash is still readable unless flash encryption is enabled — a go-live gate item
  ([ADR-0013](0013-field-network-security.md) hard gate #3): enable flash encryption or explicitly accept the
  risk before tracking real children. Upgrade path documented.
- **−** Enrollment is a manual per-device step (acceptable at 10–20-device scale); the pre-flash NVS-image
  approach (below) is the scale-up path if that ever bites.

## Alternatives considered
- **SoftAP captive portal for enrollment** — rejected for MVP: adds a WebServer + DNS captive-portal code
  path and a temporary open-AP attack surface for no benefit at this scale; serial is simpler and lower-risk.
- **Pre-flash NVS partition image** (`nvs_partition_gen` from a gitignored per-device CSV, flashed separately)
  — rejected for MVP, kept as the scale-up path: secrets never typed at runtime, but it needs a custom
  partition table, ESP-IDF tooling, and managing a secrets CSV per device.
- **Keep secrets in source** — rejected: this is exactly the anti-pattern the hard gate forbids.
- **Per-device build (compile-time `-D` defines)** — rejected: still bakes the secret into the artifact and
  defeats the "one image" goal.
