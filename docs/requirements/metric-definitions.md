# Metric Definitions

The exact formulas, thresholds, and computation rules behind every physical metric the system
reports. This is the reference a coach or sports scientist can audit and an engineer can implement
from directly. It turns the metric list in
[functional-requirements.md](functional-requirements.md) (FR-PHY, FR-LOAD) into precise math.

**Scope:** youth / *omladinski* football (roughly U12–U19). The single most important rule in this
document: **adult thresholds do not transfer to children.** A U13 who tops out at 24 km/h records
*zero* sprint distance against an adult 25.2 km/h cut-off — a measurement artefact, not a training
truth. Every threshold below therefore comes in two forms: a **default age band** (to start today,
squad-comparable) and an **individualized** version (the professional standard, once each player has
been speed-tested). Calibrate to the individual as soon as you can — Section 8 is the protocol.

**What the system measures from.** Each fix is the wire packet in
[`server/src/types.ts`](../../server/src/types.ts): `lat`, `lon`, `spd` (m/s, GNSS Doppler),
`hdg`, `fix`, `sats`, `pdop`, server-stamped `serverTs` (ms). Sample rate is **10 Hz**
(NFR-RATE-1). IMU-derived metrics (PlayerLoad, clean accel/decel) need the optional MPU-6050
([ADR-0004](../decisions/0004-wearable-hardware-baseline.md)); where the IMU is absent, a GPS-only
substitute is given so v1 is never blind.

---

## 0. Conventions & units

| Quantity | Symbol | Unit | Notes |
|---|---|---|---|
| Velocity (instantaneous) | `v` | m/s | from packet `spd`; ×3.6 → km/h |
| Acceleration | `a` | m/s² | derivative of smoothed `v` (Section 2.3) |
| Distance | `d`, `TD` | m | between consecutive fixes (Section 2.1) |
| Sample interval | `Δt` | s | nominal 0.1 s at 10 Hz; use **actual** `serverTs` deltas |
| Gravity | `g` | 9.81 m/s² | for metabolic-power equivalent slope |
| Load (session-RPE) | — | AU | arbitrary units (RPE × minutes) |
| PlayerLoad | `PL` | au | Catapult-scaled accelerometer load |
| Metabolic power | `P` | W/kg | di Prampero model |

Conversions used throughout: **1 m/s = 3.6 km/h**; **km/h → m/s = ÷3.6**.
Always compute on `serverTs` deltas, never assume an exact 0.1 s — at 10 Hz QoS0 a frame can be
dropped (NFR-RES-2) and a naive fixed Δt then inflates speed and acceleration.

---

## 1. Youth age categories & maturation

Serbian federation (FSS) categories map approximately as below; exact birth-year cut-offs vary by
competition, so treat these as bands, not law.

| Category (RS) | Typical ages | Band used here |
|---|---|---|
| Mlađi pioniri | ~U12 | **U12** |
| Stariji pioniri | ~U13–U14 | **U14** |
| Kadeti | ~U15–U16 | **U16** |
| Omladinci / Juniori | ~U17–U19 | **U19** |

**Maturation, not just age, drives the numbers.** Two U14s can differ by years of biological
development; high-speed and high-load thresholds track maturity (peak height velocity, PHV) more
than birth year. For a squad you can quantify this cheaply:

- **Khamis–Roche** %-of-predicted-adult-height (needs height, weight, mid-parent height) — a simple
  maturity index, no sitting-height measurement.
- **Mirwald maturity offset** — years-from-PHV from height, sitting height, weight, age.

Use a maturity estimate to (a) prefer **individualized** thresholds over age-band defaults, and
(b) apply the growth-spurt guardrails in Section 7. This is the difference between a toy and a
professional youth service.

---

## 2. Distance, velocity & acceleration primitives

Everything else is built on these three per-sample quantities.

### 2.1 Per-sample distance (FR-PHY-1)

Distance between consecutive fixes `i-1 → i`. Two equivalent options:

**Haversine** (direct on lat/lon):
```
φ = latitude (rad), λ = longitude (rad), R = 6 371 000 m
Δφ = φ_i − φ_{i-1},  Δλ = λ_i − λ_{i-1}
h  = sin²(Δφ/2) + cos φ_{i-1}·cos φ_i·sin²(Δλ/2)
d_i = 2R·asin(√h)
```

