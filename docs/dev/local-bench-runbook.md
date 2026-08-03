# Local bench runbook — run the whole pipeline with a real wearable on your Mac

How to take an assembled wearable (ESP32 + NEO-M8N) and see it stream into the live coach view, end to end,
on a laptop — **broker + server in Docker Compose, the coach view (Vite) on the host.** This is the exact path
validated on a real device on 2026-06-17.

```
[wearable]  --Wi-Fi-->  [Mac]
ESP32+M8N               docker compose:  mosquitto (1883)  ->  Bun server (3000, published 3007)
  (10 Hz)                                                          |
                        host Vite (5173) --proxy /live--> :3007 ---/  --> browser (coach view)
```

> **The one rule that bites everyone:** the wearable (Wi-Fi) and the Mac must be on the **same Wi-Fi network**,
> and the Mac should be on **Wi-Fi, not a wired/dock Ethernet** — see [§Networking](#2-networking-the-1-gotcha).

---

## 0. Prerequisites (one-time)
- **Docker Desktop** (`docker --version`, `docker compose version`).
- **Bun** (`bun --version`) — runs the server + the host Vite.
- **mosquitto** CLI for test publishes: `brew install mosquitto` (gives `mosquitto_pub`).
- **PlatformIO** to flash firmware: `brew install platformio` (`pio --version`).

## 1. Start the backend (Docker Compose)
```sh
docker compose up -d            # broker + server (first run installs server deps in the container)
docker compose ps               # both Up?
docker compose logs -f server   # expect "http listening" + "mqtt connected"
```
Smoke-test the broker → server path without hardware (anonymous broker, so no creds needed):
```sh
mosquitto_pub -h 127.0.0.1 -p 1883 \
  -t 'football-trackers/session/test/player/01/telemetry' \
  -m '{"id":"trk-01","pl":"01","ts":1,"lat":44.8125,"lon":20.4612,"spd":3.2,"hdg":90,"fix":3,"sats":11,"pdop":1.2}'
# the server's /metrics (loopback inside the container) should show received + published rise:
docker compose exec -T server bun -e \
  "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>/^ft_telemetry_(received|published)/.test(l)).join('\n')))"
```

## 2. Networking (the #1 gotcha)
- The ESP32 is **2.4 GHz only** — the Wi-Fi must expose a 2.4 GHz band.
- The wearable and the Mac must be on the **same Wi-Fi / subnet**. Put the **Mac on Wi-Fi** (turn it on, join the
  same SSID); **avoid a wired dock Ethernet** — in testing the dock's wired LAN was **isolated** from the Wi-Fi
  (the device got an IP and ARP resolved, but `ping` failed 100% and the broker was unreachable from the device →
  `[mqtt] connect failed, state=-2`). Wi-Fi-to-Wi-Fi worked immediately.
- Find the Mac's Wi-Fi IP — this is the value the firmware's `MQTT_HOST` must point at:
  ```sh
  ipconfig getifaddr en0    # Wi-Fi interface IP, e.g. 192.168.1.7
  ```
- Sanity-check the device is reachable once it's on Wi-Fi: `ping <device-ip>` (find it via the router or ARP:
  `arp -a | grep <device-mac>`). 0% loss = good; 100% loss = isolation/different network (fix the Wi-Fi above).

## 3. Flash the firmware
1. Point the firmware at your Mac's Wi-Fi IP. In [`firmware/src/main.cpp`](../../firmware/src/main.cpp) set:
   ```cpp
   static const char* MQTT_HOST = "192.168.1.7";   // your Mac's Wi-Fi IP (§2). Field AP default = 192.168.4.1
   ```
   (This is the **only** source edit needed for the bench; revert to the field AP IP for real deployments.)

   > **Newer & better ([ADR-0022](../decisions/0022-dynamic-provisioning.md)):** you no longer need to edit/reflash
   > for the broker host. Set it at runtime via serial `set host <ip-or-name.local>` or the phone setup portal.
   > **Best:** set `host` to your Mac's mDNS name — `MacBook-Pro.local` (from `scutil --get LocalHostName`) — so the
   > same device works on home Wi-Fi **and** the field with zero changes. The compiled `MQTT_HOST` is now just the
   > fallback default when NVS has no host. Also: instead of the serial console you can provision from a phone —
   > the device raises a setup AP `ft-setup-XXXX` (pw `tracker-setup`) that scans + lists Wi-Fi.
