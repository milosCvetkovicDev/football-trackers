# Market Analysis

Why no existing product fits, and what the commercial landscape looks like. This is the research
that led to the build-it-yourself decision ([ADR-0001](../decisions/0001-build-vs-buy.md)).

## Can you read an existing tracker from a phone app?

Two very different problems:

| Capability | Feasibility |
|---|---|
| **Detect that a device is present** (BLE advertising: MAC/UUID, RSSI/proximity) | Easy — any phone can scan BLE (Android `BluetoothLeScanner`, iOS CoreBluetooth). |
| **Read and use the tracker's performance data** | Hard / usually impossible from outside — closed proprietary BLE (undocumented GATT), pairing encryption, and most devices **store-and-sync** to the vendor cloud rather than streaming live. |

Reading a commercial tracker's data realistically requires one of: (a) a public API/SDK from the
maker (rare on consumer gear, more common on pro), (b) exporting from their app/cloud and building
on the export, or (c) reverse-engineering the BLE protocol (hard, often blocked by encryption, and
may breach their terms).

## Who offers a public API/SDK?

Only a few **pro** brands — and crucially these are **cloud APIs, not BLE/device SDKs**. You pull
data from their cloud after a session syncs; you do not talk to the device over Bluetooth.

| Brand | API | Nature | Catch |
|---|---|---|---|
| **Catapult** | OpenField Cloud + Connect API; official `catapultR` R package (SBGSports/catapultr) | Cloud REST, token auth | Must be a Catapult customer with credentials enabled via customer success |
| **STATSports** | Cloud integration (Apex/Sonra), Team Id / Custom Player Id | Cloud, for teams/customers | Not an open dev SDK |
| **WIMU** (RealTrack, via Hudl) | Raw data API access, FIFA-certified | Cloud / pro | Pro system, expensive |

**What does not exist:** a consumer football tracker that gives you an open BLE SDK to talk to the
device directly. Almost everything is: team customer → token → REST/cloud API.

## Device pricing (per player)

The market splits sharply into **one-off purchase** vs **per-player annual subscription** — and
the subscription model is what hurts a 10–20 child squad.

### One-off (best for a youth team)
- **Footbar Meteor** — ~€100, no subscription. App free (optional €4.99/mo premium). **Not true
  GPS** — a calf-worn accelerometer measuring passes, shots, distance, sprint speed. Available via
  Decathlon (regionally obtainable).
- **STATSports Apex Athlete Series** — true GPS vest, FIFA-approved, ~€250 one-off. Free Academy
  app (iOS/Android), lifetime access, no monthly fees.

### Per-player subscription (more expensive over time)
- **Catapult One (Team)** — $180/player/year, 2-year commitment, minimum 10 players.
- **PlayerMaker / CITYPLAY** — boot-mounted, technique focus (touches, passes); ~$180–200 +
  mandatory membership ~£150/year.
- **Pro systems (WIMU, Catapult Vector)** — hundreds to €1000+/unit plus software. Overkill for
  youth.

## Total cost of ownership — 10 players, by season (EUR, rounded)

| Device | Upfront | End S1 | End S2 | End S3 |
|---|---|---|---|---|
| Footbar Meteor | €1,000 | €1,000 | €1,000 | €1,000 |
| STATSports Athlete | €2,500 | €2,500 | €2,500 | €2,500 |
| Catapult One Team | — | €1,650 | €3,300 | €4,950 |
| PlayerMaker | — | €3,500 | €5,250 | €7,000 |

(Footbar ~€100/player and STATSports ~€250/player are one-off; Catapult ~€165/player/yr;
PlayerMaker ~€175 device + ~€175/yr membership.)

**Reading:** Footbar is cheapest (€1,000 flat, forever) but is accelerometer-only — no full GPS
load profile. STATSports Athlete is the sweet spot for real GPS with no recurring cost. Catapult
looks cheaper in year 1 but crosses STATSports during season 2 and keeps climbing. PlayerMaker is
most expensive long-term due to membership.

> Prices are international retail; for Serbia add VAT/customs/shipping and FX, so real cost is
> somewhat higher.

## The gap this project fills

Two structural facts drive the whole project:

1. **Cheap + open API don't coexist.** The youth-affordable devices (Footbar, STATSports Athlete)
   are exactly the closed ones; the ones with APIs (Catapult, WIMU) are the expensive
   subscription/pro systems.
2. **Real-time + "all mine" means building it.** Every real-time commercial system is closed.

→ A custom WiFi wearable + owned backend is the only way to get **live data + full ownership at a
youth-team price**. See [system-architecture.md](../architecture/system-architecture.md).