**Local planar** (faster, and what the client already uses — `makeProjector` in
[`client/src/geo.ts`](../../client/src/geo.ts)): project to metres east/north about a session
reference point, then `d_i = √(Δx² + Δy²)`. Over a 105×68 m pitch the two agree to < 1 cm; planar
is preferred for the analytics path because the projection is shared with the homography.

`Total Distance TD = Σ d_i` over the session.

**Noise floor.** Consumer GNSS jitters ~2–5 m even when still (NFR-ACC-1). Summing raw `d_i`
manufactures phantom distance. Gate it: ignore `d_i` when `v_i` is below a walking floor
(≈ 0.4 m/s) **or** when `pdop > 5` / `fix < 2`. Prefer integrating the Doppler `spd`
(`d_i ≈ v_i·Δt`), which is far less noisy than differencing positions.

### 2.2 Velocity (FR-PHY-2)

Use the packet `spd` (u-blox Doppler velocity) as the primary source — it is more accurate and less
noisy than position differencing. **Max speed** is the session peak of *smoothed* `v` (below);
report the peak sustained over ≥ 0.3 s (≥ 3 samples), never a single-sample spike, which is almost
always GNSS noise.

### 2.3 Smoothing & acceleration (FR-PHY-6)

Raw 10 Hz velocity is too noisy to differentiate directly — differentiating noise yields garbage
acceleration. Smooth first, then differentiate:

1. **Smooth** `v` with a short low-pass: a centred moving average over ~5 samples (0.5 s), or a 2nd
   order Butterworth at ~1 Hz cut-off. Call the result `ṽ`.
2. **Acceleration** `a_i = (ṽ_i − ṽ_{i-1}) / Δt_i`, using the real `Δt_i = (serverTs_i − serverTs_{i-1})/1000`.
3. Clamp to a human-plausible range (|a| ≤ ~8 m/s²); anything beyond is a GNSS artefact.

> GPS acceleration is adequate for accel/decel **effort counts**; it is **not** PlayerLoad. True
> PlayerLoad needs the 50–100 Hz IMU (NFR-RATE-2, Section 5.1). Don't conflate them.

---

## 3. Speed zones (FR-PHY-3, FR-PHY-4)

### 3.1 Adult reference model (the baseline we scale *down* from)

The widely-used 5-zone model. **Do not apply these to youth** — they are the anchor for the
age-band table that follows.

| Zone | Name | km/h | m/s |
|---|---|---|---|
| 1 | Walking | 0 – 7.2 | 0 – 2.0 |
| 2 | Jogging | 7.2 – 14.4 | 2.0 – 4.0 |
| 3 | Running | 14.4 – 19.8 | 4.0 – 5.5 |
| 4 | High-Speed Running (HSR) | 19.8 – 25.2 | 5.5 – 7.0 |
| 5 | Sprinting | > 25.2 | > 7.0 |

- **High-Speed Running distance (HSRD)** = distance in Zone 4+ (≥ 5.5 m/s adult).
- **High-Intensity distance** = distance in Zone 4 + Zone 5.
- **Sprint distance** = distance in Zone 5.

### 3.2 Default age-band thresholds (start here)

Pragmatic absolute thresholds for whole-squad comparability before you have individual test data.
Set at roughly 85–90 % of typical category maximal speed, so the metric is meaningful for that age.
**These are starting defaults — replace per player after speed-testing (Section 8).**

| Band | HSR threshold | Sprint threshold | (HSR / Sprint, m/s) |
|---|---|---|---|
| **U12** | 16.0 km/h | 19.0 km/h | 4.44 / 5.28 |
| **U14** | 17.5 km/h | 21.0 km/h | 4.86 / 5.83 |
| **U16** | 19.0 km/h | 23.0 km/h | 5.28 / 6.39 |
| **U19** | 19.8 km/h | 25.0 km/h | 5.50 / 6.94 |

Zones 1–3 keep the adult walking/jogging/running breaks (2.0 / 4.0 m/s); only the high-intensity
band (HSR) and sprint cut-off scale by age. Store the threshold set used **with each session** so
historical metrics stay interpretable when you later re-tune.

### 3.3 Individualized thresholds (the professional standard)

Once a player has been tested, derive thresholds from **their** capacities, not their birth year.
Two anchors per player:

