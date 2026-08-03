# Camera/CV Track — v3 Implementation Plan (Analytics)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of the v1+v2 `vision/` subproject, turn the per-frame `WorldState` stream into an offline **analytics report** — `out/clip/stats.json` (the §7.4 schema) + a one-screen `out/clip/summary.txt` — covering **possession %**, **per-player distance/speed**, **possession-changes (heuristic, opt-in)**, and **team shape** per time bucket. Every number is an **honest, movement-derived, unvalidated** estimate, labelled as such (mirrors [ADR-0020](../decisions/0020-tactical-event-detection.md)).

**Architecture:** v3 adds ONE pure module, `footballcv/analytics.py`, that consumes a `list[WorldState]` (pitch-space filled by v2's `PitchProjector`) and emits the stats dict + summary text. It is **fully deterministic** (pure numpy over fixed inputs) and **fully unit-tested on synthetic `WorldState`s** — no models, no weights, no network, runs entirely in the CPU Docker test image. `pipeline.py` gains `run_v3` (builds the v2 `WorldState` stream, then calls analytics) + `--stats`/`--passes` CLI flags. **`stitch.py` is explicitly NOT built** — ADR §7.3 makes it a deferred spike (analytics ship on **raw** `track_id`s; stitch only if raw-id corruption is demonstrated on real target-view footage, which does not exist yet).

**Tech Stack:** Python 3.11 · numpy · the existing v1/v2 `types.py` (`WorldState`/`PlayerObs`/`BallObs`) · stdlib `json`. No new dependencies.

**Source spec:** [ADR-0023 (build-spec form)](../decisions/0023-camera-cv-offline-analysis.md) §7-v3 (§7.3 metric definitions, §7.4 `stats.json` schema). This plan implements **v3 only**. **Not in v3:** the `stitch.py` spike (gated, §7.3), v4 GoPro de-warp (§7.4-v4).

## Global Constraints

Every task implicitly includes this section.

- **Python 3.11** (`pyproject.toml` `requires-python == "3.11.*"`). No new deps — `analytics.py` is numpy + stdlib only.
- **EXECUTION (Docker only):** every `pytest`/`python -m footballcv …` runs in Docker via `vision/docker-compose.yml` — **never on the host**. Read every `Run:` step as `docker compose run --rm test <cmd>` from `vision/`. The real-clip run uses the `gpu` (3060) or `cpu-run` (Mac CPU) image; analytics themselves need neither.
- **Determinism:** `analytics.py` is pure/deterministic and gets **exact-value** unit tests on synthetic `WorldState`s.
- **Honesty (load-bearing, §7.3):** every emitted metric is movement-derived and **unvalidated**; `provenance.heuristic = true`. Possession is **undefined** during interpolated ball segments + dead-ball and is **not computed on the far side** (reprojection error there > ~1.5 m); `ball_known_fraction` is reported and **`< ~0.7` ⇒ `confidence:"low"`** (a half-observed clip must NOT renormalise to a crisp split). Distance is a **noise-floored lower-bound**, never a true total. "Passes" is **renamed "possession changes (heuristic)"** and is **opt-in (`--passes`, off by default)**. GKs are **excluded** from both possession assignment and team-shape hull.
- **Privacy gate (#1):** public adult/pro footage only; no youth footage; `analytics.py` makes **no** network calls. `pipeline.py` keeps the offline guards first and must **never import `fetch_models`** (asserted by a test, as in v1/v2). No player **name** ever enters `stats.json` (only numeric `track_id` + `team`) — mirrors the GPS pipeline's name-firewall.
- **Units (§7.4):** `pitch_xy` is **cm** on the 12000×7000 `SoccerPitchConfiguration`; `stats.json` distances are **m** (cm/100), speeds **m/s**, time **s** (from `WorldState.frame_ts`). Convert at the report boundary, compute internally in cm.
- **VERSION CONTROL:** NOT a git repo — no per-task commits; each task's checkpoint is the full test suite green via Docker.
- **id space:** metrics key on **raw** `track_id` (`WorldState.track_id_space == "raw"`); `stats.json` `provenance.ids` reflects it. The known limitation (re-entry after occlusion → new id splits a player's metrics) is **surfaced in the report**, not silently corrected.

---

## File Structure

```
vision/
  footballcv/
    analytics.py        # NEW (Tasks 1-6) — possession / distance / possession-changes / team-shape / stats.json / summary.txt
    pipeline.py          # EXTEND (Task 7) — run_v3 + --stats/--passes wiring (live loop stays a flagged stub)
    types.py             # v1/v2 — UNCHANGED
    radar.py             # v2 — REUSED read-only (frac_dots_in_left_third is the shape vocabulary cousin; analytics owns its own hull/spread)
  test/
    test_analytics_possession.py   # NEW (Task 1)
    test_analytics_distance.py     # NEW (Task 2)
    test_analytics_changes.py      # NEW (Task 3)
    test_analytics_teamshape.py    # NEW (Task 4)
    test_analytics_stats.py        # NEW (Task 5+6) — stats.json schema + summary.txt
    test_pipeline_v3.py            # NEW (Task 7) — wiring + no-fetch_models guard
```

All under `vision/`. `analytics.py` imports only `numpy`, `json`, and `footballcv.types`.

---

## Task 1: Possession (`analytics.py` — assignment + time-share)

Per analysed frame, assign the ball to the **nearest non-GK player within `assign_radius` (seed 3 m = 300 cm)** in `pitch_xy`; possession = that player's team. Only assign when the ball is **real (not interpolated/missing)** AND in the **near-centre zone** (far side → "not computed"). Time-share per team over the assigned frames; report `ball_known_fraction`; **low-confidence when `ball_known_fraction < 0.7`**.

**Files:** Create `footballcv/analytics.py`, `test/test_analytics_possession.py`.

**Interfaces — Produces:**
- `nearest_team(ball_xy, players, *, assign_radius_cm) -> int | None` — nearest **non-GK** player (`cls != "goalkeeper"`, `team in (0,1)`) within radius; `None` if none in radius / no ball.
- `in_near_zone(ball_xy, near_zone) -> bool` — `near_zone` is `((y_min_cm, y_max_cm))` on the width axis (`pitch_xy[1]`); `None` ⇒ whole pitch (zone reported `"all"`).
- `ball_known_fraction(states) -> float` — `1 - (interpolated+missing)/frames` over `WorldState.ball` (reuse the v2 definition: a ball is "known" iff `ball.pitch_xy is not None and not ball.interpolated`).
- `possession(states, *, assign_radius_cm=300.0, near_zone=None) -> dict` — returns `{team0_pct, team1_pct, confidence, ball_known_fraction, zone, far_side, assign_radius_m, assigned_frames, far_not_computed_frames}`.

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_analytics_possession.py
import numpy as np
from footballcv.analytics import nearest_team, possession, ball_known_fraction
from footballcv.types import PlayerObs, BallObs, WorldState

def _p(tid, team, xy, cls="player"):
    return PlayerObs(tid, cls, team, (0, 0, 1, 1), xy, 0.9)

def _ws(i, players, ball_xy, interp=False, known=True):
    ball = BallObs(image_xy=(0, 0) if known else None,
                   pitch_xy=ball_xy, confidence=0.8 if known else 0.0, interpolated=interp)
    return WorldState(i, i / 5.0, "raw", players, ball)

def test_nearest_team_picks_closest_within_radius():
    players = [_p(1, 0, (3000.0, 3500.0)), _p(2, 1, (3200.0, 3500.0))]
    assert nearest_team((3050.0, 3500.0), players, assign_radius_cm=300.0) == 0

def test_nearest_team_none_outside_radius():
    players = [_p(1, 0, (3000.0, 3500.0))]
    assert nearest_team((6000.0, 3500.0), players, assign_radius_cm=300.0) is None

def test_nearest_team_excludes_goalkeeper():
    # a GK is the closest body, but GKs are excluded from possession (§7.3)
    players = [_p(9, 0, (5000.0, 3500.0), cls="goalkeeper"), _p(1, 1, (5250.0, 3500.0))]
    assert nearest_team((5050.0, 3500.0), players, assign_radius_cm=300.0) == 1

def test_possession_timeshare_over_assigned_frames():
    states = []
    # 8 frames team-0 holds, 2 frames team-1 holds, all ball-known + central
    for i in range(8):
        states.append(_ws(i, [_p(1, 0, (3000.0, 3500.0)), _p(2, 1, (9000.0, 3500.0))], (3010.0, 3500.0)))
    for i in range(8, 10):
        states.append(_ws(i, [_p(1, 0, (3000.0, 3500.0)), _p(2, 1, (9000.0, 3500.0))], (9010.0, 3500.0)))
    out = possession(states, assign_radius_cm=300.0)
    assert round(out["team0_pct"], 1) == 80.0 and round(out["team1_pct"], 1) == 20.0
    assert out["confidence"] == "ok"           # ball known every frame
    assert out["assigned_frames"] == 10

def test_possession_low_confidence_when_ball_mostly_unknown():
    states = [_ws(0, [_p(1, 0, (3000.0, 3500.0))], (3010.0, 3500.0))]           # 1 known
    for i in range(1, 10):
        states.append(_ws(i, [_p(1, 0, (3000.0, 3500.0))], None, known=False))   # 9 missing
    out = possession(states, assign_radius_cm=300.0)
    assert out["ball_known_fraction"] < 0.7 and out["confidence"] == "low"

def test_possession_excludes_interpolated_and_far_side():
    # ball known but INTERPOLATED -> not assigned; and a far-zone frame -> not computed
    s_interp = _ws(0, [_p(1, 0, (3000.0, 3500.0))], (3010.0, 3500.0), interp=True)
    s_far = _ws(1, [_p(1, 0, (3000.0, 6800.0))], (3000.0, 6800.0))                # far touchline
    out = possession([s_interp, s_far], assign_radius_cm=300.0, near_zone=(0.0, 4666.0))
    assert out["assigned_frames"] == 0
    assert out["far_not_computed_frames"] == 1 and out["far_side"] == "not_computed"
    assert out["zone"] == "near_centre_only"
```

- [ ] **Step 2: Run to verify it fails** → `ModuleNotFoundError: footballcv.analytics`.

- [ ] **Step 3: Implement the possession section of `analytics.py`**

```python
# vision/footballcv/analytics.py
from __future__ import annotations
import numpy as np
from footballcv.types import WorldState, PlayerObs, BallObs

LOW_BALL_KNOWN_FRACTION = 0.7        # below this, possession split is "low" confidence (§7.3)

def _is_real_ball(ball: BallObs) -> bool:
    return ball.pitch_xy is not None and not ball.interpolated

def ball_known_fraction(states) -> float:
    if not states:
        return 0.0
    known = sum(1 for s in states if _is_real_ball(s.ball))
    return known / len(states)

def nearest_team(ball_xy, players, *, assign_radius_cm: float) -> int | None:
    """Nearest NON-GK player (team 0/1) within assign_radius_cm of the ball, in pitch cm.
    GKs (cls=='goalkeeper') and referees (team is None) are excluded (§7.3)."""
    if ball_xy is None:
        return None
    best_team, best_d = None, assign_radius_cm
    for p in players:
        if p.cls == "goalkeeper" or p.team not in (0, 1) or p.pitch_xy is None:
            continue
        d = float(np.hypot(p.pitch_xy[0] - ball_xy[0], p.pitch_xy[1] - ball_xy[1]))
        if d <= best_d:
            best_team, best_d = p.team, d
    return best_team

def in_near_zone(ball_xy, near_zone) -> bool:
    """near_zone = (y_min_cm, y_max_cm) on the WIDTH axis (pitch_xy[1]); None ⇒ whole pitch.
    The width band where reprojection error stays <= ~1.5 m (§7.2/§7.3) — the caller sets it
    from the calibration; far-side frames are reported 'not computed', never a biased number."""
    if near_zone is None or ball_xy is None:
        return True
    return near_zone[0] <= ball_xy[1] <= near_zone[1]

def possession(states, *, assign_radius_cm: float = 300.0, near_zone=None) -> dict:
    counts = {0: 0, 1: 0}
    assigned = far_not_computed = 0
    for s in states:
        if not _is_real_ball(s.ball):
            continue                                  # interpolated/missing ⇒ undefined (§7.3)
        if not in_near_zone(s.ball.pitch_xy, near_zone):
            far_not_computed += 1
            continue                                  # far side ⇒ not computed (structured bias)
        t = nearest_team(s.ball.pitch_xy, s.players, assign_radius_cm=assign_radius_cm)
        if t is not None:
            counts[t] += 1
            assigned += 1
    total = counts[0] + counts[1]
    t0 = 100.0 * counts[0] / total if total else 0.0
    t1 = 100.0 * counts[1] / total if total else 0.0
    bkf = ball_known_fraction(states)
    return {
        "team0_pct": t0, "team1_pct": t1,
        "confidence": "low" if bkf < LOW_BALL_KNOWN_FRACTION else "ok",
        "ball_known_fraction": bkf,
        "zone": "all" if near_zone is None else "near_centre_only",
        "far_side": "computed" if near_zone is None else "not_computed",
        "assign_radius_m": assign_radius_cm / 100.0,
        "assigned_frames": assigned, "far_not_computed_frames": far_not_computed,
    }
```

- [ ] **Step 4: Run to verify it passes** → PASS (6 tests). Checkpoint — your test file green.

---

## Task 2: Distance & speed (`analytics.py` — per-id, with the three §7.3 guards)

Per **raw** `track_id`: smooth `pitch_xy`, sum frame-to-frame displacement with a **noise floor**, derive speed on the **sampled-fps `frame_ts` timebase**, report a **sustained (≥0.3 s) peak speed**, and **clamp** physically-impossible jumps as tracking error (counted). Distance is a **lower-bound** (§7.3). This is the CV analogue of the GPS `metric-definitions.md` §2.1–2.3 hygiene — it must NOT reintroduce phantom distance.

**Files:** Create `test/test_analytics_distance.py`. Extend `analytics.py`.

**Interfaces — Produces:**
- `moving_average(xy_seq, *, window) -> list[tuple]` — short MA over a per-id `pitch_xy` sequence (window odd, edge-clamped).
- `sustained_peak_speed_ms(positions_cm, ts, *, min_window_s=0.3) -> float` — max average speed (m/s) over any window spanning ≥ `min_window_s`.
- `player_distance_speed(track, *, move_floor_cm=150.0, smooth_window=3, max_speed_ceiling_ms=10.0) -> dict` where `track` is the time-ordered list of `(frame_ts, pitch_xy)` for ONE id (skip frames where that id is absent). Returns `{distance_m, distance_is_lower_bound, max_speed_ms, clamped_outlier_segments}`.
- `per_player_metrics(states, *, move_floor_cm=150.0, smooth_window=3, max_speed_ceiling_ms=10.0) -> dict[int, dict]` keyed by `track_id` (also carries `team`).

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_analytics_distance.py
import numpy as np
from footballcv.analytics import (player_distance_speed, sustained_peak_speed_ms, per_player_metrics)
from footballcv.types import PlayerObs, BallObs, WorldState

def test_standing_player_accrues_near_zero_distance():
    # a "standing" player jittering +/- 50 cm (under the 150 cm floor) every frame @5fps
    ts = [i / 5.0 for i in range(20)]
    track = [(t, (5000.0 + (40.0 if i % 2 else -40.0), 3500.0)) for i, t in enumerate(ts)]
    out = player_distance_speed(track, move_floor_cm=150.0, smooth_window=3)
    assert out["distance_m"] < 1.0                      # jitter floored out (no phantom distance)
    assert out["distance_is_lower_bound"] is True

def test_walking_player_accrues_distance():
    ts = [i / 5.0 for i in range(11)]                    # 2 s
    track = [(t, (5000.0 + 200.0 * i, 3500.0)) for i, t in enumerate(ts)]   # +2 m/frame = 10 m/s? no: 200cm/0.2s
    out = player_distance_speed(track, move_floor_cm=150.0, smooth_window=1, max_speed_ceiling_ms=12.0)
    # 10 steps * 2.0 m = 20 m total
    assert abs(out["distance_m"] - 20.0) < 0.5

def test_sustained_peak_ignores_single_frame_spike():
    # steady 4 m/s, with ONE 1-frame teleport; sustained >=0.3s peak must not be the spike
    ts = [i / 5.0 for i in range(10)]
    pos = [(800.0 * i, 0.0) for i in range(10)]          # 8 m / 0.2 s = 40 m/s? recompute in impl test
    peak = sustained_peak_speed_ms([(0.0,0.0),(80.0,0.0),(160.0,0.0),(900.0,0.0),(980.0,0.0)],
                                   [0.0,0.2,0.4,0.6,0.8], min_window_s=0.3)
    # the 0.6s frame is a +740cm spike; over any >=0.3s window the average stays bounded, not the spike
    assert peak < 40.0

def test_outlier_jump_is_clamped_and_counted():
    ts = [i / 5.0 for i in range(5)]
    track = [(ts[0], (0.0, 0.0)), (ts[1], (80.0, 0.0)), (ts[2], (160.0, 0.0)),
             (ts[3], (8000.0, 0.0)),                      # +78 m in 0.2 s = 390 m/s -> impossible
             (ts[4], (8080.0, 0.0))]
    out = player_distance_speed(track, move_floor_cm=150.0, smooth_window=1, max_speed_ceiling_ms=10.0)
    assert out["clamped_outlier_segments"] >= 1
    # the 78 m teleport is NOT added to distance (dropped as tracking error, lower-bound honesty)
    assert out["distance_m"] < 5.0

def test_per_player_metrics_groups_by_track_id():
    states = []
    for i in range(5):
        states.append(WorldState(i, i / 5.0, "raw",
            [PlayerObs(7, "player", 0, (0,0,1,1), (200.0 * i, 0.0), 0.9),
             PlayerObs(8, "player", 1, (0,0,1,1), (50.0, 50.0), 0.9)],
            BallObs(None, None, 0.0, False)))
    m = per_player_metrics(states, move_floor_cm=150.0, smooth_window=1, max_speed_ceiling_ms=12.0)
    assert set(m) == {7, 8} and m[7]["team"] == 0 and m[7]["distance_m"] > m[8]["distance_m"]
```

> The exact numeric expectations above are illustrative; when implementing, keep the SEMANTICS (floor kills jitter, ceiling clamps teleports out of the distance sum and counts them, sustained peak ignores 1-frame spikes) and tune the asserted thresholds to the implementation's real output. Do NOT weaken a guard to pass a test — fix the number.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the distance/speed section of `analytics.py`**

```python
# append to vision/footballcv/analytics.py

def moving_average(xy_seq, *, window: int):
    """Edge-clamped centred moving average over a (N,2) sequence. window<=1 ⇒ identity."""
    pts = np.asarray(xy_seq, float)
    if window <= 1 or len(pts) < 2:
        return [tuple(p) for p in pts]
    half = window // 2
    out = []
    for i in range(len(pts)):
        lo, hi = max(0, i - half), min(len(pts), i + half + 1)
        out.append(tuple(pts[lo:hi].mean(axis=0)))
    return out

def sustained_peak_speed_ms(positions_cm, ts, *, min_window_s: float = 0.3) -> float:
    """Max average speed (m/s) over any window spanning >= min_window_s (§7.3: never a single
    inter-frame delta). Distance in cm -> m via /100; time in s."""
    pts = np.asarray(positions_cm, float)
    t = np.asarray(ts, float)
    n = len(pts)
    if n < 2:
        return 0.0
    # cumulative path length (cm) so any window's covered distance is a difference
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    best = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            dt = t[j] - t[i]
            if dt >= min_window_s:
                speed = (cum[j] - cum[i]) / 100.0 / dt
                best = max(best, speed)
                break                  # smallest window >= min_window_s from i; longer only dilutes
    return best

def player_distance_speed(track, *, move_floor_cm: float = 150.0, smooth_window: int = 3,
                          max_speed_ceiling_ms: float = 10.0) -> dict:
    """track = time-ordered [(frame_ts, (x_cm,y_cm))] for ONE id. Three §7.3 guards:
    smoothing before differencing, a per-step noise floor, and a max-speed clamp (outliers
    dropped from the distance sum AND counted). Distance is a noise-floored LOWER BOUND."""
    if len(track) < 2:
        return {"distance_m": 0.0, "distance_is_lower_bound": True,
                "max_speed_ms": 0.0, "clamped_outlier_segments": 0}
    ts = [t for t, _ in track]
    sm = moving_average([xy for _, xy in track], window=smooth_window)
    dist_cm, clamped = 0.0, 0
    kept_pts, kept_ts = [sm[0]], [ts[0]]
    for i in range(1, len(sm)):
        step = float(np.hypot(sm[i][0] - sm[i-1][0], sm[i][1] - sm[i-1][1]))
        dt = ts[i] - ts[i-1]
        speed = (step / 100.0) / dt if dt > 0 else 0.0
        if speed > max_speed_ceiling_ms:
            clamped += 1                          # tracking error: drop it, don't fabricate (lower bound)
            continue
        if step < move_floor_cm:
            kept_pts.append(sm[i]); kept_ts.append(ts[i])
            continue                              # below noise floor: no distance, but keep position
        dist_cm += step
        kept_pts.append(sm[i]); kept_ts.append(ts[i])
    peak = sustained_peak_speed_ms(kept_pts, kept_ts, min_window_s=0.3)
    return {"distance_m": dist_cm / 100.0, "distance_is_lower_bound": True,
            "max_speed_ms": peak, "clamped_outlier_segments": clamped}

def per_player_metrics(states, *, move_floor_cm: float = 150.0, smooth_window: int = 3,
                       max_speed_ceiling_ms: float = 10.0) -> dict:
    tracks: dict = {}
    teams: dict = {}
    for s in states:
        for p in s.players:
            if p.pitch_xy is None or p.cls == "goalkeeper":
                continue                          # GKs excluded from outfield distance too (consistency)
            tracks.setdefault(p.track_id, []).append((s.frame_ts, p.pitch_xy))
            teams.setdefault(p.track_id, p.team)
    out = {}
    for tid, tr in tracks.items():
        tr.sort(key=lambda r: r[0])
        m = player_distance_speed(tr, move_floor_cm=move_floor_cm, smooth_window=smooth_window,
                                  max_speed_ceiling_ms=max_speed_ceiling_ms)
        m["team"] = teams[tid]
        out[tid] = m
    return out
```

> `max_speed_ceiling_ms` default 10.0 is the adult prototyping ceiling; the youth age-band ceiling (~6 m/s youngest, [ADR-0019](../decisions/0019-age-banded-zones-session-config.md)) is passed by the caller once running on youth-age clips. Note in the report which ceiling was used.

- [ ] **Step 4: Run to verify it passes.** Checkpoint — green.

---

## Task 3: Possession changes — heuristic, opt-in (`analytics.py`)

Same-team possessor change with ball travel above a threshold and **no opponent touch in between** — but "no opponent touch" is **undetectable from one camera**, so this is the **weakest** metric: renamed from "passes", surfaced as "possession changes (heuristic)", **opt-in (off by default)**.

**Files:** Create `test/test_analytics_changes.py`. Extend `analytics.py`.

**Interfaces — Produces:** `possession_changes(states, *, assign_radius_cm=300.0, min_travel_cm=500.0, near_zone=None) -> dict` → `{count, min_travel_m, heuristic:True, note}`. A "change" = consecutive **assigned** frames (same definition as Task 1) where the possessor `track_id` changes, the new possessor is the **same team**, and the ball travelled ≥ `min_travel_cm` between the two assignments.

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_analytics_changes.py
from footballcv.analytics import possession_changes
from footballcv.types import PlayerObs, BallObs, WorldState

def _ws(i, players, ball_xy):
    return WorldState(i, i / 5.0, "raw", players,
                      BallObs((0, 0), ball_xy, 0.8, False))

def test_counts_same_team_possessor_change_over_min_travel():
    # frame 0: player 1 (team0) at x=3000 has ball; frame 1: ball travels 6 m to player 2 (team0)
    s0 = _ws(0, [PlayerObs(1, "player", 0, (0,0,1,1), (3000.0, 3500.0), 0.9),
                 PlayerObs(2, "player", 0, (0,0,1,1), (3600.0, 3500.0), 0.9)], (3010.0, 3500.0))
    s1 = _ws(1, [PlayerObs(1, "player", 0, (0,0,1,1), (3000.0, 3500.0), 0.9),
                 PlayerObs(2, "player", 0, (0,0,1,1), (3600.0, 3500.0), 0.9)], (3590.0, 3500.0))
    out = possession_changes([s0, s1], min_travel_cm=500.0)
    assert out["count"] == 1 and out["heuristic"] is True

def test_no_change_when_same_possessor():
    s0 = _ws(0, [PlayerObs(1, "player", 0, (0,0,1,1), (3000.0, 3500.0), 0.9)], (3010.0, 3500.0))
    s1 = _ws(1, [PlayerObs(1, "player", 0, (0,0,1,1), (3000.0, 3500.0), 0.9)], (3020.0, 3500.0))
    assert possession_changes([s0, s1], min_travel_cm=500.0)["count"] == 0

def test_no_change_when_ball_travel_below_threshold():
    s0 = _ws(0, [PlayerObs(1, "player", 0, (0,0,1,1), (3000.0, 3500.0), 0.9),
                 PlayerObs(2, "player", 0, (0,0,1,1), (3100.0, 3500.0), 0.9)], (3010.0, 3500.0))
    s1 = _ws(1, [PlayerObs(1, "player", 0, (0,0,1,1), (3000.0, 3500.0), 0.9),
                 PlayerObs(2, "player", 0, (0,0,1,1), (3100.0, 3500.0), 0.9)], (3090.0, 3500.0))
    assert possession_changes([s0, s1], min_travel_cm=500.0)["count"] == 0   # only 80 cm travel
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```python
# append to vision/footballcv/analytics.py

def possession_changes(states, *, assign_radius_cm: float = 300.0, min_travel_cm: float = 500.0,
                       near_zone=None) -> dict:
    """Heuristic 'possession changes' (renamed from passes, §7.3). Single-camera cannot see an
    opponent touch, so this counts same-team possessor changes with ball travel >= min_travel_cm
    between two ASSIGNED frames. The weakest metric; opt-in at the report layer."""
    last = None   # (track_id, team, ball_xy)
    count = 0
    for s in states:
        if not _is_real_ball(s.ball) or not in_near_zone(s.ball.pitch_xy, near_zone):
            continue
        team = nearest_team(s.ball.pitch_xy, s.players, assign_radius_cm=assign_radius_cm)
        if team is None:
            continue
        # which non-GK player of that team is nearest = the possessor id
        pid = min(((float(np.hypot(p.pitch_xy[0]-s.ball.pitch_xy[0], p.pitch_xy[1]-s.ball.pitch_xy[1])), p.track_id)
                   for p in s.players if p.team == team and p.cls != "goalkeeper" and p.pitch_xy is not None),
                  default=(None, None))[1]
        if last is not None and pid is not None and pid != last[0] and team == last[1]:
            travel = float(np.hypot(s.ball.pitch_xy[0]-last[2][0], s.ball.pitch_xy[1]-last[2][1]))
            if travel >= min_travel_cm:
                count += 1
        if pid is not None:
            last = (pid, team, s.ball.pitch_xy)
    return {"count": count, "min_travel_m": min_travel_cm / 100.0, "heuristic": True,
            "note": "renamed from 'passes'; single-camera, no opponent-touch detection; weakest metric"}
```

- [ ] **Step 4: Run to verify it passes.** Checkpoint — green.

---

## Task 4: Team shape per time bucket (`analytics.py`)

Per team per time bucket: **centroid (cm)**, **convex-hull surface area (m²)**, **spread (m)** — the GPS Track-A shape *vocabulary*, but **pitch-aligned**. **GKs excluded** (a GK pinned to the box distorts compactness).

**Files:** Create `test/test_analytics_teamshape.py`. Extend `analytics.py`.

**Interfaces — Produces:**
- `convex_hull_area_m2(points_cm) -> float` (0 for < 3 points).
- `team_shape_series(states, team, *, bucket_s=5.0) -> list[dict]` → per bucket `{t_s, centroid_cm:[x,y], hull_area_m2, spread_m, n}` over that team's **non-GK** players with `pitch_xy`.

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_analytics_teamshape.py
import numpy as np
from footballcv.analytics import team_shape_series, convex_hull_area_m2
from footballcv.types import PlayerObs, BallObs, WorldState

def _ws(i, players):
    return WorldState(i, i / 5.0, "raw", players, BallObs(None, None, 0.0, False))

def test_hull_area_of_a_known_square():
    # a 1000 cm x 1000 cm square = 100 m^2
    pts = [(0.0, 0.0), (1000.0, 0.0), (1000.0, 1000.0), (0.0, 1000.0)]
    assert abs(convex_hull_area_m2(pts) - 100.0) < 1e-6

def test_team_shape_excludes_gk_and_buckets_by_time():
    players = [PlayerObs(1, "player", 0, (0,0,1,1), (2000.0, 3000.0), 0.9),
               PlayerObs(2, "player", 0, (0,0,1,1), (4000.0, 4000.0), 0.9),
               PlayerObs(9, "goalkeeper", 0, (0,0,1,1), (200.0, 3500.0), 0.9)]  # GK far left
    states = [_ws(i, players) for i in range(10)]   # 2 s @5fps -> buckets of 5 frames (1 s)
    series = team_shape_series(states, team=0, bucket_s=1.0)
    assert len(series) == 2
    # centroid is the mean of the TWO outfielders only (GK excluded) -> x ~ 3000, not pulled to 200
    assert abs(series[0]["centroid_cm"][0] - 3000.0) < 1.0
    assert series[0]["n"] == 2

def test_team_shape_handles_buckets_with_no_players():
    states = [_ws(0, [])]
    assert team_shape_series(states, team=0, bucket_s=1.0) == []
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** (use the cv2-free hull area via the shoelace on a numpy convex hull; `scipy` is NOT a dep, so use `cv2.convexHull`/`cv2.contourArea` which IS available, mirroring `radar.py`/`calibrate.py`).

```python
# append to vision/footballcv/analytics.py
import cv2

def convex_hull_area_m2(points_cm) -> float:
    pts = np.asarray(points_cm, np.float32)
    if len(pts) < 3:
        return 0.0
    hull = cv2.convexHull(pts)
    return float(cv2.contourArea(hull)) / 10000.0      # cm^2 -> m^2

def _spread_m(points_cm) -> float:
    pts = np.asarray(points_cm, float)
    if len(pts) < 2:
        return 0.0
    c = pts.mean(axis=0)
    return float(np.linalg.norm(pts - c, axis=1).mean()) / 100.0   # mean radial dist, cm -> m

def team_shape_series(states, team: int, *, bucket_s: float = 5.0) -> list:
    if not states:
        return []
    t0 = states[0].frame_ts
    buckets: dict = {}
    for s in states:
        b = int((s.frame_ts - t0) // bucket_s)
        pts = [p.pitch_xy for p in s.players
               if p.team == team and p.cls != "goalkeeper" and p.pitch_xy is not None]
        if pts:
            buckets.setdefault(b, []).extend(pts)
    series = []
    for b in sorted(buckets):
        pts = np.asarray(buckets[b], float)
        series.append({"t_s": t0 + b * bucket_s,
                       "centroid_cm": [float(pts[:, 0].mean()), float(pts[:, 1].mean())],
                       "hull_area_m2": convex_hull_area_m2(pts),
                       "spread_m": _spread_m(pts), "n": int(len(pts))})
    return series
```

> Note the honest caveat for the report: CV team-shape is **pitch-aligned** (true length×width), NOT orientation-free like the GPS Track-A series — they are not directly comparable without the §5/§4 adapter (§7.3).

- [ ] **Step 4: Run to verify it passes.** Checkpoint — green.

---

## Task 5: Assemble `stats.json` (`analytics.py` — `build_stats`)

Compose Tasks 1–4 + provenance into the **§7.4 schema** dict. Provenance flags carry the honesty (`heuristic:true`, `ids:"raw"`, the model/tracker/seed/device fields). Possession-changes only present when `passes=True`.

**Files:** Create `test/test_analytics_stats.py` (this file covers Task 5 + Task 6). Extend `analytics.py`.

**Interfaces — Produces:** `build_stats(states, *, clip_meta:dict, provenance:dict, assign_radius_cm=300.0, near_zone=None, move_floor_cm=150.0, smooth_window=3, max_speed_ceiling_ms=10.0, bucket_s=5.0, passes=False) -> dict` returning the §7.4 shape.

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_analytics_stats.py
from footballcv.analytics import build_stats, write_summary
from footballcv.types import PlayerObs, BallObs, WorldState

def _states():
    out = []
    for i in range(10):
        out.append(WorldState(i, i / 5.0, "raw",
            [PlayerObs(7, "player", 0, (0,0,1,1), (3000.0 + 50.0*i, 3500.0), 0.9),
             PlayerObs(8, "player", 1, (0,0,1,1), (9000.0, 3500.0), 0.9)],
            BallObs((0, 0), (3010.0 + 50.0*i, 3500.0), 0.8, False)))
    return out

def test_build_stats_has_schema_shape_and_provenance():
    prov = {"detector": "football-players-detection-3zvbc", "detector_sha256": "abc",
            "ball_model_sha256": None, "tracker_config_hash": "h", "seed": 0,
            "device": "cpu", "engine": "pytorch", "vendored_sports_sha": "s",
            "vision_git_sha": None, "fine_tuned": False, "ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "samples/clip.mp4", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov, passes=False)
    assert stats["schema_version"] == 1
    assert stats["provenance"]["heuristic"] is True and stats["provenance"]["ids"] == "raw"
    assert "team0_pct" in stats["possession"] and "ball_known_fraction" in stats["possession"]
    assert {p["id"] for p in stats["players"]} == {7, 8}
    assert all(p["distance_is_lower_bound"] for p in stats["players"])
    assert "0" in stats["teams"] and "1" in stats["teams"]      # JSON-string team keys (§7.4)
    assert "possession_changes" not in stats                    # passes=False ⇒ omitted

def test_build_stats_includes_changes_only_when_passes():
    prov = {"ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "x", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov, passes=True)
    assert stats["possession_changes"]["opt_in"] is True and stats["possession_changes"]["heuristic"] is True

def test_no_player_name_anywhere_in_stats():
    import json
    prov = {"ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "x", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov)
    # the name-firewall: only numeric ids + team, never a name key/value
    blob = json.dumps(stats)
    assert "name" not in blob.lower()
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `build_stats`**

```python
# append to vision/footballcv/analytics.py

def build_stats(states, *, clip_meta: dict, provenance: dict, assign_radius_cm: float = 300.0,
                near_zone=None, move_floor_cm: float = 150.0, smooth_window: int = 3,
                max_speed_ceiling_ms: float = 10.0, bucket_s: float = 5.0, passes: bool = False) -> dict:
    poss = possession(states, assign_radius_cm=assign_radius_cm, near_zone=near_zone)
    pm = per_player_metrics(states, move_floor_cm=move_floor_cm, smooth_window=smooth_window,
                            max_speed_ceiling_ms=max_speed_ceiling_ms)
    stats = {
        "schema_version": 1,
        "clip": clip_meta,
        "provenance": {**provenance, "ids": provenance.get("ids", "raw"),
                       "heuristic": provenance.get("heuristic", True)},
        "possession": {
            "team0_pct": round(poss["team0_pct"], 1), "team1_pct": round(poss["team1_pct"], 1),
            "confidence": poss["confidence"], "ball_known_fraction": round(poss["ball_known_fraction"], 3),
            "zone": "near_centre_only" if near_zone is not None else "all",
            "far_side": poss["far_side"], "assign_radius_m": poss["assign_radius_m"]},
        "teams": {str(t): {"label": ("left-at-kickoff" if t == 0 else "right-at-kickoff"),
                           "shape": team_shape_series(states, t, bucket_s=bucket_s)} for t in (0, 1)},
        "players": [{"id": tid, "team": m["team"], "distance_m": round(m["distance_m"], 1),
                     "distance_is_lower_bound": True, "max_speed_ms": round(m["max_speed_ms"], 1),
                     "clamped_outlier_segments": m["clamped_outlier_segments"]}
                    for tid, m in sorted(pm.items())],
    }
    if passes:
        ch = possession_changes(states, assign_radius_cm=assign_radius_cm, near_zone=near_zone)
        stats["possession_changes"] = {**ch, "opt_in": True}
    return stats
```

- [ ] **Step 4: Run to verify it passes** (Task 5 tests). Checkpoint — green.

---

## Task 6: `summary.txt` + `write_stats` (`analytics.py`)

A one-screen, human-readable summary, and a thin writer that dumps `stats.json` + `summary.txt` into `out_dir`. Honesty front-and-centre: the confidence label, `ball_known_fraction`, "distances are lower bounds", "far-side possession not computed".

**Files:** Extend `analytics.py`. Tests added to `test/test_analytics_stats.py`.

**Interfaces — Produces:** `write_summary(stats) -> str` (the text); `write_stats(stats, out_dir) -> tuple[str,str]` (writes `stats.json` + `summary.txt`, returns their paths).

- [ ] **Step 1: Add failing tests to `test/test_analytics_stats.py`**

```python
def test_summary_is_readable_and_flags_honesty():
    prov = {"ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "samples/clip.mp4", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov)
    txt = write_summary(stats)
    assert "Possession" in txt and "lower bound" in txt.lower()
    assert "heuristic" in txt.lower() or "unvalidated" in txt.lower()
    assert txt.count("\n") < 40                       # fits one screen

def test_write_stats_emits_both_files(tmp_path):
    import json, os
    prov = {"ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "x", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov)
    sj, st = write_stats(stats, str(tmp_path))
    assert os.path.exists(sj) and os.path.exists(st)
    assert json.loads(open(sj).read())["schema_version"] == 1
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```python
# append to vision/footballcv/analytics.py
import json
from pathlib import Path

def write_summary(stats: dict) -> str:
    p = stats["possession"]
    lines = [
        f"Clip: {stats['clip'].get('source','?')}  "
        f"({stats['clip'].get('frames_analysed','?')} frames @ {stats['clip'].get('sample_fps','?')} fps)",
        f"Possession (near-centre only): T0 {p['team0_pct']}%  T1 {p['team1_pct']}%   "
        f"[confidence={p['confidence']}, ball_known={p['ball_known_fraction']}, far_side={p['far_side']}]",
        "",
        "Per-player (distances are NOISE-FLOORED LOWER BOUNDS, not true totals):",
    ]
    for pl in stats["players"]:
        lines.append(f"  #{pl['id']} T{pl['team']}: dist≈{pl['distance_m']} m (lower bound), "
                     f"peak {pl['max_speed_ms']} m/s, clamped {pl['clamped_outlier_segments']}")
    if "possession_changes" in stats:
        c = stats["possession_changes"]
        lines += ["", f"Possession changes (HEURISTIC, single-camera): {c['count']}  "
                      f"(min travel {c['min_travel_m']} m) — weakest metric, not 'passes'"]
    lines += ["", "All metrics are movement-derived, UNVALIDATED heuristics (no ground truth). "
                  "Metrics key on RAW track ids: a player re-appearing after occlusion gets a new id."]
    return "\n".join(lines)

def write_stats(stats: dict, out_dir: str) -> tuple:
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    sj, st = out / "stats.json", out / "summary.txt"
    sj.write_text(json.dumps(stats, indent=2))
    st.write_text(write_summary(stats))
    return str(sj), str(st)
```

- [ ] **Step 4: Run to verify it passes** (all of `test_analytics_stats.py`). Checkpoint — green.

---

## Task 7: Wire `run_v3` + CLI (`pipeline.py`)

Add `run_v3` (build the v2 `WorldState` stream, then `build_stats` + `write_stats`) and `--stats`/`--passes` flags. The live detect/track/ball loop body stays a flagged `...` stub (it needs weights + a clip; exercised at the acceptance run) — only the **analytics wiring + provenance assembly** is added here, and tested with a mocked `WorldState` stream so it runs in the CPU image.

**Files:** Extend `pipeline.py`. Create `test/test_pipeline_v3.py`.

**Interfaces — Produces:** `run_v3(input, out_dir, *, device, sample_fps, imgsz, models_dir, calibration, passes=False, world_states=None) -> dict` — when `world_states` is injected (tests), skip the live loop and run analytics directly; otherwise build the stream via the v2 path (stub body) then analytics. `main` gains `--stats`/`--passes`, routing `--stats` to `run_v3`.

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_pipeline_v3.py
import ast, json, os
from pathlib import Path
from footballcv.types import PlayerObs, BallObs, WorldState

PIPE = Path(__file__).resolve().parents[1] / "footballcv" / "pipeline.py"

def test_pipeline_v3_does_not_import_fetch_models():
    tree = ast.parse(PIPE.read_text())
    mods = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import): mods |= {a.name for a in n.names}
        if isinstance(n, ast.ImportFrom): mods.add(n.module or "")
    assert not any("fetch_models" in m for m in mods)

def test_run_v3_writes_stats_from_injected_world_states(tmp_path):
    from footballcv.pipeline import run_v3
    states = []
    for i in range(10):
        states.append(WorldState(i, i / 5.0, "raw",
            [PlayerObs(7, "player", 0, (0,0,1,1), (3000.0 + 50*i, 3500.0), 0.9),
             PlayerObs(8, "player", 1, (0,0,1,1), (9000.0, 3500.0), 0.9)],
            BallObs((0,0), (3010.0 + 50*i, 3500.0), 0.8, False)))
    out = run_v3("ignored.mp4", str(tmp_path), world_states=states,
                 device="cpu", sample_fps=5.0, passes=True)
    sj = os.path.join(str(tmp_path), "stats.json")
    assert os.path.exists(sj)
    stats = json.loads(open(sj).read())
    assert stats["schema_version"] == 1 and stats["provenance"]["ids"] == "raw"
    assert "possession_changes" in stats                       # passes=True
    assert out["out"] == str(tmp_path)
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `run_v3` + CLI in `pipeline.py`**

```python
# add to vision/footballcv/pipeline.py
def run_v3(input: str, out_dir: str, *, device="cuda", sample_fps=5.0, imgsz=1280,
           models_dir="models", calibration="config/calibration.yaml",
           passes=False, world_states=None) -> dict:
    from footballcv.analytics import build_stats, write_stats
    from footballcv.models_io import load_manifest
    if world_states is None:
        # Build the v2 pitch-space WorldState stream (detect+track+ball+project). The live loop
        # body is the Task-8/acceptance integration (needs weights + a clip) — flagged stub.
        manifest = load_manifest(Path(models_dir))
        prov_detector = manifest["weights"]["players"]["model_version"]
        prov_sha = manifest["weights"]["players"]["sha256"]
        ...
        world_states = []      # replaced by the real stream on the GPU/cpu-run path
    else:
        prov_detector, prov_sha = "injected", None
    provenance = {"detector": prov_detector, "detector_sha256": prov_sha, "ball_model_sha256": None,
                  "tracker_config_hash": None, "seed": 0, "device": device, "engine": "pytorch",
                  "vendored_sports_sha": None, "vision_git_sha": None, "fine_tuned": False,
                  "ids": "raw", "heuristic": True}
    clip_meta = {"source": input, "duration_s": (world_states[-1].frame_ts if world_states else 0.0),
                 "sample_fps": sample_fps, "frames_analysed": len(world_states)}
    stats = build_stats(world_states, clip_meta=clip_meta, provenance=provenance, passes=passes)
    write_stats(stats, out_dir)
    return {"provenance": provenance, "out": out_dir, "stats_frames": len(world_states)}
```
Add to `main`: `ap.add_argument("--stats", action="store_true")`, `ap.add_argument("--passes", action="store_true")`, and when `--stats` is set, call `run_v3(... passes=args.passes)` (else the existing v1/v2 routing). Keep the offline guards first and do NOT import `fetch_models`.

- [ ] **Step 4: Run to verify it passes.** Checkpoint — full suite green.

---

## Task 8: Acceptance addendum (owner's RTX 3060 / Mac cpu-run — not a unit test)

After Tasks 1–7 are green, the real-clip analytics run is folded into the existing v2 acceptance:

- [ ] Run the pipeline with `--stats` (and optionally `--passes`) on the calibrated public clip (3060 `gpu` image, or the Mac `cpu-run` image for a short clip): it writes `out/clip/stats.json` + `out/clip/summary.txt` alongside `annotated.mp4`/`radar.mp4`.
- [ ] **Verify (a) pipeline-correctness (checkable now):** `stats.json` validates against the §7.4 schema; `ball_known_fraction` present and drives the possession confidence; far-side possession reads "not_computed"; per-id distance is monotonic-nondecreasing, uses the sampled-fps timebase, applies the noise floor + smoothing (a standing player ≈ 0 m); clamped outliers counted; `max_speed_ms` is a ≥0.3 s sustained peak; **no player name anywhere** in the file.
- [ ] **Verify (b) accuracy (deferred to fine-tune):** possession directionally correct on a hand-annotated minute — **explicitly deferred** behind fine-tuning on the real target view (ADR §7 two-tier criteria). Not a v3 gate.
- [ ] Append the result (clip, possession split + confidence, a couple of player distance lower-bounds, any far-side caveat) to the `vision/README.md` "v3 acceptance" subsection.

---

## Self-Review

**1. Spec coverage (ADR §7.3 / §7.4):**
- Possession % (nearest non-GK within 3 m, near-centre only, far-side "not computed", interpolated/dead-ball undefined, `ball_known_fraction` honesty + `<0.7 ⇒ low`) → Task 1. ✓
- Distance/speed with the THREE §7.3 guards (noise floor, pre-smoothing, sampled-fps timebase + sustained ≥0.3 s peak + outlier clamp + lower-bound label) → Task 2. ✓
- Possession changes (heuristic, opt-in `--passes`, off by default, "weakest metric" note) → Task 3 + Task 5/7 gating. ✓
- Team shape per bucket (centroid/hull-area/spread, GKs excluded, pitch-aligned caveat) → Task 4. ✓
- `stats.json` §7.4 schema (provenance flags, JSON-string team keys, players list, possession block) + `summary.txt` → Tasks 5/6. ✓
- `stitch.py` correctly **NOT built** (deferred spike, §7.3). ✓
- Name-firewall (no player name in stats) → Task 5 test. ✓ Offline/no-fetch_models guard → Task 7 test. ✓

**2. Placeholder scan:** the only `...` is `run_v3`'s live-loop body (Task 7), explicitly the acceptance-run integration that needs weights+clip — every analytics function ships real, exact-value-tested code. No TODO/TBD in tested logic.

**3. Type consistency:** all functions consume the real v1 `types.py` (`WorldState.frame_ts`/`players`/`ball`, `PlayerObs.cls`/`team`/`pitch_xy`/`track_id`, `BallObs.pitch_xy`/`interpolated`); `build_stats` consumes Task 1–4 outputs; `run_v3` consumes `build_stats`/`write_stats`. `nearest_team`/`possession_changes` share the same assignment definition. cv2 is used for hull area (already a dep, as in `radar.py`/`calibrate.py`). No new dependency.

---

## Execution Handoff

Plan saved to `docs/vision/2026-06-20-v3-implementation-plan.md`. Builds on the green v1+v2 suite. Pure-Python analytics — fully testable in the CPU Docker image. Subagent-Driven or Inline execution; either way every `pytest` runs via `docker compose run --rm test`.
