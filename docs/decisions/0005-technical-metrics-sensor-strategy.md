# ADR-0005 — Leg IMU and/or camera CV for technical (football) metrics

**Status:** Accepted (Phase 3 direction) · **Date:** 2026-06-14

## Context
A torso GPS+IMU vest gives **physical** metrics but **cannot** see shots/passes/dribbles — those are
foot-to-ball contact events. The market reflects this: vest = physical, boot/calf = technical.

## Decision
Defer technical metrics to Phase 3 and pursue one or both:
- **Path 1 — leg/boot IMU + ML classification** (what Footbar/PlayerMaker do): a fast IMU (ICM-42688,
  ≥200–500 Hz; ball contact is ~5–15 ms) with gyro; one sensor per foot. Pipeline: peak detection →
  ±0.2 s window → features (peak |a|, peak |ω|, swing duration, energy, jerk, foot-in-air) →
  XGBoost/RandomForest → {shot, pass, touch, nothing}; later 1D-CNN/TCN. Shot power ≈ shank angular
  velocity × lever. Label via phone-video sync.
- **Path 2 — one elevated wide camera + open-source CV** (Veo/Trace style): YOLO (players+ball) +
  tracking + homography → passes, possession, shots, positions for the **whole team at once**.

## Recommended combination
Keep the GPS+IMU vest for live physical metrics **+** add one wide camera with an open-source CV
pipeline for technical/ball metrics. The owner's AI/ML desktop (RTX 3060) makes the CV route viable.
Open-source starting points: `AmmarMohamed0/Football-Analysis-System` (YOLO11 + ByteTrack),
`Khushal-gupta22/Football-Analysis` (YOLOv8, team assignment via jersey-color K-means, ball
interpolation, perspective transform, possession).

## Consequences
- **+** Covers both metric families; camera gives the richest ball/possession data from one device.
- **−** IMU path needs labeled data and careful ball-strike vs ground-strike discrimination (gyro
  signature + foot-in-air). Camera path struggles with ball detection/occlusion and per-player
  attribution (jersey OCR / manual roster).
- Possession %, pass networks, and team shape are **camera-only** — not obtainable from wearables.

## Alternatives considered
- **Smart ball with 500 Hz IMU (Adidas connected ball)** — rejected: can't DIY, and it tracks the
  ball, not individual players.