- **MSS** — Maximal Sprint Speed (m/s), the fastest they can run (Section 8.1).
- **MAS** — Maximal Aerobic Speed (m/s), the speed at VO₂max, the floor of "high-intensity" aerobic
  work (Section 8.2).
- **ASR** — Anaerobic Speed Reserve = `MSS − MAS`. The window between "hard aerobic" and "flat-out".

Thresholds:
```
High-intensity running   v > MAS
Sprint                    v > MAS + 0.90·ASR        (≈ flat-out; ~90% of the reserve)
                          — or simply v > 0.90·MSS, whichever your staff prefers
```
Reporting *% of MSS* per zone makes a 12-year-old and a 19-year-old directly comparable: "spent 6 %
of distance above 90 % of their own max" means the same thing for both. This is exactly how
Buchheit / Mendez-Villanueva argue youth GPS data *should* be expressed.

### 3.4 What counts as a "sprint" (FR-PHY-3)

A sprint is an **effort**, not a single fast sample. Count one sprint when **all** hold:

1. `v` rises above the sprint threshold (3.2 / 3.3), **and**
2. stays above it for **≥ 1.0 s** (≥ 10 samples), **and**
3. consecutive sub-threshold efforts are separated by a **≥ 1.0 s** dip below threshold (otherwise
   it's one effort, not two).

Report **sprint count**, **sprint distance** (distance accumulated while above threshold), and
**max sprint speed**. An optional stricter definition also requires an **entry acceleration**
(e.g. the player accelerated > 2.5 m/s² into the effort) to distinguish a true sprint from drifting
over the line downhill.

---

## 4. Accelerations & decelerations (FR-PHY-6)

High accel/decel counts are a large, often dominant share of youth neuromuscular load and a known
soft-tissue injury driver — decelerations especially.

### 4.1 Effort thresholds

| Intensity | Acceleration | Deceleration |
|---|---|---|
| Moderate | a ≥ **+2.0 m/s²** | a ≤ **−2.0 m/s²** |
| High | a ≥ **+3.0 m/s²** | a ≤ **−3.0 m/s²** |

Youth default to the **2.0 / 3.0 m/s²** bands above (adults often add a > 4 m/s² tier). A clean,
mature U19 squad may add a +4 / −4 tier.

### 4.2 Counting an effort

Mirror the sprint rule: an effort counts when `a` crosses the threshold and is **sustained ≥ 0.3 s**
(≥ 3 samples); efforts within 0.3 s of each other merge. Report counts per band, per direction
(accel vs decel), plus **accel/decel density** = efforts per minute. Because these come from
differentiated GPS velocity, treat absolute values as *trend indicators*, not lab-grade — the IMU
(Section 5.1) is the accurate source.

---

## 5. Load metrics (FR-PHY-7, FR-LOAD-1)

"Load" is the dose of training. We define **external load** (what the body did, from sensors) and
**internal load** (what it cost the athlete, from RPE/HR). For youth, track **both** — external for
mechanical/overuse risk, internal for fatigue.

### 5.1 PlayerLoad — IMU, the gold-standard external load

Catapult-style accumulated tri-axial accelerometer load. Requires the MPU-6050 at 50–100 Hz
(NFR-RATE-2). For samples in `g`:
```
PL_n = √[ (x_n − x_{n-1})² + (y_n − y_{n-1})² + (z_n − z_{n-1})² ] / 100
PlayerLoad = Σ PL_n          (accumulated over the session, arbitrary units)
PlayerLoad/min = PlayerLoad / session_minutes      (intensity)
```
The `/100` is Catapult's scaling convention so values land in a familiar range. Report total and
per-minute. **Not available in GPS-only v1** — use 5.2 as the substitute until the IMU is fitted.

### 5.2 Metabolic Power & High-Metabolic-Load Distance — GPS-only load proxy

The professional way to capture load **without** an IMU. Speed zones miss the cost of hard
accelerations; di Prampero's model recovers it by treating accelerated flat running as equivalent
uphill running. Per sample, from smoothed `v` and `a`:

```
Equivalent slope     ES = a / g                         (g = 9.81)
Equivalent mass      EM = √(ES² + 1)
Energy cost (J/kg/m) EC = (155.4·ES⁵ − 30.4·ES⁴ − 43.3·ES³ + 46.3·ES² + 19.5·ES + 3.6) · EM
Metabolic power      P  = EC · v          (W/kg)
```
(The polynomial is Minetti's cost-of-gradient curve; 3.6 J/kg/m is level-running cost. An optional
air-resistance term `+ k·v²`, k ≈ 0.01, is negligible at youth speeds.)

- **High-Metabolic-Load Distance (HMLD)** = distance covered while `P ≥ 25.5 W/kg`. (Use **≥ 20
  W/kg** as a softer youth variant.) HMLD counts hard accel/decel efforts that a pure speed zone
  ignores.
- **Equivalent Distance** `EqD = (Σ P·Δt) / 3.6` — total energy expressed as the level-running
  distance that would have cost the same. `EqD / TD > 1` quantifies how "stop-start" the session
  was.

**Worked example** — `v = 5.0 m/s`:
| Case | `a` | ES | EM | EC (J/kg/m) | P (W/kg) |
|---|---|---|---|---|---|
| Constant speed | 0.0 | 0.000 | 1.000 | 3.60 | **18.0** |
| Hard acceleration | 2.0 | 0.204 | 1.021 | 9.32 | **46.6** |

Same 5 m/s, but accelerating **more than doubles** the metabolic cost — which is exactly the signal
HMLD captures and speed zones throw away.

### 5.3 Session-RPE — internal load, zero hardware

The most validated, cheapest internal-load measure; works even before any wearable is on the pitch.
Collect the player's Rating of Perceived Exertion ~30 min post-session on the **CR-10** scale (0–10):
```
sRPE load (AU) = RPE × session_duration_minutes
```
Example: RPE 6 × 70 min = **420 AU**. This AU is the recommended **daily load** input to ACWR
(Section 6) because every player produces one every session, with or without a device.

### 5.4 Choosing the daily-load currency

ACWR and monotony need **one** number per athlete per day. Pick one and keep it consistent:

| Currency | Source | Best for |
|---|---|---|
| sRPE (AU) | RPE × min | Always available; recommended default for youth |
| Total Distance (m) | GPS | Volume-driven, simple |
| HMLD / EqD | GPS metabolic | Captures intensity without IMU |
| PlayerLoad (au) | IMU | Best mechanical load, once IMU is fitted |

---

## 6. ACWR — Acute:Chronic Workload Ratio (FR-LOAD-2, FR-LOAD-3)

The flagship readiness/risk flag: is recent load spiking above what the athlete is prepared for?

### 6.1 Definitions

- **Acute load** = total daily load over the **last 7 days** (the current week's fatigue).
- **Chronic load** = the athlete's rolling **28-day** load expressed as a weekly average (their
  "fitness"/preparedness).
- `ACWR = Acute / Chronic`.

**Two computation methods** — implement EWMA, keep RA for transparency:

**Rolling Average (RA), uncoupled** (recommended — avoids mathematical coupling):
```
Acute   = Σ load over days  t-6 … t                  (last 7 days)
Chronic = (Σ load over days t-27 … t-7) / 3          (the prior 21 days, weekly avg)
ACWR_RA = Acute / Chronic
```
A *coupled* RA uses the full 28 days incl. this week in the chronic term; uncoupled (above) is
preferred because the acute week then isn't inside its own denominator. Either form still needs
~28 days of history before it means anything (Section 6.5): the uncoupled split spends the oldest 21 days on
chronic and the most recent 7 on acute.

**Exponentially-Weighted Moving Average (EWMA)** — weights recent days more, handles missed days
better:
```
λ_acute   = 2 / (7  + 1) = 0.250
λ_chronic = 2 / (28 + 1) = 0.069
EWMA_today = load_today · λ + EWMA_yesterday · (1 − λ)        (run for acute and chronic separately)
ACWR_EWMA  = EWMA_acute / EWMA_chronic
```

### 6.2 Worked example (RA, sRPE AU)

Weekly loads: three prior weeks **1800, 2000, 2200**; current week (acute) **2600**.
```
Chronic (uncoupled) = (1800 + 2000 + 2200) / 3 = 2000
ACWR = 2600 / 2000 = 1.30
```
(Coupled would be `2600 / ((1800+2000+2200+2600)/4) = 2600/2150 = 1.21`.)

### 6.3 Interpretation bands

| ACWR | Zone | Reading |
|---|---|---|
| < 0.80 | Undertraining / detraining | Load dropped — fitness may be eroding |
| 0.80 – 1.30 | **"Sweet spot"** | Load progressing in step with preparedness |
| 1.30 – 1.50 | Caution | Spiking; watch closely |
| > 1.50 | High-risk "danger zone" | Acute spike well beyond chronic base |

### 6.4 Monotony & Strain (Foster)

Cheap companions to ACWR that flag *sameness* of load — a separate risk factor:
```
Monotony = mean(daily load over the week) / SD(daily load over the week)
Strain   = weekly total load × Monotony
```
Monotony **> 2.0** (every day the same grind, no hard/easy variation) alongside high strain is a
classic illness/injury precursor. Build variation into the week to keep monotony down.

### 6.5 Caveats — read before acting on a number

ACWR is a **flag, not a verdict**, and is genuinely contested in the literature:

- **Mathematical coupling** — the acute week sits inside a coupled chronic window, biasing the ratio
  (Lolli et al.). Use the **uncoupled** form (6.1).
- **Warm-up period** — chronic needs ~**28 days** of history to mean anything. Don't compute or act
  on ACWR in a player's first 3–4 weeks of data; show "building baseline" instead.
- **Youth validity** — ACWR thresholds were derived largely in adult/pro populations; in growing
  athletes treat bands as softer guidance and weight Section 7 (maturation) heavily.
- **Never decide on ACWR alone** — combine with wellness (sleep, soreness, mood), HR-based
  readiness, and the coach's eyes. Critiques (Impellizzeri, Windt & Gabbett) are right that a single
  ratio can't carry a load-management decision.

---

## 7. Youth & maturation guardrails

Professional youth service ≠ shrinking the adult model. Extra rules that override raw numbers:

- **Cap weekly progression** — avoid raising weekly load **> ~10 %** week-on-week (the "10 % rule":
  imperfect, but a sane ceiling for growing tissue). Large green-zone ACWR jumps still warrant
  caution in youth.
- **Growth-spurt sensitivity (around PHV)** — during the peak-height-velocity window, bone grows
  ahead of tendon and coordination dips; apophysitis (Osgood–Schlatter, Sever's) risk rises.
  Temporarily **reduce high-speed and high-decel exposure** for players flagged near PHV (Section 1).
- **Bio-band comparisons** — compare and benchmark by maturity status where possible, not just age,
  so an early-maturing U14 isn't held to an early-developer's numbers (or vice-versa).
- **Integrate internal load + wellness** — sRPE (5.3) and a 1–5 wellness check (sleep, soreness,
  energy, mood) catch overload that external GPS load alone misses, and need no hardware.
- **Individualize first** — youth variance is enormous; per-player thresholds (3.3) and per-player
  baselines beat any squad-wide default.

---

## 8. Calibration protocols (per-player profile)

The tests that turn age-band defaults into individualized thresholds. Re-test each block (~6–8
weeks) and after growth spurts — youth capacities move fast.

### 8.1 Maximal Sprint Speed (MSS)

- **Protocol:** 2–3 × maximal ~30–40 m sprints from a rolling/standing start, full recovery
  between. Outdoors, dry, fitted device.
- **Read-out:** `MSS` = peak **smoothed** GPS speed (peak 0.3–0.5 s window, not a single sample).
- **Use:** sprint / HSR thresholds (3.3); the upper anchor of ASR.

### 8.2 Maximal Aerobic Speed (MAS)

Pick one:
- **30-15 Intermittent Fitness Test (Buchheit)** — use the final running speed `VIFT` as the
  high-intensity reference velocity. Practical for a squad; intermittent like football.
- **Time-trial** — a maximal **5–6 min** run; `MAS ≈ distance / time` (m/s). The GPS already gives
  the distance.
- **Use:** the high-intensity-running floor (3.3); the lower anchor of ASR.

### 8.3 Store the profile with the data

Persist per player: `MSS`, `MAS`, `ASR = MSS − MAS`, derived HSR/sprint thresholds, test date,
maturity estimate. **Stamp the threshold set onto every session** so a later re-test doesn't
silently rewrite historical metrics — comparability across a season depends on this.

---

## 9. Where each metric is computed (system mapping)

| Stage | Lives in | Metrics |
|---|---|---|
| Wearable (10 Hz) | [`firmware/src/main.cpp`](../../firmware/src/main.cpp) | raw `lat/lon/spd/hdg/fix` (+ IMU later) — **no** derived metrics on-device |
| Ingest (real-time) | [`server/src/ingest.ts`](../../server/src/ingest.ts) | server-stamp, validate (`fix ≥ 2`), persist; live `v`, live distance for the coach view |
| Live view | [`client/src/PitchCanvas.tsx`](../../client/src/PitchCanvas.tsx) | current speed, live distance, position (homography); splits |
| Analytics (post / rolling) | future analytics module over [`server/src/db.ts`](../../server/src/db.ts) | zones, sprints, accel/decel, HMLD/EqD, PlayerLoad, daily load, ACWR, monotony |

Live metrics (speed, distance, dots) compute on the hot path; **derived load metrics
(zones, ACWR, HMLD) are batch/rolling over stored history (FR-DATA-2)** — they don't belong on the
per-packet path. Persisted raw telemetry (FR-DATA-1) means any threshold can be **re-derived
retroactively** when you re-tune.

---

## 10. Metric → requirement → formula index

| Metric | FR | Section |
|---|---|---|
| Total distance | FR-PHY-1 | 2.1 |
| Current / max speed | FR-PHY-2 | 2.2 |
| Sprint count & distance | FR-PHY-3 | 3.2–3.4 |
| HSR / High-Intensity distance | FR-PHY-4 | 3.1–3.3 |
| Distance per minute | FR-PHY-5 | 2.1 + 5.1 (per-min pattern) |
| Accelerations / decelerations | FR-PHY-6 | 2.3, 4 |
| PlayerLoad | FR-PHY-7 | 5.1 |
| Metabolic power / HMLD (GPS load proxy) | FR-PHY-7 (IMU-free) | 5.2 |
| Session-RPE (internal load) | FR-LOAD-1 | 5.3 |
| ACWR | FR-LOAD-2 | 6 |
| Monotony / strain, injury-risk flags | FR-LOAD-3 | 6.4, 6.5, 7 |

---

## References (concepts attributed, standard in the field)

- **Minetti et al. (2002)** — energy cost of running on gradients (the EC polynomial).
- **di Prampero et al. (2005); Osgnach et al. (2010)** — metabolic power & equivalent slope in
  football from GPS.
- **Foster (1998)** — session-RPE, training monotony and strain.
- **Gabbett (2016); Blanch & Gabbett (2016); Hulin et al.** — acute:chronic workload ratio.
- **Lolli et al. (2019); Windt & Gabbett (2019); Impellizzeri et al. (2020)** — ACWR coupling &
  methodological critiques (why uncoupled / EWMA / "flag not verdict").
- **Buchheit (2008)** — 30-15 Intermittent Fitness Test (VIFT / MAS reference).
- **Mendez-Villanueva & Buchheit; Buchheit** — individualized (% MSS / MAS / ASR) GPS thresholds for
  youth.
- **Mirwald et al. (2002); Khamis & Roche (1994)** — maturity offset / predicted adult height for
  bio-banding.

> These are starting parameters for a youth setting, not immutable constants. The professional
> workflow is: **start on age-band defaults → speed-test → individualize → re-test each block →
> always read load metrics alongside wellness and the coach's judgement.**

---

## Appendix A — Worked example: one player, one session, end to end

A single concrete walk-through of the whole chain: raw 10 Hz fixes → per-sample mechanics →
session aggregates → daily load → ACWR. Every asserted sum, ratio, and load number below is
computed from the formulas in this document (the per-sample metabolic powers, the sRPE, the ACWR
three ways, and monotony/strain are arithmetic-verified). The zone-distance split and effort counts
are an *illustrative* session profile — realistic, internally consistent (zone distances sum to the
total), but not a literal replay of 42 000 fixes.

**Player:** "Marko", **U14**, training session. No IMU yet → GPS-only, so **metabolic power /
HMLD** (§5.2) substitutes for PlayerLoad and **sRPE** (§5.3) is the daily-load currency (§5.4).
U14 age-band thresholds (§3.2): **HSR ≥ 4.86 m/s (17.5 km/h)**, **sprint ≥ 5.83 m/s (21 km/h)**.

### A.1 Per-sample mechanics (0.5 s micro-trace)

Half a second from one acceleration into a sprint, at 10 Hz, after velocity smoothing (§2.3).
`a = Δṽ/Δt`, `d = v·Δt`, zone per §3.2, metabolic power `P` per §5.2.

| t (s) | v (m/s) | a (m/s²) | d (m) | Zone | ES | EM | P (W/kg) |
|---|---|---|---|---|---|---|---|
| 0.0 | 4.60 | — | 0.460 | Z3 run | 0.000 | 1.000 | 16.6 |
| 0.1 | 4.85 | +2.50 | 0.485 | Z3 run | 0.255 | 1.032 | 54.5 |
| 0.2 | 5.10 | +2.50 | 0.510 | Z4 HSR | 0.255 | 1.032 | 57.4 |
| 0.3 | 5.40 | +3.00 | 0.540 | Z4 HSR | 0.306 | 1.046 | 72.3 |
| 0.4 | 5.70 | +3.00 | 0.570 | Z4 HSR | 0.306 | 1.046 | 76.3 |
| 0.5 | 5.95 | +2.50 | 0.595 | Z5 sprint | 0.255 | 1.032 | 66.9 |

*These `P` values are single-sample **instantaneous peaks** during a hard acceleration — they last
fractions of a second, are not sustained loads, and (like all GPS-derived acceleration, §4) the di
Prampero model tends to over-read at high `|a|`. A session-mean metabolic power is ~10–12 W/kg;
70+ W/kg is a momentary spike. Only the **accumulation** — HMLD, EqD — is interpreted at session level.*

Two things this trace makes visible — and that plain speed zones miss:

- **At t = 0.1 the player is still in Z3 (4.85 m/s, below the 4.86 HSR cut-off) yet P = 54.5 W/kg** —
  roughly triple the ~17.5 W/kg of running 4.85 m/s *steadily*. The *acceleration* is the cost, not
  the speed. A speed-zone report logs this instant as "low intensity"; HMLD (§5.2) correctly counts it.
- **t = 0.5 is the fastest sample (5.95 m/s) but P drops to 66.9** vs 76.3 at t = 0.4, because
  acceleration eased from 3.0 → 2.5 m/s². `P` tracks *both* `v` and `a`.

The trace shown is only the first 0.5 s of a longer effort — so far just t = 0.5 has crossed
5.83 m/s. If `v` stays above the sprint threshold for ≥ 1.0 s (≥ 10 samples, §3.4), the whole effort
counts as **one sprint** and its Z5 samples (including the 0.595 m at t = 0.5) accrue to **sprint
distance**.

### A.2 Session aggregates (full 70-min session)

| Metric | Value | Source |
|---|---|---|
| Total distance | **5 800 m** | §2.1 |
| Distance / min | **82.9 m/min** (5 800 / 70) | §2.1 |
| Zone 1 walk (0–2.0 m/s) | 2 200 m | §3.2 |
| Zone 2 jog (2.0–4.0) | 2 100 m | §3.2 |
| Zone 3 run (4.0–4.86) | 900 m | §3.2 |
| Zone 4 HSR (4.86–5.83) | 420 m | §3.2 |
| Zone 5 sprint (≥ 5.83) | 180 m | §3.2 |
| **HSRD** (Z4+Z5) | **600 m** | §3.1 |
| Sprint distance (Z5) | 180 m | §3.4 |
| Sprint count | 9 efforts | §3.4 |
| Max speed | 6.7 m/s (24.1 km/h) | §2.2 |
| High accels (≥ 3 m/s²) / decels (≤ −3) | 16 / 12 | §4 |
| Moderate accels (≥ 2) / decels (≤ −2) | 41 / 35 | §4 |
| **HMLD** (P ≥ 25.5 W/kg) | **720 m** | §5.2 |
| Equivalent distance (EqD) | ≈ 6 670 m (EqD/TD ≈ 1.15) | §5.2 |

In *this* stop-start session **HMLD (720) > HSRD (600) > sprint distance (180)** — but that ordering
is **session-dependent, not a rule**. At this U14's speeds, steady high-speed running (4.86–6.0 m/s)
mostly sits *below* the 25.5 W/kg HMLD cut-off, so almost all of the 720 m HMLD is
acceleration-driven (like t = 0.1 above), while much of the 600 m HSRD is steady running; in a
low-acceleration possession session HSRD can instead exceed HMLD. The durable point is that HMLD
counts the hard-acceleration cost speed zones miss. `EqD/TD = 1.15` says the stop-start nature of the
session cost 15 % more energy than the same 5 800 m run steadily — load a GPS-only setup would
otherwise miss. (HMLD here uses the 25.5 W/kg default; the softer youth variant ≥ 20 W/kg from §5.2
would report a larger distance.)

### A.3 Internal load (sRPE)

Marko rates the session **RPE 6** (CR-10) at 30 min post:
```
sRPE = 6 × 70 min = 420 AU       (§5.3)
```
This 420 AU is today's daily-load value feeding the ratios below.

### A.4 Place the session in 4 weeks of history

Daily sRPE summed per week; today is day 28, the last day of week 4 — a **tournament week** (two
matches), the legitimate cause of the load spike.

| Week | Daily loads (AU) | Weekly total |
|---|---|---|
| W1 (d1–7) | 0, 400, 450, 350, 400, 580, 0 | **2 180** |
| W2 (d8–14) | 0, 410, 460, 360, 410, 600, 0 | **2 240** |
| W3 (d15–21) | 0, 420, 470, 370, 420, 620, 0 | **2 300** |
| **W4 (d22–28, acute)** | 640, 400, 0, 640, 440, 420, **420** | **2 960** |

Weeks 1→3 ramp gently (~3 %/wk, well inside the 10 % guardrail of §7). Week 4 jumps to 2 960.

### A.5 ACWR, three ways (§6)

```
Acute (last 7 days, = W4)                = 2 960 AU
Chronic, uncoupled (avg of W1–W3)        = (2180+2240+2300)/3 = 2 240 AU
Chronic, coupled   (avg of W1–W4)        = (2180+2240+2300+2960)/4 = 2 420 AU

ACWR (RA, uncoupled)  = 2960 / 2240 = 1.32   →  Caution (1.30–1.50)
ACWR (RA, coupled)    = 2960 / 2420 = 1.22   →  "Sweet spot" — spike hidden
ACWR (EWMA)           = 407.6 / 318.9 = 1.28 →  upper sweet spot, right at the 1.30 line
```

This is §6.5's coupling caveat in one example. By the §6.3 bands, **only the uncoupled ratio (1.32)
crosses into Caution**; the **coupled** ratio (1.22) drops the spike well into the green zone because
the heavy week sits inside its own denominator. EWMA (1.28) lands *between* them — still technically
sweet-spot, but pressed against the 1.30 boundary and clearly elevated, so it corroborates the
upward trend the coupled view flattens rather than independently triggering the flag. **Read the
uncoupled ratio and the trend — not the reassuring coupled number.**

### A.6 Monotony & strain — week 4 (§6.4)

```
Daily loads W4 = [640, 400, 0, 640, 440, 420, 420],  mean = 422.9 AU
SD (population, ÷n)  = 197.8  →  Monotony = 422.9 / 197.8 = 2.14
Strain = weekly load × monotony = 2 960 × 2.14 ≈ 6 327
```
Monotony **2.14 > 2.0** (borderline high) alongside high strain reinforces the ACWR flag.
*Caveat on the convention:* with the **sample** SD (÷n−1 = 213.7) monotony is **1.98** — just under
the 2.0 line. Right at the threshold the SD choice flips the verdict, so fix one convention
(population SD here) and read monotony as a trend, not a pass/fail gate.

### A.7 The coach-facing decision

Putting it together for Marko after this tournament week:

- **ACWR (uncoupled) 1.32 — caution**; EWMA 1.28 sits just under the line and corroborates the
  trend; the coupled 1.22 would have falsely reassured.
- **Monotony ~2.1, high strain** — the week was both heavy *and* samey.
- **Action (per §7):** emphasise recovery now; do **not** raise next week's load (10 % rule already
  argues against it — last week was +29 %); weight Marko's wellness check and any soreness heavily,
  and watch decelerations (12 hard decels) for soft-tissue niggles.
- **Not a panic, a flag.** The spike has a clear cause (two matches). ACWR earned its keep by making
  "this was a big week, back off" quantitative — but the decision still rests with the coach, wellness,
  and growth status, never the ratio alone (§6.5).
- **Read it as provisional.** Day 28 is the first point Marko has ~4 weeks of history, so per §6.5's
  warm-up rule this is the *earliest* his ACWR is even interpretable — trust the trend over the exact
  number until the chronic base has more weeks behind it.

> The full chain — *raw fix → smoothed v → per-sample P and zone → session aggregates → sRPE → ACWR
> + monotony → a coaching decision* — is exactly what the analytics module (§9) automates over the
> persisted telemetry (FR-DATA-1/2). This appendix is its hand-computed reference.
