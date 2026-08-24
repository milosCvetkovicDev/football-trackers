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

**First, provision the broker accounts (once).** The dev broker is **authenticated** — the same config
and per-device ACLs as the field broker ([ADR-0007](../decisions/0007-mqtt-security.md)). It used to be
anonymous, which meant any host on the Wi-Fi could subscribe to every child's 10 Hz feed, or publish
forged telemetry the server accepted, server-stamped and persisted as authoritative (audit §4.6, proven
live). `ft.passwd` is a secret, so it is gitignored and you generate it locally:
```sh
./server/mosquitto/dev-provision.sh 01        # server account + wearable "01"; add more ids as needed
```
It prints each wearable's password **once** — that is the value you put into the device over serial
(§3), so copy it now. It also writes the repo-root `.env` that compose reads for the server's `ingest`
credentials.

```sh
docker compose up -d            # broker + server (first run installs server deps in the container)
docker compose ps               # both Up?
docker compose logs -f server   # expect "http listening" + "mqtt connected"
```
> `MQTT_PASSWORD is not set` from compose means the provisioning step above hasn't run. That is on
> purpose — the alternative used to be a broker that accepted anybody.

The telemetry store is `./server/data/telemetry.db` on the host (a bind mount — it used to be a named volume no
host path could reach, which broke erasure: audit §4.5 d). To erase a player while the stack is up, run the CLI
**inside the container** so it sees the container's `DB_PATH`:
```sh
docker compose exec -T server bun run purge-player.ts <playerId> [sessionId]   # exit 0 = erased; 3 retry; 4 re-run; 5 wrong DB_PATH
```
It rebuilds the store (secure-delete batches + VACUUM — the live server drops fixes for the duration: tens of seconds
to ~2 minutes on a ~1 GB store; the receipt's `totalMs` says how long), so do this between sessions, not mid-match.
It refuses up front (exit 5) if the disk cannot hold the ~2.5× transient rebuild.

Smoke-test the broker → server path without hardware. Publishing now needs credentials — use a
wearable account from the provisioning step (its ACL allows exactly its own player topic):
```sh
mosquitto_pub -h 127.0.0.1 -p 1883 -u 01 -P '<player 01 password>' \
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
enroll> set mqttpass <player 01 password>   # the password dev-provision.sh printed for THIS id in §1
enroll> save                          # writes NVS + reboots
```
After reboot you should see `[gps] configured @10Hz UBX-PVT` (GPS wiring OK) and **no** `[mqtt] connect failed`
once it reaches the broker.

## 5. Start the coach view (Vite **on the host**)
```sh
cd client && VITE_PROXY_TARGET=http://127.0.0.1:3007 bun run dev    # -> http://localhost:5173
```
Open `http://localhost:5173`. **Do not** run Vite inside the Docker stack for this — its `/live` WebSocket proxy
does not relay the upgrade from a container (the browser hangs at "connecting" while the server logs `ws open`).
On the host it works. The server is published on `3007` precisely so the host Vite can proxy to it.

`127.0.0.1:3007`, not `localhost:3007`: the server's port is published on the **IPv4 loopback only**
(audit §4.1 — this stack needs no login for the live view, so it must not be reachable from the Wi-Fi),
and `localhost` can resolve to `::1` first. Two consequences worth knowing before they confuse you:
- The coach view is **this Mac only**. A second tablet on the Wi-Fi cannot open it any more. That is the
  point; if you need one on the pitch, that is the Caddy + real-auth deployment, not this stack.
- **Names and Review need a real login.** The anonymous bypass is now scoped to the live pitch: with no
  account you get moving dots labelled by pseudonymous id, no Review toggle, and `/roster` + `/history`
  answer 403 `login_required`. Provision a coach to see names:
  ```sh
  cd server && AUTH_ACCOUNTS_FILE=./auth-accounts.json bun run auth-user.ts add coach --role coach --sessions test
  ```
  (both files are gitignored; the server picks them up on its reload timer).

## 6. Verify end to end
- **Connected, but "waiting for players" (indoors):** correct and expected. The device is connected and sending
  health (`ft_device_wifi_rssi_dbm`, etc.), but **indoors there is no GPS fix**, so every position packet is
  dropped (`ft_telemetry_dropped_total{reason="no_fix"}` climbs) — the system refuses to draw a fake position.
- **Prove the view renders** without going outside — publish a synthetic `fix=3` packet and watch a dot appear:
  ```sh
  mosquitto_pub -h 127.0.0.1 -p 1883 -u 01 -P '<player 01 password>' \
    -t 'football-trackers/session/test/player/01/telemetry' \
    -m '{"id":"trk-01","pl":"01","ts":1,"lat":44.8125,"lon":20.4612,"spd":3.2,"hdg":90,"fix":3,"sats":11,"pdop":1.2}'
  ```
  A dot appears for ~10 s and then drops (the view refuses to show a fix older than that), so loop the publish
  if you want to watch it for longer.
- **Real moving dot:** take the laptop + device **outside** (or to a window) with sky view; ~30–60 s for the first
  cold fix; the dot then tracks the real position. Out of Wi-Fi range, the device buffers fixes to LittleFS and
  replays them on reconnect (no data lost).

---

## 7. Phase 4 acceptance: the 60 s outage drill (bench, real device)

The audit's Phase 4 accepts on hardware evidence: **a 60 s AP/broker outage preserves ≥ 92 % of fixes,
no duplicate `(player_id, seq)` rows, and the replayed rows span ~60 s** (not the reconnect second).
With the device flashed (`pio run -t upload`), enrolled, publishing on the bench (§1–§6):

```sh
# 1. baseline — note the counters (metrics are loopback INSIDE the container; a counter that has never
#    incremented is ABSENT from the scrape — absent = 0)
docker compose exec -T server bun -e "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>/^ft_telemetry_(received|published|replayed|dropped)/.test(l)).join('\n')))"

# 2. the outage: stop the broker for 60 s, then bring it back
docker compose stop mosquitto && sleep 60 && docker compose start mosquitto

# 3. watch the replay drain (paced ~30 msg/s; ft_telemetry_replayed_total should rise by ~600,
#    ft_device_backlog_bytes should fall back to 0, dropped{duplicate} stays 0 unless the device rebooted)
docker compose exec -T server bun -e "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>/^ft_(telemetry_(received|published|replayed|dropped)|device_backlog)/.test(l)).join('\n')))"

# 4. verify in the store: rows in the last 3 min (outage + surrounding live traffic) span the outage and
#    hold no (player, device, seq) duplicates. The ≥92% preservation evidence is ft_telemetry_replayed_total
#    rising by ~≥552 in step 3 — the raw row count below includes live traffic and is not the criterion.
cd server && bun -e "
const {Database}=require('bun:sqlite');const d=new Database('./data/telemetry.db',{readonly:true});
const r=d.query(\"SELECT COUNT(*) n, MAX(server_ts)-MIN(server_ts) span FROM telemetry WHERE server_ts > (strftime('%s','now')-180)*1000\").get();
const dup=d.query('SELECT COUNT(*) c FROM (SELECT player_id,device_id,seq FROM telemetry WHERE seq IS NOT NULL GROUP BY player_id,device_id,seq HAVING COUNT(*)>1)').get();
console.log('rows last 3 min:',r.n,'span ms:',r.span,'dup (player,seq):',dup.c)"
```

Mid-replay, kill power to the device and re-boot it to exercise the crash path: the re-sent window
must show up as `ft_telemetry_dropped_total{reason="duplicate"}` (bounded ≤ 20), never as extra rows.

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
| Compose exits: `MQTT_PASSWORD is not set` | The broker accounts were never created | Run `./server/mosquitto/dev-provision.sh 01` (§1) — it writes `.env` and `ft.passwd` |
| Server logs `mqtt error` in a loop; `/health` shows `"mqtt":false` | The server's broker password doesn't match `ft.passwd` — usually after re-running provisioning followed by `docker compose restart`, which does **not** re-read `.env` | `docker compose up -d` (recreates the container with the new env) |
| `mosquitto_pub` → `Connection Refused: not authorised` | The dev broker is authenticated now | Pass `-u <playerId> -P <password>` from §1; the ACL allows only that player's own topic |
| Coach view unreachable from another device on the Wi-Fi | Deliberate: the server is published on `127.0.0.1` only, because this stack needs no login | This-machine-only is the posture; a pitch-side tablet is the Caddy + real-auth deployment |
| Live view shows ids (`01`) instead of names; no Review toggle | You are the anonymous principal — names + Review need a real login | Click **Sign in for names & review** and log in with a coach account (§5) |
| `purge-player.ts` exits `5` (`DB_PATH does not exist` / `read-only`) | Paths are cwd-relative: the container's `/data/…` vs the host's `./server/data/…`; on Linux the bind mount is root-owned | Stack up: `docker compose exec -T server bun run purge-player.ts …`; stack down: `cd server && DB_PATH=./data/telemetry.db bun run purge-player.ts …` (the receipt prints the absolute `dbPath` it looked for) |
| `purge-player.ts` exits `4` (receipt `walTruncated:false`, `retry:true`) | A reader pinned the WAL, or the live server was mid-checkpoint (the `error` says which) | Re-run the same command; it is idempotent and exits `0` once the WAL truncates |
| `purge-player.ts` exits `3` (`locked by another writer: … held by pid N`) | A purge, the retention sweep or `roster-user.ts` holds `roster.json.lock` | Wait for it; a dead holder's lock is broken automatically, a live one is never pulled from under |

## Related
- [`firmware/README.md`](../../firmware/README.md) — wiring, enrollment console, credential rotation.
- [`docker-compose.yml`](../../docker-compose.yml), [`server/mosquitto/`](../../server/mosquitto/README.md) — the stack + its broker auth.
- [observability](../architecture/observability.md) — the `ft_*` metrics referenced above.
- [hardware BOM](../architecture/hardware-bom.md) — parts, the LiPo polarity warning, the vest.
