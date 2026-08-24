# Player tracker firmware

ESP32 (WEMOS LOLIN32 Lite) + u-blox NEO-M8N wearable: GNSS @10 Hz → WiFi → MQTT, with a
LittleFS backlog that replays fixes buffered during a dropout. See [`src/main.cpp`](src/main.cpp)
for the pipeline and [`../CLAUDE.md`](../CLAUDE.md) for how it fits the wider system.

## Build & flash

```sh
cd firmware
pio run                                   # compile only
pio run -t upload && pio device monitor   # flash + open serial @115200
```

> **Local Mac bench** (stream a real device into your laptop): see [docs/dev/local-bench-runbook.md](../docs/dev/local-bench-runbook.md)
> — set `MQTT_HOST` to your Mac's Wi-Fi IP, keep the device + Mac on the **same Wi-Fi**; `upload_speed` is 460800
> (921600 corrupted the prototype's USB-serial chip).

Arduino IDE alternative: rename `src/main.cpp` → `tracker.ino`, board **WEMOS LOLIN32 Lite**,
and install the three libraries from `platformio.ini` (`lib_deps`) via the Library Manager.
NVS uses the Arduino `Preferences` library, which ships with the ESP32 Arduino core (no `lib_deps` entry).

## Secrets live in NVS, not source

No WiFi PSK or MQTT credential is built into the image — the **same compiled binary flashes to every
device**, and only NVS differs. This is the [ADR-0013](../docs/decisions/0013-field-network-security.md)
hard gate for tracking real children; the design is [ADR-0014](../docs/decisions/0014-firmware-secret-provisioning.md).

In-source (non-secret, identical on every device, at the top of `main.cpp`): `MQTT_HOST` and `SESSION_ID`
(**defaults only** — both overridable per device via the NVS keys below; since Phase 4 the session id is a
per-fixture NVS setting, because session is the unit of coach access control — audit F-6), `MQTT_PORT`,
plus GPS/battery pin config.

In NVS (per-device, set by enrollment — namespace `ft-cfg`):

| NVS key      | Meaning                                                        |
|--------------|---------------------------------------------------------------|
| `wifi_ssid`  | field-AP SSID                                                  |
| `wifi_pass`  | field-AP WPA2 PSK (shared across the fleet — see ADR-0013)     |
| `player_id`  | this device's `PLAYER_ID` — **also the MQTT username** (ACL `%u`) |
| `mqtt_pass`  | this device's MQTT password                                   |
| `mqtt_host`  | broker host: IP or `name.local` (mDNS). **Optional** — falls back to the compiled `MQTT_HOST` ([ADR-0022](../docs/decisions/0022-dynamic-provisioning.md)) |
| `session_id` | the fixture's session (`set session u14-sat`). **Optional** — falls back to the compiled `SESSION_ID`; set it per real fixture, since session is what coach access is scoped to (Phase 4, audit F-6). Changing it wipes any pending backlog (those fixes belong to the old session) |

`player_id` is the single source of truth: it is the topic segment, the MQTT username (broker ACL,
[`../server/mosquitto/ft.acl`](../server/mosquitto/ft.acl)), and the packet `pl` field.

> **The same string must appear in all three places**, or auth fails (`[mqtt] connect failed, state=5`):
> the broker account name (`mosquitto_passwd ft.passwd <id>`), the firmware `set player <id>`, and —
> consequently — the topic. The id is your choice (examples here and the runnable demos use `01`; the ADRs
> use `p07` illustratively); any consistent non-secret string works.

## Enrollment (one-time, over serial)

On first boot the NVS namespace is empty, so the device **refuses to connect on placeholders** and drops
straight into the enrollment console (it never runs with blank creds). Open the serial monitor and set all
four fields, then `save`:

```
=== football-trackers enrollment ===
enroll> set ssid net-7f3a
enroll> set wifipass <20+ char field-AP PSK>
enroll> set player 01                 # this device's PLAYER_ID (== MQTT username)
enroll> set mqttpass <unique password> # must match the broker account for 01 (see server/mosquitto/README.md)
enroll> save                           # validates all four, writes NVS, reboots
```

Console commands: `set ssid|wifipass|player|mqttpass|host <value>`, `show` (prints values, passwords masked),
`save`, `clear` (erase stored creds), `quit` (exit without saving — only allowed once a full set is already
saved), `help`. The value is everything after the key (spaces allowed, no quotes). `host` is **optional**
(defaults to the compiled `MQTT_HOST`); set it to a `name.local` to resolve the broker via mDNS on any network
(see the portal section below).

**Scripted / piped provisioning** — the same console accepts piped lines, so a device can be provisioned
non-interactively (keep the secrets out of shell history):

```sh
printf 'set ssid net-7f3a\nset wifipass %s\nset player 01\nset mqttpass %s\nsave\n' \
  "$WIFI_PSK" "$MQTT_PW" > /dev/cu.SLAB_USBtoUART   # your board's serial device
```

## Field resilience (Phase 4 — audit F-1..F-6)

The wearable's job is to not lose a child's session when the field Wi-Fi drops. Since Phase 4:

- **Connectivity never blocks the GPS.** Wi-Fi association and MQTT connects run as a non-blocking
  state machine with jittered backoff (1→15 s ±25%); the GPS RX buffer is 8 KB (~8 s of 10 Hz UBX-PVT)
  and every queued solution is drained per loop, so the longest remaining stall (one ~3 s TCP attempt)
  loses nothing. The old blocking reconnect lost ~99 % of an outage.
- **Offline fixes go to a two-file flash backlog** (2 × 128 KB): append to the newest half; when both
  are full the **oldest** half is dropped (the old code silently dropped every *new* fix once full).
- **Replay is paced (~30 msg/s) and crash-safe**: the flush cursor is checkpointed to NVS every 20
  records, so a reboot mid-replay re-sends at most one window — the server dedupes by `sq`.
- **`sq` + `gts` ride every packet**: a per-device monotonic sequence (NVS high-water, never reused
  across reboots) and the fix's GPS-UTC time in ms, so replayed fixes keep their real timestamps
  server-side instead of collapsing into the reconnect second.
- **Stale location does not linger on flash**: records older than 6 h are skipped at replay and purged
  once GPS time is valid; `wipe` over serial erases the whole backlog (lost-device privacy path).
- **A wedged device reboots itself**: a 20 s task watchdog, with `rst` (reset reason), `boot` (NVS
  boot count) and `ver` (firmware version) in every `.../status` frame — a brownout loop is a climbing
  boot count on `/metrics`, not a mystery.
- **Ids are validated at enrollment**: player and session ids must match `[A-Za-z0-9._-]{1,64}` — an
  id with `/` used to publish into a topic the server never matches, a silent black hole.

The pure logic (rotation, cursor, seq, expiry, backoff, id charset) lives in
[`src/resilience.h`](src/resilience.h) and is host-tested — `firmware/test/host/`:

```
cd firmware/test/host && clang++ -std=c++17 -Wall -Wextra -Werror -I ../../src -o test_resilience test_resilience.cpp && ./test_resilience
```

Serial commands during normal operation: `enroll` (re-provision), `portal` (phone setup AP), `wipe`
(erase the backlog).

## Phone setup portal + mDNS broker (ADR-0022)

A phone-friendly alternative to the serial console:

- On first boot (or via the serial `portal` command), the device raises its own Wi-Fi AP **`ft-setup-XXXX`**
  (password **`tracker-setup`**). Connect a phone to it and a captive page opens (or browse `http://192.168.4.1`):
  it **scans and lists nearby Wi-Fi**, you pick one and enter the Wi-Fi password / player id / MQTT password /
  broker host, then **Save** → it writes NVS and reboots onto your Wi-Fi. The serial console runs concurrently —
  whichever path you use, `save` reboots.
- **mDNS broker (no IP changes):** set `host` to a `name.local` (e.g. your laptop's `MacBook-Pro.local`, from
  `scutil --get LocalHostName`). The device resolves it via Bonjour/mDNS on whatever network it joins, so moving
  the same device between **home Wi-Fi and the field AP needs no IP edit and no reflash** — only a different Wi-Fi
  in the portal. A literal IP also works (no mDNS lookup). Verified on hardware 2026-06-17.
- `portal` (typed over serial on a live device) re-opens the setup AP; `quit` (when already configured) closes it
  and resumes normal operation. All built-in ESP32 networking (WebServer / DNSServer / ESPmDNS) — no extra library.

## Credential rotation (lost/stolen device)

Per the [ADR-0013 lost-wearable playbook](../docs/decisions/0013-field-network-security.md#loststolen-wearable-playbook):
type `enroll` over serial at any time to re-provision — **no re-flash needed**. Rotating the shared AP PSK
means re-enrolling `wifipass` on the remaining devices; independently revoke the lost device's MQTT account on
the broker (`mosquitto_passwd -D`, see [`../server/mosquitto/README.md`](../server/mosquitto/README.md)).
A runtime `enroll` ends in a reboot (via `save`); that's fine for a bench maintenance action.

## Optional: ESP32 flash encryption (dump-proof a recovered device)

NVS keeps secrets out of the repo and the build artifact, but a recovered device's flash can still be dumped
over USB/JTAG (`esptool` reads plaintext NVS in seconds). ESP32 flash encryption closes that — but it
**burns eFuses irreversibly** and complicates re-flashing, so it is an opt-in operator step, **not** enabled
by default.

For recoverable wearables on real children this is a named go-live gate
([ADR-0013](../docs/decisions/0013-field-network-security.md) hard gate #3): before going live, either enable
flash encryption or explicitly accept the recovered-device risk. Take the exact `sdkconfig`/`espefuse` steps
from the current Espressif docs (don't copy flags from memory), test on a spare device, and use Development
mode while iterating:
<https://docs.espressif.com/projects/esp-idf/en/latest/esp32/security/flash-encryption.html>
See the commented guidance in [`platformio.ini`](platformio.ini).

## Wiring & first fix

- GPS on Serial2: M8N **TX → GPIO16** (ESP32 RX), M8N **RX → GPIO17** (ESP32 TX), plus 3V3 + GND.
- Optional battery sense: VBAT through a divider to `BATT_ADC_PIN` (GPIO35); set `-1` to disable.
- First fix: outdoors with a clear sky view, 30–60 s cold start.

## Troubleshooting (serial @115200)

- `[cfg] no credentials in NVS — entering enrollment` → device is un-enrolled; provision it (above).
- `[mqtt] connect failed, state=4` (bad user/pass) or `state=5` (not authorized) → the NVS `player_id`/
  `mqtt_pass` don't match a broker account/ACL. Verify with `enroll` → `show`, and check the broker password
  file + ACL ([`../server/mosquitto/README.md`](../server/mosquitto/README.md)). A plain network drop logs a
  different/again pattern, so an auth mistake is distinguishable from a missing AP.
- `[gps] not seen @115200, falling back to 9600` → the M8N didn't accept the baud raise; the code retries at
  9600. Re-seat wiring / power if it persists.
- A rising `backlog` in the `.../status` health frame means the device is buffering fixes but can't reach the
  broker (WiFi up, MQTT/auth down) — check the broker and creds.

## Related

- [ADR-0007](../docs/decisions/0007-mqtt-security.md) — per-device MQTT identity + topic ACLs
- [ADR-0013](../docs/decisions/0013-field-network-security.md) — field network + the hard gate
- [ADR-0014](../docs/decisions/0014-firmware-secret-provisioning.md) — this provisioning design
- [`../server/mosquitto/README.md`](../server/mosquitto/README.md) — broker accounts & ACLs
- [observability](../docs/architecture/observability.md) — the `.../status` health topic
