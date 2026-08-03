# Functional Requirements

Feature/metric requirements, grouped and ID'd. The **source** of each metric matters: a torso
GPS+IMU vest gives **physical** metrics; **technical** metrics (shot/pass/dribble) need a leg/boot
IMU or a camera ([ADR-0005](../decisions/0005-technical-metrics-sensor-strategy.md)).

> **Exact formulas, thresholds, and youth (omladinski) calibration** for the physical and load
> metrics below live in [metric-definitions.md](metric-definitions.md) — speed zones by age, sprint
> rules, accel/decel, PlayerLoad, GPS metabolic power, and ACWR.

## Physical metrics — from GPS + IMU (torso vest)
| ID | Requirement | Source / method |
|---|---|---|
| FR-PHY-1 | Total distance | Haversine between consecutive GPS fixes |
| FR-PHY-2 | Current & max speed | GPS speed, smoothed |
| FR-PHY-3 | Sprint count & distance | Speed threshold (e.g. >25 km/h, tuned for age) |
| FR-PHY-4 | High Speed Running & High Intensity Distance | Speed-zone bucketing |
| FR-PHY-5 | Distance per minute (intensity) | Rolling distance / time |
| FR-PHY-6 | Accelerations / decelerations | IMU (optional in v1) |
| FR-PHY-7 | PlayerLoad | Accumulated IMU acceleration |
| FR-PHY-8 | Position heatmap | Accumulated calibrated positions |

> GPS alone delivers FR-PHY-1…5 and 8 (~80% of physical value). IMU adds 6–7 and can be added later
> — see [ADR-0004](../decisions/0004-wearable-hardware-baseline.md).

## Live coach view
| ID | Requirement |
|---|---|
| FR-LIVE-1 | Render each player as a live dot on a pitch, sub-second latency |
| FR-LIVE-2 | **Pitch calibration**: walk the 4 corners once, store coords, compute a homography mapping lat/lon → a normalized 105×68 m pitch |
| FR-LIVE-3 | Per-session view (a tablet sees only its session's players) |
| FR-LIVE-4 | Splits: create/edit time splits per player in real time (PLAYERTEK Plus model) |
| FR-LIVE-5 | Smooth motion: hold last position per player in a `useRef` Map, render via `requestAnimationFrame`, buffer/interpolate packets (no per-packet React re-render) |

## Technical / football metrics — leg/boot IMU or camera CV (Phase 3)
| ID | Requirement | Source |
|---|---|---|
| FR-TEC-1 | Shot detection + shot power | Leg/boot IMU ≥200–500 Hz, classifier; power ≈ shank angular velocity × lever |
| FR-TEC-2 | Pass detection (short/long) | Leg/boot IMU classifier |
| FR-TEC-3 | Touches, ball involvement, weak-foot balance | Leg/boot IMU |
| FR-TEC-4 | Dribbling | Series of small frequent contacts (IMU) |
| FR-TEC-5 | Possession %, pass network, team shape, ball location | Camera CV only |

## Load management (Phase 2)
| ID | Requirement |
|---|---|
| FR-LOAD-1 | Trends and benchmarks vs personal records |
| FR-LOAD-2 | ACWR (acute:chronic workload ratio) from stored history |
| FR-LOAD-3 | Recovery / overtraining / injury-risk signals |

## Engagement (Phase 2)
| ID | Requirement |
|---|---|
| FR-ENG-1 | Pro Score (single overall rating) |
| FR-ENG-2 | Leaderboards (Max Speed, HSR, High Intensity Distance, Total Distance) |
| FR-ENG-3 | Achievements & personal records |
| FR-ENG-4 | Teams / invites; match-up comparison by age/position |

## Coaching (Phase 2)
| ID | Requirement |
|---|---|
| FR-COACH-1 | Drill library / training plans |
| FR-COACH-2 | Session management; pod-to-player assignment |
| FR-COACH-3 | Recovery advice |

## Heart rate (optional, high-value add)
| ID | Requirement |
|---|---|
| FR-HR-1 | Pair a BLE HR strap via the standard Heart Rate profile (0x180D) |
| FR-HR-2 | HR zones and time-in-red-zone |

## Data & ownership
| ID | Requirement |
|---|---|
| FR-DATA-1 | Persist all telemetry locally (time-series) |
| FR-DATA-2 | Post-session analytics (distances, sprints, heatmaps) |
| FR-DATA-3 | Full data export |
