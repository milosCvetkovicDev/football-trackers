# Hardware — Bill of Materials & Sourcing

Components, costs, where to buy (Serbia-focused), and what was actually ordered. Prices are as
quoted during sourcing (RSD ≈ 117/€); local prices vary, add VAT/customs/shipping for imports.

## Design principle
**Prove one prototype before buying ten.** Don't buy ×10 of anything until a single unit proves the
full chain: firmware → MQTT → backend → live dot. Bench-test on USB power; the battery, enclosure,
vest, and strap are only needed for on-field use.

## Variant B — GPS+IMU wearable (physical metrics) — the chosen build
| Part | Choice | ~Price | Notes |
|---|---|---|---|
| MCU | **WEMOS Lite ESP32** (LOLIN32 Lite) | 1,300 RSD (~€11) | Plain ESP32 is enough for Variant B; **built-in LiPo charging** → no separate TP4056 |
| GNSS | **GY-GPSV3 NEO-M8N** | 2,000 RSD (~€17) | 72-channel, TTL/UART, 10 Hz capable. **Not** NEO-6M (~1 Hz) |
| IMU | MPU-6050 (optional v1) / ICM-42688 (technical) | ~€2 / ~€8–15 | Optional for v1 — GPS alone gives ~80% of physical metrics |
| Battery | **LP-503759CL** LiPo 3.7 V 1350 mAh | 900 RSD (~€7.70) | 5×37×59 mm, ~6–8 h runtime |
| Wiring | Jumper set (3 types, 10 cm, 120 pcs) | 720 RSD | Female-female for M8N↔WEMOS + spares |
| Header | Male pin header 40-pin 2.54 mm | 28 RSD | Square pins grip Dupont best |
| Tools | Micro-USB cable, soldering iron, multimeter | — | **Multimeter to verify LiPo polarity before connecting** |

**Per unit ~€30–50 → ~€300–500 for 10.** Plus the match-day field network
([ADR-0013](../decisions/0013-field-network-security.md)): **MikroTik wAP 2nD (RBwAP2nD)** — 2.4 GHz-only
outdoor AP, includes PoE injector, **~€45–55** (uspon.rs / jakov.rs); on-pitch power via a 12 V LiFePO₄ pack
(~€25–40) through the bundled injector; pole/fence mount (~€10–20). One dedicated, internet-isolated WPA2-AES
SSID with client-isolation on → **~€85–120 one-off** for the network. (Not 5 GHz-only units — the ESP32 is
2.4 GHz; no WLAN controller / RADIUS — over-engineering at this scale.)

### Wiring (Serial2)
`M8N TX → GPIO16`, `M8N RX → GPIO17`, plus `3V3` and `GND`. (TX/RX cross over.)

### Selection rationale
- **WEMOS Lite over ESP32-S3 DevKitC** for Variant B: the S3's PSRAM/power is for fast IMU (500 Hz),
  on-device ML, or camera — not needed to stream GPS+IMU at 10 Hz. The S3 DevKitC also has **no
  on-board LiPo charging**, so it would still need a TP4056. (Pick the S3 if you want one board for
  all variants including shot detection.)
- **NEO-M8N over NEO-6M**: M8N does 10 Hz multi-constellation (clean sprints/accelerations); NEO-6M
  is ~1 Hz and smears exactly those metrics. M9N is marginally better under cover but not worth it
  for youth. ([ADR-0004](../decisions/0004-wearable-hardware-baseline.md))

## Variant C — leg/boot IMU (technical metrics, Phase 3)
Same ESP32-S3 base; the key part is a **fast IMU ICM-42688-P** (500 Hz+, low noise) on a calf strap
or boot, two sensors for left/right foot. ([ADR-0005](../decisions/0005-technical-metrics-sensor-strategy.md))

## Variant A — camera (computer vision, Phase 3)
Do **not** buy Veo/XbotGo/Pixellot (closed, subscription). DIY: record raw 4K, process with your own
YOLO.
| Option | Use | ~Price |
|---|---|---|
| 4K phone on a high tripod | €0 start, validate the pipeline | — |
| Insta360 X4 (8K 360°) | Whole pitch from one point (11v11); dewarp to panorama | ~€427 (Gigatron) |
| DJI Osmo Action 6 / GoPro | More pixels on the ball (7v7 youth) | ~€496 / ~€299 |
| Denver ACK-8064 | Cheap test only (weak sensor) | ~€77 |

Mount high (tripod/pole 4–6 m) — height is the biggest quality factor. Process on the existing RTX
3060 12 GB desktop; optional Jetson Orin Nano (~€250–300) for on-field live.

## Wearable accessories (~€15–25/player, on-field only)
- **Vest**: AliExpress "football GPS tracker vest" (empty ~€8–15), SPT GPS Vest (~€20–30), or DIY
  Decathlon Kipsta compression top + sewn shoulder-blade pocket.
- **Enclosure**: 3D-print PETG/TPU (best fit) or ABS IP65 project box (~€2–6). Conformal-coat the
  PCB — sweat is the main enemy.
- **Calf strap**: AliExpress elastic strap with pocket (~€2–6) / Decathlon / DIY neoprene+velcro.

## Sourcing (Serbia)
| Item | Local (same-day) | Import (cheaper / original) |
|---|---|---|
| ESP32 | Elektromodul.rs, Elektroleum.rs, MikroPrinc, Malina314 (Čukarica, BG) | AliExpress |
| GPS | NEO-M8N local | NEO-M9N via TME (PL), Mouser, AliExpress |
| IMU | MPU-6050/9250 local | ICM-42688/BNO055 via TME / AliExpress |
| LiPo | LitiCo (Niš), Interhit, local hobby/RC | AliExpress |
| Cameras | Gigatron, WinWin, Tehnomanija, Fotodiskont (compare on eponuda.com); used on KupujemProdajem | Amazon.de/.it (customs) |

> Cheapest: AliExpress (slow). Original + fast in EU: TME (Poland). Local same-day: Elektromodul et al.

## What was ordered (prototype, ×2 for a spare + a two-dot test)
- **Elektromodul ** — ~8,000 RSD: 2× WEMOS Lite, 2× NEO-M8N, jumper
  set, 4× pin headers.
- **Interhit ** — ~4,000 RSD: 3× LP-503759CL.

> ⚠️ The LiPo's red connector is often RCY/2.5 mm, while WEMOS Lite uses JST PH 2.0 mm — and polarity
> may be reversed. **Measure with a multimeter before connecting**, or cut the connector and solder
> leads to the board's + / − pads in the correct orientation.