2. Flash over USB:
   ```sh
   pio run -d firmware -t upload --upload-port /dev/cu.usbserial-XXX
   ```
   - The board enumerates as `/dev/cu.usbserial-*` or `/dev/cu.SLAB_USBtoUART` (`ls /dev/cu.*`). No driver was
     needed on recent macOS; if the port never appears it's the USB-serial driver (CP210x/CH340) or a charge-only
     cable.
   - `platformio.ini` `upload_speed` is **460800** (not 921600) — 921600 corrupted the flash stream on this
     USB-serial chip (`Unable to verify flash chip connection`). Lower it further to 115200 if uploads still fail.

## 4. Enroll the device (Wi-Fi + MQTT creds over serial)
Secrets live in NVS, never in the image — see [`firmware/README.md`](../../firmware/README.md). On first boot the
device drops into the enrollment console; later, type `enroll` any time. Open the serial monitor and set the four
fields:
```sh
pio device monitor -d firmware     # 115200 baud
```
```
enroll> set ssid <your 2.4 GHz SSID>
enroll> set wifipass <its password>
enroll> set player 01                 # == MQTT username; matches SESSION_ID "test" topic
enroll> set mqttpass anything         # the local broker is anonymous, so any non-empty value works
enroll> save                          # writes NVS + reboots
```
After reboot you should see `[gps] configured @10Hz UBX-PVT` (GPS wiring OK) and **no** `[mqtt] connect failed`
once it reaches the broker.

## 5. Start the coach view (Vite **on the host**)
```sh
cd client && VITE_PROXY_TARGET=http://localhost:3007 bun run dev    # -> http://localhost:5173
```
Open `http://localhost:5173`. **Do not** run Vite inside the Docker stack for this — its `/live` WebSocket proxy
does not relay the upgrade from a container (the browser hangs at "connecting" while the server logs `ws open`).
On the host it works. The server is published on `3007` precisely so the host Vite can proxy to it.

## 6. Verify end to end
- **Connected, but "waiting for players" (indoors):** correct and expected. The device is connected and sending
  health (`ft_device_wifi_rssi_dbm`, etc.), but **indoors there is no GPS fix**, so every position packet is
  dropped (`ft_telemetry_dropped_total{reason="no_fix"}` climbs) — the system refuses to draw a fake position.
- **Prove the view renders** without going outside — publish a synthetic `fix=3` packet and watch a dot appear:
  ```sh
  mosquitto_pub -h 127.0.0.1 -p 1883 -t 'football-trackers/session/test/player/01/telemetry' \
    -m '{"id":"trk-01","pl":"01","ts":1,"lat":44.8125,"lon":20.4612,"spd":3.2,"hdg":90,"fix":3,"sats":11,"pdop":1.2}'
  ```
- **Real moving dot:** take the laptop + device **outside** (or to a window) with sky view; ~30–60 s for the first
  cold fix; the dot then tracks the real position. Out of Wi-Fi range, the device buffers fixes to LittleFS and
  replays them on reconnect (no data lost).

---

## Troubleshooting (symptoms seen during bring-up)

| Symptom | Cause | Fix |
|---|---|---|
| `[mqtt] connect failed, state=-2` (after Wi-Fi is up) | Device can't reach the broker over the network | §2: device + Mac on the **same Wi-Fi**; Mac on Wi-Fi not wired dock (isolation); `MQTT_HOST` = Mac's **Wi-Fi** IP; reflash |
| `ping <device>` 100% loss but ARP resolves | Wi-Fi **client/AP isolation** or device on a different subnet | Disable AP/Client isolation, or use the main (non-guest) Wi-Fi, or a phone hotspot (no isolation) |
| Upload fails: `Unable to verify flash chip connection … serial noise` | `upload_speed` too high for the USB-serial chip | Lower `upload_speed` in `platformio.ini` (921600 → 460800 → 115200) |
| Port never appears as `/dev/cu.usbserial-*` | Missing USB-serial driver, or a charge-only cable | Install CP210x/CH340 driver; use a real **data** USB cable |
| Coach view stuck at "connecting"; server logs `ws open` | Vite WS proxy in Docker doesn't relay the `/live` upgrade | Run Vite **on the host** (§5), server published on 3007 |
| `Bind for 0.0.0.0:3000 failed: port is already allocated` | Another host service holds 3000 (e.g. other Docker stacks) | The server is intentionally published on **3007**, not 3000 — leave it |
| `ft_device_battery_percent 0` / `battery_volts ~0` | No LiPo connected (running on USB) | Expected on the bench; the battery is a later step (verify polarity first) |

## Related
- [`firmware/README.md`](../../firmware/README.md) — wiring, enrollment console, credential rotation.
- [`docker-compose.yml`](../../docker-compose.yml), [`deploy/mosquitto/`](../../deploy/) — the stack.
- [observability](../architecture/observability.md) — the `ft_*` metrics referenced above.
- [hardware BOM](../architecture/hardware-bom.md) — parts, the LiPo polarity warning, the vest.
