# Camera/CV Track — v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of the built v1 `vision/` subproject, **detect the ball** and **project both teams + the ball onto a top-down radar**. Deliverables: the ball detected and marked on `annotated.mp4`, and a **top-down radar animation** (`radar.mp4`) showing both teams + the ball on the `SoccerPitchConfiguration` (12000×7000 cm). Land the load-bearing controls the ADR makes mandatory: a **self-grading, held-out-validated** homography calibrator, and **honest ball post-processing** (capped ≤0.5 s interpolation + `interpolated=True` + `ball_known_fraction`).

**Architecture:** v2 extends the existing one-pipeline/one-contract layout. It **implements** the three modules left as referenced-but-empty stubs in v1 — `calibrate.py`, `pitch.py`, `radar.py` — and **extends** `detect.py` (a second dedicated ball pass), `report.py` (ball marker), and `pipeline.py` (`--ball`/`--radar`, second NVENC encode). The pipeline grows to `decode → detect(players+ball) → track → teams → pitch(homography) → radar → report`. The deterministic geometry (homography projection, point-set conditioning guard) and ball post-process (single-candidate gate + capped interpolation + known-fraction) get **full unit tests**; the model-dependent ball pass gets a **contract test + a benchmark-decides-default + an acceptance run**.

**Tech Stack:** Python 3.11 · the v1 stack (Ultralytics YOLO11 · `supervision` 0.29 · `transformers` SigLIP + scikit-learn · OpenCV · torch CUDA/MPS · ffmpeg/NVENC · pytest) · **v2 adds** the dedicated `football-ball-detection-rejhg` ball model · `sv.InferenceSlicer` 2×2 tiling · OpenCV `cv2.findHomography(..., cv2.RANSAC)` + `cv2.perspectiveTransform` · the vendored `sports` `ViewTransformer` + `SoccerPitchConfiguration` · optional `filterpy` Kalman (linear fallback if absent).

**Source spec:** [ADR-0023 (build-spec form)](../decisions/0023-camera-cv-offline-analysis.md) — this plan implements **v2 only** (§7-v2): ball + homography + radar. **Not in v2:** analytics/possession/distance (§7-v3), the GoPro 360 de-warp pre-pass (§7-v4). It builds directly on the [v1 implementation plan](2026-06-19-v1-implementation-plan.md) (which delivered `decode/detect(persons)/track/teams/report(annotated)` + the privacy/reproducibility firewall).

## Global Constraints

Every task's requirements implicitly include this section. Values are inherited verbatim from the v1 plan + ADR-0023 §3/§5/§10; unchanged in v2 except where a v2-specific line is added.

- **Python 3.11** is the single pinned interpreter (`pyproject.toml` `requires-python == "3.11.*"`); 3.10–3.13 are known-compatible-but-untested.
- **Dependency pins** are unchanged from v1 (`requirements.txt` ranges, exact in `requirements.lock`): `ultralytics >=8.4.60,<8.5`, `supervision ==0.29.*`, `opencv-python` 4.x, `torch`/`torchvision` from the cu12x CUDA wheel index, `transformers`, `scikit-learn`, `numpy`, `PyYAML`, `pytest`. **v2 may add `filterpy`** (Kalman ball smoothing) as a range pin — but the ball post-process MUST degrade to a pure-numpy linear interpolation when `filterpy` is absent (no hard dependency for the deliverable).
- **Do NOT use `sv.ByteTrack`** (removed in supervision 0.30). Tracking stays BoT-SORT via Ultralytics `model.track(persist=True, tracker=<yaml>)` (unchanged from v1).
- **Roboflow `sports` is VENDORED, not installed** — v1 created `footballcv/vendor/sports/` (pinned upstream SHA, recorded in `vision/README.md`). v2 is the **first runtime consumer** of its `ViewTransformer` + `SoccerPitchConfiguration`; if the v1 vendoring only stubbed those, this plan's Task 2/Task 5 land the real copied modules at the recorded SHA. `ViewTransformer(source, target)` builds `H` via `cv2.findHomography` internally and exposes `transform_points(points:(N,2)) -> (N,2)`; `SoccerPitchConfiguration` has `length=12000`, `width=7000` (cm) and a `.vertices` property of 32 `(x_cm, y_cm)` keypoints.
- **AGPL note:** Ultralytics is AGPL-3.0; fine while `vision/` stays private/undistributed. The **ball pass is also Ultralytics YOLO**, so it sits behind the same swappable `detect` interface as the player pass — the RF-DETR escape hatch stays a contained change (ADR §5/§12-Q3). No publish planned.
- **Privacy gate (#1, non-negotiable):** PUBLIC adult/pro footage ONLY, every phase. No youth footage anywhere in v2. The v1 `vision/.gitignore` privacy firewall is already in force; v2 adds **one** ignored artifact path — the per-mount real calibration is `config/calibration.yaml` (already gitignored by v1); `config/calibration.example.yaml` stays the committed template. All tests run on synthetic fixtures or the one SHA-pinned public clip — never children's data. `radar.mp4` is a derived tactical board with **no faces**, but it is still written to the gitignored `out/`.
- **Offline guards:** unchanged — `pipeline.py` sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and disables Ultralytics analytics **unconditionally at startup**, asserts they are set, before loading any model (including the new ball model). `calibrate.py` and `pitch.py` make **no** network calls; `radar.py` makes none.
- **Determinism:** the geometry (`pitch`), the point-set guard, and the ball post-process are **fully deterministic** and bit-reproducible (pure numpy/OpenCV on fixed inputs) — they get exact-value unit tests. The model-dependent ball pass inherits the v1 caveat ("two runs identical" = anchoring/known-fraction stability, not bit-equality; CUDA is not bit-reproducible; assertions pinned to the owner's 3060).
- **GPU budget:** the 3060 has 12 GB; models load/release **one at a time**. v2 adds the ball model as a **SECOND** resident model — load the player detector, run the player pass; release; load the ball detector, run the ball pass; release; load SigLIP for teams. `yolo11x` + the ball model + SigLIP never co-resident (ADR §5).
- **Performance (ADR §10):** **two** NVENC encode passes now (`annotated.mp4` + `radar.mp4`), both **1080p** (a coach clip does not need 4K). The radar is drawn with **OpenCV, not matplotlib** (matplotlib is tens of ms/frame). The ball pass config (plain `imgsz=1280` vs 2×2 tiling) is **benchmarked and the recall-per-second winner is the default** (Task 3) — record which config the wall-clock assumes. v2+ running slow / overnight is acceptable; TensorRT is optional, not a gate.
- **VERSION CONTROL:** the repo is **NOT a git repo** today. There are therefore **no per-task git commits**; each task's checkpoint is *the full test suite green*. Where a step references git (none new in v2), it degrades gracefully when `.git` is absent.
- **EXECUTION (Docker only):** all commands run in Docker via `vision/docker-compose.yml` — never on the host. Read every `Run: pytest …` / `python -m footballcv …` step as `docker compose run --rm test` (suite) or `docker compose run --rm selftest`, from `vision/`; the GPU pipeline runs on the RTX 3060 desktop behind the `gpu` profile (`docker compose --profile gpu run --rm run …`). The host `.venv` is not used.
- **Source-driven discipline:** the OpenCV/`supervision`/vendored-`sports` calls in this plan are written against the pinned versions; the API shapes below were verified against `supervision` 0.29 (`InferenceSlicer(callback, slice_wh, overlap_wh, overlap_filter, iou_threshold)` — `overlap_wh` is **absolute pixels**, not a ratio; called as `slicer(image)`; `sv.crop_image(image=, xyxy=)`) and the vendored `sports` (`ViewTransformer`, `SoccerPitchConfiguration`). Re-confirm each against the installed versions before implementing the model/encode-touching steps. The deterministic-logic tasks (1, 2, 4, 7) are fully specified and need no external verification.

---

## File Structure

Created/extended in this plan (all under `vision/`; matches ADR §6). v1 files are listed only where v2 touches them.

```
vision/
  config/
    calibration.example.yaml  # v1 — committed template (image_points/pitch_points lists)
    calibration.yaml          # gitignored — REAL per-mount calibration, WRITTEN by calibrate.py (Task 1)
    botsort_football.yaml     # v1 — unchanged
  footballcv/
    types.py                  # v1 — UNCHANGED; BallObs/PlayerObs.pitch_xy already carry v2 fields
    detect.py                 # EXTEND (Task 3) — add BallDetector (dedicated pass, tiling-or-plain)
    pitch.py                  # NEW (Task 2) — load H from calibration, project feet + ball -> pitch_xy
    calibrate.py              # NEW (Task 1) — interactive 4+-point picker -> calibration.yaml; self-grading
    radar.py                  # NEW (Task 5) — OpenCV top-down board from the WorldState stream
    ball_postprocess.py       # NEW (Task 4) — single-candidate gate + capped interpolation + known-fraction
    report.py                 # EXTEND (Task 6) — draw ball marker on annotated frames
    pipeline.py               # EXTEND (Task 6) — --ball/--radar wiring + GK->pitch-space + 2nd NVENC pass
    vendor/sports/            # v1 — v2 is the first runtime consumer (ViewTransformer, SoccerPitchConfiguration)
  test/
    conftest.py               # v1 — EXTEND: add a synthetic-homography + synthetic-ball-track fixture
    test_calibrate.py         # NEW (Task 1)
    test_pitch.py             # NEW (Task 2)
    test_ball_detect.py       # NEW (Task 3)
    test_ball_postprocess.py  # NEW (Task 4)
    test_radar.py             # NEW (Task 5)
    test_pipeline_v2.py       # NEW (Task 6) — GK pitch-space + flag wiring (mocked models)
    test_radar_anchoring.py   # NEW (Task 7) — the §7-v2 numeric anchoring gate
```

`models/MANIFEST.json` (committed, v1) gains a verified `ball` entry — the v1 `fetch_models.py` already pulls `football-ball-detection-rejhg`; v2 is the first to **use** it via `resolve_weight("ball", ...)`.

---

## Task 1: Self-grading calibration (`calibrate.py`)

The load-bearing pre-pass for everything downstream (radar + possession). Interactive 4+-point picker writes `config/calibration.yaml`; **self-grades on HELD-OUT points** (§7.2 — fit on 4, measure on the rest; reprojecting the fit points proves nothing) and **rejects near-collinear / small-convex-hull** point sets that yield an ill-conditioned `H` (a centre-clustered set gives a stable *wrong* far side). The interactive picker is a thin OpenCV-window shell; the **graded logic is pure and fully unit-tested** with a synthetic known homography.

**Files:**
- Create: `vision/footballcv/calibrate.py`, `vision/test/test_calibrate.py`
- Extend: `vision/test/conftest.py` (synthetic-homography fixture)

**Interfaces:**
- Produces: `grade_calibration(image_points:np.ndarray, pitch_points:np.ndarray, *, n_fit:int=4) -> Grade` where `Grade` has `.held_out_px_error:float`, `.verdict:str` ("GOOD"|"RE-PICK"), `.ill_conditioned:bool`, `.reason:str`; `point_set_is_degenerate(image_points:np.ndarray, *, min_hull_frac:float, min_collinearity:float) -> tuple[bool,str]`; `write_calibration(out_path:Path, image_points, pitch_points) -> dict`; `main(argv)` CLI (`--frame --at --out`) — the interactive picker (not unit-tested; exercised at the acceptance run).

- [ ] **Step 1: Add the synthetic-homography fixture**

```python
# append to vision/test/conftest.py
import numpy as np, cv2, pytest

@pytest.fixture
def known_homography():
    """A known image<->pitch homography + 8 well-separated correspondences.
    Pitch points are cm on the 12000x7000 SoccerPitchConfiguration; image points
    are their projection through a fixed, deliberately-perspective H (so fit-on-4 /
    measure-on-rest has real, non-trivial held-out error near zero but not exactly 0)."""
    pitch = np.array([[0, 0], [12000, 0], [12000, 7000], [0, 7000],
                      [6000, 0], [6000, 7000], [6000, 3500], [0, 3500]], np.float32)
    # a plausible elevated-wide camera homography (pitch cm -> image px)
    H = np.array([[0.05, 0.004, 60.0],
                  [0.0,  0.03,  40.0],
                  [0.0,  3e-6,  1.0]], np.float32)
    img = cv2.perspectiveTransform(pitch.reshape(-1, 1, 2), H).reshape(-1, 2)
    return {"image_points": img.astype(np.float32),
            "pitch_points": pitch, "H": H}
```

- [ ] **Step 2: Write the failing tests**

```python
# vision/test/test_calibrate.py
import numpy as np, pytest
from footballcv.calibrate import grade_calibration, point_set_is_degenerate

def test_held_out_error_is_small_for_a_consistent_point_set(known_homography):
    g = grade_calibration(known_homography["image_points"],
                          known_homography["pitch_points"], n_fit=4)
    # fit on 4, measure on the other 4: a consistent set reprojects tightly
    assert g.held_out_px_error < 2.0
    assert g.verdict == "GOOD"
    assert g.ill_conditioned is False

def test_inconsistent_point_corrupts_held_out_error(known_homography):
    img = known_homography["image_points"].copy()
    img[5] += np.array([80.0, 80.0])              # shove one HELD-OUT point off
    g = grade_calibration(img, known_homography["pitch_points"], n_fit=4)
    assert g.held_out_px_error > 5.0 and g.verdict == "RE-PICK"

def test_rejects_near_collinear_point_set():
    # all image points on (almost) one line -> ill-conditioned H
    img = np.array([[100, 100], [200, 101], [300, 102], [400, 103],
                    [500, 104], [600, 105]], np.float32)
    bad, reason = point_set_is_degenerate(img, min_hull_frac=0.02, min_collinearity=0.15)
    assert bad and "collinear" in reason.lower()

def test_rejects_centre_clustered_small_hull_set():
    # 6 points crammed in a tiny central blob -> small convex hull -> degenerate
    img = np.array([[600, 350], [610, 352], [605, 360], [615, 358],
                    [608, 354], [612, 356]], np.float32)
    bad, reason = point_set_is_degenerate(img, min_hull_frac=0.02, min_collinearity=0.15)
    assert bad and "hull" in reason.lower()

def test_grade_flags_degenerate_set_as_ill_conditioned(known_homography):
    img = np.array([[100, 100], [200, 101], [300, 102], [400, 103],
                    [500, 104], [600, 105], [700, 106], [800, 107]], np.float32)
    g = grade_calibration(img, known_homography["pitch_points"], n_fit=4)
    assert g.ill_conditioned is True and g.verdict == "RE-PICK"
```

- [ ] **Step 3: Run to verify it fails**

Run: `python -m pytest vision/test/test_calibrate.py -v`
Expected: FAIL — `ModuleNotFoundError: footballcv.calibrate`.

- [ ] **Step 4: Implement `calibrate.py`**

```python
# vision/footballcv/calibrate.py
from dataclasses import dataclass
from pathlib import Path
import numpy as np
import cv2
import yaml

GOOD_PX_THRESHOLD = 5.0     # held-out reprojection error ceiling near the named region (§7.2, seed)

@dataclass
class Grade:
    held_out_px_error: float   # mean reprojection error on the HELD-OUT points (px)
    verdict: str               # "GOOD" | "RE-PICK"
    ill_conditioned: bool      # near-collinear / small-hull point set
    reason: str

def _convex_hull_area(pts: np.ndarray) -> float:
    hull = cv2.convexHull(pts.astype(np.float32))
    return float(cv2.contourArea(hull))

MIN_HULL_AREA_PX = 2000.0   # absolute convex-hull floor (px^2); see (c) below

def point_set_is_degenerate(image_points: np.ndarray, *, min_hull_frac: float = 0.02,
                            min_collinearity: float = 0.15) -> tuple[bool, str]:
    """Reject sets that make H ill-conditioned (§7.2): (a) near-collinear (the points'
    spread is essentially 1-D), (b) a small convex hull relative to their bounding box, or
    (c) an absolutely tiny convex hull (centre-clustered -> confidently-wrong far side)."""
    pts = np.asarray(image_points, np.float32)
    if len(pts) < 4:
        return True, "need >= 4 points"
    # (a) collinearity: ratio of the smaller to larger PCA singular value of the centred set
    centred = pts - pts.mean(axis=0)
    sv = np.linalg.svd(centred, compute_uv=False)
    spread_ratio = float(sv[1] / sv[0]) if sv[0] > 0 else 0.0
    if spread_ratio < min_collinearity:
        return True, f"near-collinear (spread ratio {spread_ratio:.3f} < {min_collinearity})"
    hull_area = _convex_hull_area(pts)
    # (b) small convex hull vs bounding box (relative)
    bbox = (pts[:, 0].max() - pts[:, 0].min()) * (pts[:, 1].max() - pts[:, 1].min())
    hull_frac = hull_area / bbox if bbox > 0 else 0.0
    if hull_frac < min_hull_frac:
        return True, f"small convex hull (hull frac {hull_frac:.3f} < {min_hull_frac})"
    # (c) absolutely tiny convex hull = centre-clustered blob. The relative (b) check alone
    # passes a tight blob whose hull still fills its own tiny bbox; an absolute floor catches it.
    if hull_area < MIN_HULL_AREA_PX:
        return True, f"small convex hull (hull area {hull_area:.0f} px^2 < {MIN_HULL_AREA_PX:.0f})"
    return False, "ok"

def grade_calibration(image_points: np.ndarray, pitch_points: np.ndarray, *,
                      n_fit: int = 4) -> Grade:
    """Fit H on the first n_fit correspondences, measure reprojection error on the REST
    (held-out, §7.2). Reprojecting the fit points is ~0 by construction and proves nothing."""
    img = np.asarray(image_points, np.float32)
    pit = np.asarray(pitch_points, np.float32)
    degenerate, reason = point_set_is_degenerate(img)
    if degenerate:
        return Grade(held_out_px_error=float("inf"), verdict="RE-PICK",
                     ill_conditioned=True, reason=reason)
    if len(img) <= n_fit:
        raise ValueError(f"need > {n_fit} points so some are held out for validation")
    H, _ = cv2.findHomography(img[:n_fit], pit[:n_fit], cv2.RANSAC)
    if H is None:
        return Grade(float("inf"), "RE-PICK", True, "findHomography failed (degenerate fit)")
    held_img, held_pit = img[n_fit:], pit[n_fit:]
    # Error reported in PIXELS at the held-out points: map the KNOWN held-out pitch coords back
    # to image via H^-1 and compare to the ACTUAL held-out image points. (NOT a round-trip of the
    # same image point through H then H^-1 — that is identity by construction and always reports
    # ~0, so it never detects a corrupted held-out correspondence.)
    Hinv = np.linalg.inv(H)
    pred_img = cv2.perspectiveTransform(held_pit.reshape(-1, 1, 2), Hinv).reshape(-1, 2)
    px_err = float(np.linalg.norm(pred_img - held_img, axis=1).mean())
    verdict = "GOOD" if px_err <= GOOD_PX_THRESHOLD else "RE-PICK"
    return Grade(held_out_px_error=px_err, verdict=verdict,
                 ill_conditioned=False, reason="ok" if verdict == "GOOD" else "held-out error high")

def write_calibration(out_path: Path, image_points, pitch_points) -> dict:
    data = {"image_points": np.asarray(image_points, float).tolist(),
            "pitch_points": np.asarray(pitch_points, float).tolist()}
    Path(out_path).write_text(yaml.safe_dump(data, sort_keys=False))
    return data

def _pick_points_interactive(frame, at):
    """OpenCV-window click picker (not unit-tested; exercised at the acceptance run).
    Click >= 6 well-separated pitch landmarks; type the matching pitch (cm) coords at the
    prompt. Returns (image_points, pitch_points). Verify cv2.setMouseCallback usage on-box."""
    raise NotImplementedError("interactive picker — run via `python -m footballcv.calibrate`")

def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser("footballcv.calibrate")
    ap.add_argument("--frame", required=True); ap.add_argument("--at", default="00:00:30")
    ap.add_argument("--out", default="config/calibration.yaml")
    args = ap.parse_args(argv)
    cap = cv2.VideoCapture(args.frame)
    # seek to --at, grab one frame, pick points (interactive)
    ok, frame = cap.read(); cap.release()
    if not ok:
        print("could not read a frame"); return 2
    image_points, pitch_points = _pick_points_interactive(frame, args.at)
    g = grade_calibration(np.array(image_points), np.array(pitch_points))
    print(f"held-out reprojection error = {g.held_out_px_error:.2f} px -> {g.verdict}"
          f"{'' if not g.ill_conditioned else ' (ILL-CONDITIONED: ' + g.reason + ')'}")
    if g.verdict != "GOOD":
        print("RE-PICK: choose more spread-out, non-collinear landmarks (§7.2)."); return 1
    write_calibration(Path(args.out), image_points, pitch_points)
    print(f"wrote {args.out}"); return 0

if __name__ == "__main__":
    import sys; sys.exit(main())
```

> `_pick_points_interactive` is the only network-free-but-UI piece, deliberately not unit-tested (it needs a window + a human); the graded logic it feeds is fully covered. The `min_hull_frac`/`min_collinearity` thresholds are seeds (§7.2) — tune against a real frame at the acceptance run.

- [ ] **Step 5: Run to verify it passes**

Run: `python -m pytest vision/test/test_calibrate.py -v` → PASS (5 tests). Checkpoint — full suite green.

---

## Task 2: Homography projection (`pitch.py`)

Load `H` (or the correspondences) from `config/calibration.yaml`, project player **feet** points (bottom-centre of bbox) and the ball point to `pitch_xy` via a **constant** homography (`cv2.perspectiveTransform`). Wraps the vendored `sports` `ViewTransformer`. Fully unit-tested with the known homography; documents the feet-on-ground-plane caveat.

**Files:**
- Create: `vision/footballcv/pitch.py`, `vision/test/test_pitch.py`

**Interfaces:**
- Consumes: a loaded calibration + image-space points (feet / ball).
- Produces: `feet_point(image_bbox:tuple) -> tuple` (bottom-centre); `class PitchProjector` built from a calibration dict (`from_calibration_file(path) -> PitchProjector`) with `project(points_xy:np.ndarray) -> np.ndarray` ((N,2) px → (N,2) cm) and `project_worldstate(ws:WorldState) -> WorldState` (fills `PlayerObs.pitch_xy` from feet + `BallObs.pitch_xy` from `image_xy`); the constant `H` is built once at construction.

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_pitch.py
import numpy as np
from footballcv.pitch import PitchProjector, feet_point
from footballcv.types import PlayerObs, BallObs, WorldState

def test_feet_point_is_bottom_centre_of_bbox():
    assert feet_point((10, 20, 30, 80)) == (20.0, 80.0)

def test_projection_recovers_known_pitch_points(known_homography):
    proj = PitchProjector(image_points=known_homography["image_points"],
                          pitch_points=known_homography["pitch_points"])
    out = proj.project(known_homography["image_points"])
    # image points were generated FROM the pitch points through H -> recover them
    assert np.allclose(out, known_homography["pitch_points"], atol=1.0)

def test_project_worldstate_fills_feet_and_ball(known_homography):
    proj = PitchProjector(image_points=known_homography["image_points"],
                          pitch_points=known_homography["pitch_points"])
    # a player whose FEET land exactly on a known image point -> known pitch point
    feet_img = tuple(known_homography["image_points"][0])      # corner (0,0) cm
    bbox = (feet_img[0] - 5, feet_img[1] - 40, feet_img[0] + 5, feet_img[1])
    ball_img = tuple(known_homography["image_points"][6])      # centre (6000,3500)
    ws = WorldState(0, 0.0, "raw",
                    [PlayerObs(1, "player", 0, bbox, None, 0.9)],
                    BallObs(image_xy=ball_img, pitch_xy=None, confidence=0.8, interpolated=False))
    out = proj.project_worldstate(ws)
    assert np.allclose(out.players[0].pitch_xy, [0.0, 0.0], atol=2.0)
    assert np.allclose(out.ball.pitch_xy, [6000.0, 3500.0], atol=2.0)

def test_project_worldstate_leaves_ball_none_when_no_detection(known_homography):
    proj = PitchProjector(image_points=known_homography["image_points"],
                          pitch_points=known_homography["pitch_points"])
    ws = WorldState(0, 0.0, "raw", [],
                    BallObs(image_xy=None, pitch_xy=None, confidence=0.0, interpolated=False))
    assert proj.project_worldstate(ws).ball.pitch_xy is None
```

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `pitch.py`**

```python
# vision/footballcv/pitch.py
from __future__ import annotations
from dataclasses import replace
from pathlib import Path
import numpy as np
import yaml

def feet_point(image_bbox: tuple) -> tuple:
    """Bottom-centre of the bbox = where the player meets the ground plane.
    CAVEAT (§7-v2): this assumes the feet are VISIBLE and on the ground. A clipped or
    occluded far-side bbox bottom, or a jumping player, projects WRONG even with a perfect
    H — a distinct pitch_xy error source from the homography itself (documented, not fixed)."""
    x1, y1, x2, y2 = image_bbox
    return ((x1 + x2) / 2.0, float(y2))

class PitchProjector:
    """Constant-H projector for a fixed-cam clip. Wraps the vendored `sports` ViewTransformer
    (which builds H via cv2.findHomography and projects via cv2.perspectiveTransform)."""
    def __init__(self, image_points, pitch_points):
        from footballcv.vendor.sports import ViewTransformer   # vendored, pinned SHA (§5)
        self._vt = ViewTransformer(source=np.asarray(image_points, np.float32),
                                   target=np.asarray(pitch_points, np.float32))

    @classmethod
    def from_calibration_file(cls, path: str | Path) -> "PitchProjector":
        data = yaml.safe_load(Path(path).read_text())
        return cls(image_points=data["image_points"], pitch_points=data["pitch_points"])

    def project(self, points_xy: np.ndarray) -> np.ndarray:
        pts = np.asarray(points_xy, np.float32).reshape(-1, 2)
        return self._vt.transform_points(pts)

    def project_worldstate(self, ws):
        players = []
        for p in ws.players:
            xy = self.project(np.array([feet_point(p.image_bbox)]))[0]
            players.append(replace(p, pitch_xy=(float(xy[0]), float(xy[1]))))
        ball = ws.ball
        if ball.image_xy is not None:
            bxy = self.project(np.array([ball.image_xy]))[0]
            ball = replace(ball, pitch_xy=(float(bxy[0]), float(bxy[1])))
        return replace(ws, players=players, ball=ball)
```

> If the v1 vendoring left `vendor/sports/__init__.py` a stub, this is where the real `ViewTransformer` (and `SoccerPitchConfiguration` for Task 5) gets copied in at the recorded SHA. Verify `transform_points` accepts/returns `(N,2)` float32 against the vendored copy.

- [ ] **Step 4: Run to verify it passes** → PASS (4 tests).

- [ ] **Step 5: Checkpoint** — full suite green.

---

## Task 3: Dedicated ball detection pass (`detect.py` extension)

Extend `detect.py` with the `football-ball-detection-rejhg` pass. **Benchmark plain `imgsz=1280` vs `sv.InferenceSlicer` 2×2 tiling** for recall-per-second and make the winner the default (2×2 tiling MATCHES the model's training regime — a benchmark-decides-default, NOT a slow opt-in). Loads as a **SECOND** model (one resident at a time, 12 GB). Contract-tested with a mock; the recall benchmark runs at the acceptance step.

**Files:**
- Extend: `vision/footballcv/detect.py`
- Create: `vision/test/test_ball_detect.py`

**Interfaces:**
- Consumes: a frame `np.ndarray`.
- Produces: `class BallDetector` with `detect(frame) -> sv.Detections` (ball class only); a `tiling: bool` ctor flag (False = plain `imgsz=1280`, True = `sv.InferenceSlicer` 2×2); `best_ball_candidate(det:sv.Detections) -> tuple[float,float,float]|None` (the single highest-confidence ball `(x, y, conf)` from a `Detections`, image-centre of the bbox).

- [ ] **Step 1: Write the failing contract test (mocked model — no weights)**

```python
# vision/test/test_ball_detect.py
import numpy as np
import supervision as sv
from footballcv.detect import BallDetector, best_ball_candidate

class _FakeBallModel:
    names = {0: "ball"}
    def predict(self, frame, **kw):
        class _R: ...
        return [_R()]

def test_ball_detector_keeps_only_ball_class(monkeypatch):
    import footballcv.detect as d
    det = sv.Detections(xyxy=np.array([[10, 10, 16, 16], [50, 50, 70, 90]], float),
                        confidence=np.array([0.7, 0.4]),
                        class_id=np.array([0, 0]),
                        data={"class_name": np.array(["ball", "player"])})
    monkeypatch.setattr(d, "_detections_from_model_result", lambda r, names: det)
    out = BallDetector(model=_FakeBallModel(), tiling=False).detect(np.zeros((96, 128, 3), np.uint8))
    assert set(out.data["class_name"]) == {"ball"}
    assert len(out) == 1

def test_best_ball_candidate_picks_highest_confidence_centre():
    det = sv.Detections(xyxy=np.array([[10, 10, 16, 16], [40, 40, 46, 46]], float),
                        confidence=np.array([0.6, 0.9]),
                        class_id=np.array([0, 0]),
                        data={"class_name": np.array(["ball", "ball"])})
    x, y, c = best_ball_candidate(det)
    assert (round(x), round(y), c) == (43, 43, 0.9)        # centre of the 0.9 box

def test_best_ball_candidate_none_when_empty():
    assert best_ball_candidate(sv.Detections.empty()) is None

def test_tiling_flag_uses_inference_slicer(monkeypatch):
    import footballcv.detect as d
    calls = {"sliced": 0}
    class _FakeSlicer:
        def __init__(self, callback, **kw): self.callback = kw or callback
        def __call__(self, image):
            calls["sliced"] += 1
            return sv.Detections.empty()
    monkeypatch.setattr(d.sv, "InferenceSlicer", _FakeSlicer)
    BallDetector(model=_FakeBallModel(), tiling=True).detect(np.zeros((96, 128, 3), np.uint8))
    assert calls["sliced"] == 1                            # tiling path routed through the slicer
```

- [ ] **Step 2: Run to verify it fails** → FAIL (`BallDetector` missing).

- [ ] **Step 3: Extend `detect.py`**

```python
# append to vision/footballcv/detect.py
BALL_CLASS = "ball"

def best_ball_candidate(det: "sv.Detections") -> tuple[float, float, float] | None:
    """The single highest-confidence ball detection as (x_centre, y_centre, conf)."""
    if len(det) == 0:
        return None
    i = int(np.argmax(det.confidence))
    x1, y1, x2, y2 = det.xyxy[i]
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0, float(det.confidence[i]))

class BallDetector:
    """Dedicated small-ball pass (football-ball-detection-rejhg). Loads as a SECOND model
    (one resident at a time, 12 GB — release the player detector first, §5).
    `tiling`: False = plain imgsz=1280; True = sv.InferenceSlicer 2x2 (matches the model's
    2x2-tiled-640 training regime). The recall-per-second winner is the DEFAULT (benchmark in
    the acceptance run); `tiling` defaults to the benchmarked winner once known."""
    def __init__(self, weight_path: str | None = None, device: str = "cuda",
                 imgsz: int = 1280, conf: float = 0.2, tiling: bool = False, model=None):
        if model is None:
            from ultralytics import YOLO            # AGPL; private use only
            model = YOLO(weight_path)
        self.model, self.device, self.imgsz, self.conf, self.tiling = \
            model, device, imgsz, conf, tiling

    def _predict_plain(self, frame: np.ndarray) -> "sv.Detections":
        result = self.model.predict(frame, device=self.device, imgsz=self.imgsz,
                                    conf=self.conf, verbose=False)[0]
        return _ball_only(_detections_from_model_result(result, getattr(self.model, "names", {})))

    def detect(self, frame: np.ndarray) -> "sv.Detections":
        if not self.tiling:
            return self._predict_plain(frame)
        # 2x2 tiling: slice_wh = half the frame, overlap_wh ~100 px, NMS to dedupe seams.
        # supervision 0.29: InferenceSlicer(callback, slice_wh, overlap_wh, overlap_filter, iou_threshold)
        h, w = frame.shape[:2]
        slicer = sv.InferenceSlicer(
            callback=lambda tile: self._predict_plain(tile),
            slice_wh=(w // 2 + 100, h // 2 + 100),
            overlap_wh=(100, 100),
            overlap_filter=sv.OverlapFilter.NON_MAX_SUPPRESSION,
            iou_threshold=0.1)
        return _ball_only(slicer(frame))

def _ball_only(det: "sv.Detections") -> "sv.Detections":
    names = det.data.get("class_name") if det.data else None
    if names is None:
        return det
    keep = np.array([n == BALL_CLASS for n in names])
    return det[keep]
```

> The `tiling` default is set to whichever config wins the acceptance-run benchmark (recall-per-second on the 3060); record the assumed config in the run note + ADR §10. `overlap_wh` is **absolute pixels** in supervision 0.29 (verified), not a ratio. The ball model loads via `resolve_weight("ball", ...)` — SHA-verified like the player weight.

- [ ] **Step 4: Run to verify it passes** → PASS (4 tests).

- [ ] **Step 5: Checkpoint** — full suite green. (Real ball recall + the tiling-vs-plain benchmark are in the Task 8 acceptance run.)

---

## Task 4: Ball post-process — single-candidate gate + capped interpolation (`ball_postprocess.py`)

The honesty engine for the ball track (§8): from a per-frame stream of best candidates, keep the most-confident candidate near the recent centroid (**confidence floor + max-jump gate**), then **linear/Kalman interpolate across gaps capped at ≤0.5 s** with `interpolated=True`; **over-cap gaps are left empty** (no fabrication); compute `ball_known_fraction`. Fully unit-tested on a synthetic trajectory with injected gaps + an outlier.

**Files:**
- Create: `vision/footballcv/ball_postprocess.py`, `vision/test/test_ball_postprocess.py`
- Extend: `vision/test/conftest.py` (synthetic-ball-track fixture)

**Interfaces:**
- Consumes: a list of per-frame `(frame_ts, candidate_xy_or_None, conf)` (candidate = `best_ball_candidate` output's xy, or `None`).
- Produces: `gate_candidates(stream, *, conf_floor:float, max_jump_px:float) -> list[BallObs-like]` (rejects sub-floor / over-jump candidates → `None`); `interpolate_gaps(observed, frame_ts, *, max_gap_s:float) -> list[BallObs]` (fills ≤cap gaps, flags `interpolated=True`, leaves over-cap empty); `ball_known_fraction(balls:list[BallObs]) -> float`; one `postprocess_ball_track(stream, *, conf_floor, max_jump_px, max_gap_s) -> tuple[list[BallObs], float]` orchestrator.

- [ ] **Step 1: Add the synthetic-ball-track fixture**

```python
# append to vision/test/conftest.py
@pytest.fixture
def ball_track_with_gaps():
    """20 frames @10 fps. Ball moves +5px/frame in x. Frames 5-7 are MISSING (a 0.3 s gap,
    under the 0.5 s cap -> interpolatable). Frames 14-19 are MISSING (a 0.6 s gap -> over cap,
    left empty). Frame 10 carries a wild OUTLIER (+400 px jump) at high confidence."""
    fps = 10.0
    frames = []
    for i in range(20):
        ts = i / fps
        if i in (5, 6, 7) or i >= 14:
            frames.append((ts, None, 0.0))
        elif i == 10:
            frames.append((ts, (10.0 * i + 400.0, 50.0), 0.85))   # outlier jump
        else:
            frames.append((ts, (10.0 * i, 50.0), 0.7))
    return {"frames": frames, "fps": fps}
```

- [ ] **Step 2: Write the failing tests**

```python
# vision/test/test_ball_postprocess.py
import numpy as np
from footballcv.ball_postprocess import (
    postprocess_ball_track, ball_known_fraction, interpolate_gaps)

def test_outlier_is_gated_out(ball_track_with_gaps):
    balls, _ = postprocess_ball_track(ball_track_with_gaps["frames"],
                                      conf_floor=0.3, max_jump_px=150.0, max_gap_s=0.5)
    # frame 10's +400px jump must be rejected -> not a real detection there
    assert balls[10].image_xy is None or balls[10].interpolated is True

def test_under_cap_gap_is_interpolated_and_flagged(ball_track_with_gaps):
    balls, _ = postprocess_ball_track(ball_track_with_gaps["frames"],
                                      conf_floor=0.3, max_jump_px=150.0, max_gap_s=0.5)
    for i in (5, 6, 7):                      # the 0.3 s gap < 0.5 s cap -> filled, flagged
        assert balls[i].image_xy is not None and balls[i].interpolated is True
    # linearly between frame4 (x=40) and frame8 (x=80): frame6 ~= 60
    assert abs(balls[6].image_xy[0] - 60.0) < 1.0

def test_over_cap_gap_left_empty(ball_track_with_gaps):
    balls, _ = postprocess_ball_track(ball_track_with_gaps["frames"],
                                      conf_floor=0.3, max_jump_px=150.0, max_gap_s=0.5)
    for i in range(14, 20):                  # the 0.6 s tail gap > cap -> never fabricated
        assert balls[i].image_xy is None and balls[i].interpolated is False

def test_known_fraction_excludes_interpolated_and_missing(ball_track_with_gaps):
    balls, frac = postprocess_ball_track(ball_track_with_gaps["frames"],
                                         conf_floor=0.3, max_jump_px=150.0, max_gap_s=0.5)
    # known = real detections only (not interpolated, not missing); independently recomputed
    assert abs(frac - ball_known_fraction(balls)) < 1e-9
    assert 0.0 <= frac <= 1.0
    # 20 frames, 9 missing/gated, 3 interpolated -> ~8 truly-known
    assert 0.3 < frac < 0.6

def test_interpolate_respects_explicit_cap():
    # a single 1.0 s hole between two knowns at a 1 fps timebase -> over a 0.5 s cap -> empty
    from footballcv.types import BallObs
    observed = [BallObs((0.0, 0.0), None, 0.7, False), None,
                BallObs((20.0, 0.0), None, 0.7, False)]
    ts = [0.0, 1.0, 2.0]
    out = interpolate_gaps(observed, ts, max_gap_s=0.5)
    assert out[1].image_xy is None and out[1].interpolated is False
```

- [ ] **Step 3: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 4: Implement `ball_postprocess.py`**

```python
# vision/footballcv/ball_postprocess.py
from __future__ import annotations
import numpy as np
from footballcv.types import BallObs

def gate_candidates(stream, *, conf_floor: float, max_jump_px: float) -> list[BallObs | None]:
    """Keep the per-frame candidate only if it clears the confidence floor AND is within
    max_jump_px of the last accepted position (single-candidate-near-centroid, §8). Rejected
    or absent frames -> None. `stream` items are (frame_ts, xy_or_None, conf)."""
    out: list[BallObs | None] = []
    last_xy = None
    for _ts, xy, conf in stream:
        if xy is None or conf < conf_floor:
            out.append(None); continue
        if last_xy is not None and float(np.hypot(xy[0] - last_xy[0], xy[1] - last_xy[1])) > max_jump_px:
            out.append(None); continue       # max-jump gate: reject the teleport, keep last
        out.append(BallObs(image_xy=(float(xy[0]), float(xy[1])), pitch_xy=None,
                           confidence=float(conf), interpolated=False))
        last_xy = (float(xy[0]), float(xy[1]))
    return out

def interpolate_gaps(observed: list[BallObs | None], frame_ts: list[float], *,
                     max_gap_s: float) -> list[BallObs]:
    """Linear-interpolate each None run bounded by two real detections IFF the time spanned
    is <= max_gap_s (the ≤0.5 s honesty cap, §8). Filled frames are flagged interpolated=True.
    Over-cap gaps (and leading/trailing Nones) stay empty — NO fabrication."""
    n = len(observed)
    out: list[BallObs] = [b if b is not None
                          else BallObs(None, None, 0.0, False) for b in observed]
    i = 0
    while i < n:
        if observed[i] is not None:
            i += 1; continue
        j = i
        while j < n and observed[j] is None:
            j += 1
        left, right = i - 1, j               # bracketing real detections
        if left >= 0 and right < n and (frame_ts[right] - frame_ts[left]) <= max_gap_s:
            a, b = observed[left], observed[right]
            span = frame_ts[right] - frame_ts[left]
            for k in range(i, j):
                t = (frame_ts[k] - frame_ts[left]) / span if span > 0 else 0.0
                x = a.image_xy[0] + t * (b.image_xy[0] - a.image_xy[0])
                y = a.image_xy[1] + t * (b.image_xy[1] - a.image_xy[1])
                out[k] = BallObs(image_xy=(x, y), pitch_xy=None, confidence=0.0, interpolated=True)
        # else: over-cap or unbounded -> leave the BallObs(None, ...) placeholders
        i = j
    return out

def ball_known_fraction(balls: list[BallObs]) -> float:
    """1 - (interpolated + missing) / frames — the honesty gate (§7.3). Only REAL detections
    count as known."""
    if not balls:
        return 0.0
    known = sum(1 for b in balls if b.image_xy is not None and not b.interpolated)
    return known / len(balls)

def postprocess_ball_track(stream, *, conf_floor: float, max_jump_px: float,
                           max_gap_s: float = 0.5) -> tuple[list[BallObs], float]:
    frame_ts = [ts for ts, _xy, _c in stream]
    gated = gate_candidates(stream, conf_floor=conf_floor, max_jump_px=max_jump_px)
    filled = interpolate_gaps(gated, frame_ts, max_gap_s=max_gap_s)
    return filled, ball_known_fraction(filled)
```

> The interpolator is linear by default (zero-dependency, deterministic, exactly testable). A `filterpy` Kalman smoother is an **optional** swap behind the same signature for smoother trajectories — it must produce the same cap/flag/known-fraction behaviour; absence of `filterpy` falls back to this linear path (Global Constraints).

- [ ] **Step 5: Run to verify it passes** → PASS (5 tests). Checkpoint — full suite green.

---

## Task 5: Top-down radar (`radar.py`)

Render the tactical board with **OpenCV (not matplotlib — perf, §10)** from the `WorldState` stream: both teams' dots + the ball on the `SoccerPitchConfiguration` (12000×7000 cm), with temporal smoothing. Contract/smoke-tested on synthetic `WorldState`s (no models).

**Files:**
- Create: `vision/footballcv/radar.py`, `vision/test/test_radar.py`

**Interfaces:**
- Consumes: a stream of `WorldState` (pitch-space filled).
- Produces: `draw_pitch(*, width_px:int=1050, height_px:int=680) -> np.ndarray` (the empty board); `pitch_to_canvas(pitch_xy:tuple, canvas_wh:tuple) -> tuple` (cm→px); `render_radar_frame(ws:WorldState, *, smoothing:dict|None=None, team_colors:dict, canvas=None) -> np.ndarray`; `write_radar_video(states, out_dir:str, fps:float) -> str` (returns `radar.mp4` path); a small `EmaSmoother` for per-track temporal smoothing.

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_radar.py
import numpy as np
from footballcv.radar import draw_pitch, pitch_to_canvas, render_radar_frame, TEAM_COLORS
from footballcv.types import PlayerObs, BallObs, WorldState

def test_draw_pitch_returns_canvas_of_expected_size():
    canvas = draw_pitch(width_px=1050, height_px=680)
    assert canvas.shape == (680, 1050, 3)
    assert canvas.sum() > 0                          # pitch lines drawn

def test_pitch_to_canvas_maps_corners_and_centre():
    # SoccerPitchConfiguration is 12000 x 7000 cm
    assert pitch_to_canvas((0, 0), (1050, 680)) == (0, 0)
    assert pitch_to_canvas((12000, 7000), (1050, 680)) == (1050, 680)
    cx, cy = pitch_to_canvas((6000, 3500), (1050, 680))
    assert (cx, cy) == (525, 340)

def test_render_places_team_and_ball_dots():
    p0 = PlayerObs(1, "player", 0, (0, 0, 1, 1), (3000.0, 3500.0), 0.9)   # left half
    p1 = PlayerObs(2, "player", 1, (0, 0, 1, 1), (9000.0, 3500.0), 0.9)   # right half
    ball = BallObs(image_xy=(0, 0), pitch_xy=(6000.0, 3500.0), confidence=0.8, interpolated=False)
    ws = WorldState(0, 0.0, "raw", [p0, p1], ball)
    canvas = render_radar_frame(ws, team_colors=TEAM_COLORS)
    assert canvas.shape[2] == 3 and canvas.sum() > 0
    # the team-0 dot's neighbourhood carries team-0 colour
    cx, cy = pitch_to_canvas((3000.0, 3500.0), (canvas.shape[1], canvas.shape[0]))
    patch = canvas[max(0, cy-6):cy+6, max(0, cx-6):cx+6].reshape(-1, 3)
    assert (patch == np.array(TEAM_COLORS[0])).all(axis=1).any()

def test_render_skips_players_without_pitch_xy():
    p = PlayerObs(1, "player", 0, (0, 0, 1, 1), None, 0.9)   # not projected yet
    ws = WorldState(0, 0.0, "raw", [p], BallObs(None, None, 0.0, False))
    render_radar_frame(ws, team_colors=TEAM_COLORS)          # must not raise
```

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `radar.py`**

```python
# vision/footballcv/radar.py
from __future__ import annotations
from pathlib import Path
import subprocess
import numpy as np
import cv2

TEAM_COLORS = {0: (0, 122, 255), 1: (255, 64, 64), None: (180, 180, 180)}  # BGR; matches report.py
BALL_COLOR = (255, 255, 255)
PITCH_LEN_CM, PITCH_WID_CM = 12000, 7000     # SoccerPitchConfiguration (§5)

def pitch_to_canvas(pitch_xy: tuple, canvas_wh: tuple) -> tuple:
    """cm on the 12000x7000 pitch -> integer px on the radar canvas (x along length)."""
    w, h = canvas_wh
    x = int(round(pitch_xy[0] / PITCH_LEN_CM * w))
    y = int(round(pitch_xy[1] / PITCH_WID_CM * h))
    return (x, y)

def draw_pitch(*, width_px: int = 1050, height_px: int = 680) -> np.ndarray:
    """Empty green board with halfway line, centre circle, and a border — OpenCV, not
    matplotlib (§10). Uses SoccerPitchConfiguration proportions; the .vertices set from the
    vendored config can replace these primitives for full markings."""
    canvas = np.full((height_px, width_px, 3), (40, 110, 40), np.uint8)
    cv2.rectangle(canvas, (1, 1), (width_px - 2, height_px - 2), (255, 255, 255), 2)
    cv2.line(canvas, (width_px // 2, 0), (width_px // 2, height_px), (255, 255, 255), 2)
    r = int(round(915 / PITCH_WID_CM * height_px))     # centre-circle radius 915 cm
    cv2.circle(canvas, (width_px // 2, height_px // 2), r, (255, 255, 255), 2)
    return canvas

class EmaSmoother:
    """Per-track exponential moving average over pitch_xy to kill single-frame jitter."""
    def __init__(self, alpha: float = 0.4):
        self.alpha = alpha; self._state: dict = {}
    def smooth(self, key, xy: tuple) -> tuple:
        prev = self._state.get(key)
        out = xy if prev is None else (self.alpha * xy[0] + (1 - self.alpha) * prev[0],
                                       self.alpha * xy[1] + (1 - self.alpha) * prev[1])
        self._state[key] = out
        return out

def render_radar_frame(ws, *, team_colors=TEAM_COLORS, smoother: "EmaSmoother | None" = None,
                       canvas=None) -> np.ndarray:
    board = draw_pitch() if canvas is None else canvas.copy()
    h, w = board.shape[:2]
    for p in ws.players:
        if p.pitch_xy is None:
            continue
        xy = smoother.smooth(("p", p.track_id), p.pitch_xy) if smoother else p.pitch_xy
        cx, cy = pitch_to_canvas(xy, (w, h))
        cx, cy = min(max(cx, 0), w - 1), min(max(cy, 0), h - 1)
        cv2.circle(board, (cx, cy), 6, team_colors.get(p.team, team_colors[None]), -1)
    if ws.ball.pitch_xy is not None:
        bx, by = pitch_to_canvas(ws.ball.pitch_xy, (w, h))
        cv2.circle(board, (min(max(bx, 0), w - 1), min(max(by, 0), h - 1)), 4, BALL_COLOR, -1)
    return board

def write_radar_video(states, out_dir: str, fps: float) -> str:
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    path = out / "radar.mp4"
    smoother = EmaSmoother()
    proc, board = None, draw_pitch()
    for ws in states:
        frame = render_radar_frame(ws, smoother=smoother, canvas=board)
        if proc is None:
            h, w = frame.shape[:2]
            proc = _open_nvenc_writer(str(path), w, h, fps)   # the SECOND encode pass (§10)
        proc.stdin.write(frame.tobytes())
    if proc:
        proc.stdin.close(); proc.wait()
    return str(path)

def _open_nvenc_writer(path, w, h, fps):
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-c:v", "hevc_nvenc", "-pix_fmt", "yuv420p", "-vf", "scale=1920:1080", path]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)
```

> The canvas/lines are OpenCV primitives so a smoke test runs with zero deps; the vendored `SoccerPitchConfiguration.vertices` (32 keypoints) can replace the hand-drawn markings for a fuller board without changing the contract. Both outputs are 1080p (the `scale=1920:1080` in the NVENC pass; §10). Verify NVENC flags on the 3060; fall back to `libx264` behind `--encoder` for Mac dev (mirrors `report.py`).

- [ ] **Step 4: Run to verify it passes** → PASS (4 tests). Checkpoint — full suite green.

---

## Task 6: Wire v2 into the pipeline (`pipeline.py` + `report.py` + GK pitch-space)

Switch GK assignment to **pitch-space** centroids (H now exists) and **exclude GKs from team-shape** (§8/§7.3); draw the ball marker on `annotated.mp4`; and wire `--ball`/`--radar` into the orchestrator with the **second NVENC encode pass** for `radar.mp4` (1080p).

**Files:**
- Extend: `vision/footballcv/pipeline.py`, `vision/footballcv/report.py`
- Create: `vision/test/test_pipeline_v2.py`

**Interfaces:**
- Extends `report.annotate_frame` to draw `ws.ball.image_xy` (a marker; interpolated balls drawn in a distinct style — the honesty flag is visible).
- Adds `pipeline.run_v2(input, out_dir, *, device, sample_fps, imgsz, models_dir, calibration, ball, radar)`; `main` gains `--ball --radar --calibration`; GK assignment uses `assign_goalkeeper` against **pitch-space** team centroids; `exclude_gk_from_shape(players) -> list[PlayerObs]` helper (drops `cls=="goalkeeper"` for hull/shape, keeps them on the radar).

- [ ] **Step 1: Write the failing tests (mocked models — geometry/wiring only)**

```python
# vision/test/test_pipeline_v2.py
import ast
import numpy as np
from pathlib import Path
from footballcv.types import PlayerObs, BallObs, WorldState

PIPE = Path(__file__).resolve().parents[1] / "footballcv" / "pipeline.py"

def test_pipeline_v2_still_does_not_import_fetch_models():
    tree = ast.parse(PIPE.read_text())
    mods = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import): mods |= {a.name for a in n.names}
        if isinstance(n, ast.ImportFrom): mods.add(n.module or "")
    assert not any("fetch_models" in m for m in mods)

def test_gk_assigned_in_pitch_space():
    from footballcv.pipeline import gk_team_pitch_space
    # team-0 cluster centred on the left (small pitch_x), team-1 on the right
    centroids = {0: np.array([3000.0, 3500.0]), 1: np.array([9000.0, 3500.0])}
    assert gk_team_pitch_space(np.array([2800.0, 3500.0]), centroids) == 0
    assert gk_team_pitch_space(np.array([9200.0, 3500.0]), centroids) == 1

def test_gk_excluded_from_team_shape_but_kept_on_radar():
    from footballcv.pipeline import exclude_gk_from_shape
    players = [PlayerObs(1, "player", 0, (0,0,1,1), (3000.0,3500.0), 0.9),
               PlayerObs(2, "goalkeeper", 0, (0,0,1,1), (200.0,3500.0), 0.9)]
    shape_players = exclude_gk_from_shape(players)
    assert [p.track_id for p in shape_players] == [1]      # GK dropped from shape
    assert len(players) == 2                               # original list untouched (radar keeps GK)

def test_annotate_draws_ball_marker():
    from footballcv.report import annotate_frame, TEAM_COLORS
    frame = np.zeros((96, 128, 3), np.uint8)
    ws = WorldState(0, 0.0, "raw",
                    [PlayerObs(1, "player", 0, (5,5,20,40), None, 0.9)],
                    BallObs(image_xy=(64.0, 48.0), pitch_xy=None, confidence=0.8, interpolated=False))
    out = annotate_frame(frame.copy(), ws, TEAM_COLORS)
    # the ball marker writes pixels near (64,48)
    assert out[44:52, 60:68].sum() > 0
```

- [ ] **Step 2: Run to verify it fails** → FAIL (`gk_team_pitch_space` / `exclude_gk_from_shape` / ball marker missing).

- [ ] **Step 3: Extend `report.py` (ball marker)**

```python
# in vision/footballcv/report.py — extend annotate_frame to draw the ball
import cv2   # add at top with the other imports

def _draw_ball(frame, ball):
    if ball.image_xy is None:
        return frame
    x, y = int(round(ball.image_xy[0])), int(round(ball.image_xy[1]))
    color = (0, 255, 255) if not ball.interpolated else (0, 165, 255)  # solid vs interpolated (honesty)
    cv2.circle(frame, (x, y), 6, color, 2)
    if ball.interpolated:
        cv2.putText(frame, "~", (x + 7, y - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
    return frame
```
Then call `frame = _draw_ball(frame, ws.ball)` at the end of `annotate_frame` (after the box/label annotators, before returning — so it works even when `ws.players` is empty; restructure the early-return so the ball still draws).

- [ ] **Step 4: Extend `pipeline.py`**

```python
# add to vision/footballcv/pipeline.py
def gk_team_pitch_space(gk_pitch_xy, team_centroids_pitch: dict) -> int:
    """GK -> nearest team centroid in PITCH space (v2; v1 used image space). §7.3/§8."""
    from footballcv.teams import assign_goalkeeper
    return assign_goalkeeper(np.asarray(gk_pitch_xy, float),
                             {t: np.asarray(c, float) for t, c in team_centroids_pitch.items()})

def exclude_gk_from_shape(players):
    """GKs distort hull/compactness (pinned to the box) -> excluded from team-shape (§7.3).
    Returns a NEW list; the original (radar still shows the GK) is untouched."""
    return [p for p in players if p.cls != "goalkeeper"]

def run_v2(input: str, out_dir: str, *, device="cuda", sample_fps=5.0, imgsz=1280,
           models_dir="models", calibration="config/calibration.yaml",
           ball=True, radar=True) -> dict:
    from footballcv.models_io import load_manifest, resolve_weight
    from footballcv.pitch import PitchProjector
    from footballcv.report import write_annotated_video
    from footballcv.radar import write_radar_video

    manifest = load_manifest(Path(models_dir))
    resolve_weight("players", Path(models_dir), manifest)            # SHA-verified
    if ball:
        resolve_weight("ball", Path(models_dir), manifest)          # second model, SHA-verified
    projector = PitchProjector.from_calibration_file(calibration)
    # Build image-space WorldStates as in v1 (detect+track+teams), then for each:
    #   ws = projector.project_worldstate(ws)        # fills feet + ball pitch_xy
    #   GK team via gk_team_pitch_space against pitch-space team centroids
    # The ball stream is gathered per-frame (BallDetector.best_ball_candidate) and run through
    # ball_postprocess.postprocess_ball_track BEFORE projection (image-space gating + capped fill).
    # Two encode passes: write_annotated_video(...) then write_radar_video(...). (§10)
    # Full detect/track loop is the Task 8 acceptance integration (needs weights + a clip).
    ...
    prov = {"detector": manifest["weights"]["players"]["model_version"],
            "detector_sha256": manifest["weights"]["players"]["sha256"],
            "ball_model_sha256": manifest["weights"]["ball"]["sha256"] if ball else None,
            "device": device, "seed": 0, "sample_fps": sample_fps, "track_id_space": "raw"}
    return {"provenance": prov, "out": out_dir}
```
Add the CLI flags to `main`: `ap.add_argument("--ball", action="store_true")`, `ap.add_argument("--radar", action="store_true")`, `ap.add_argument("--calibration", default="config/calibration.yaml")`, and route to `run_v2` when `--ball` or `--radar` is set (otherwise the v1 `run_v1` path).

- [ ] **Step 5: Run to verify it passes** → PASS (4 tests). Checkpoint — full suite green.

---

## Task 7: Numeric radar-anchoring gate (`test_radar_anchoring.py`)

The one numericised §7-v2 success criterion: with the ball visibly in the left third, the in-possession team's dots cluster on the left (a left/right anchoring flip still produces "clustered dots", just on the wrong side — so this is asserted **numerically**, not by eye). Built on synthetic pitch-space `WorldState`s — no models, fully deterministic.

**Files:**
- Create: `vision/test/test_radar_anchoring.py`

**Interfaces:**
- Consumes: synthetic pitch-space `WorldState`s + a tiny `frac_dots_in_left_third(ws, team) -> float` helper (lives in `radar.py`, exported for the test and reused by v3 possession later).

- [ ] **Step 1: Add the helper to `radar.py`**

```python
# append to vision/footballcv/radar.py
def frac_dots_in_left_third(ws, team: int) -> float:
    """Fraction of `team`'s projected players whose pitch_x is in the left third of the pitch
    (< PITCH_LEN_CM/3). The §7-v2 numeric anchoring gate; reused by v3 possession-by-zone."""
    pts = [p.pitch_xy for p in ws.players if p.team == team and p.pitch_xy is not None]
    if not pts:
        return 0.0
    left = sum(1 for x, _y in pts if x < PITCH_LEN_CM / 3)
    return left / len(pts)
```

- [ ] **Step 2: Write the test (this IS the gate)**

```python
# vision/test/test_radar_anchoring.py
from footballcv.radar import frac_dots_in_left_third
from footballcv.types import PlayerObs, BallObs, WorldState

def _frame_with_left_attack(in_possession_team: int):
    """Ball in the left third; the in-possession team camped left, the other spread right."""
    players = []
    for i in range(6):                       # in-possession team: left third (x < 4000)
        players.append(PlayerObs(i, "player", in_possession_team, (0,0,1,1),
                                 (500.0 + i * 400, 3000.0 + i * 100), 0.9))
    other = 1 - in_possession_team
    for i in range(6):                       # other team: right two-thirds
        players.append(PlayerObs(10 + i, "player", other, (0,0,1,1),
                                 (7000.0 + i * 600, 3000.0 + i * 100), 0.9))
    ball = BallObs(image_xy=(0, 0), pitch_xy=(1500.0, 3500.0), confidence=0.8, interpolated=False)
    return WorldState(0, 0.0, "raw", players, ball)

def test_left_third_attack_clusters_in_possession_team_left():
    X = 0.8                                   # the §7-v2 ">X%" threshold (seed)
    for poss_team in (0, 1):                  # holds regardless of which team has the ball
        ws = _frame_with_left_attack(poss_team)
        # 2 frames with the ball in the left third (§7-v2) — reuse the same synthetic frame twice
        for _ in range(2):
            assert frac_dots_in_left_third(ws, poss_team) > X
            assert frac_dots_in_left_third(ws, 1 - poss_team) < X   # other team NOT left-clustered
```

- [ ] **Step 3: Run to verify it passes** → PASS. Checkpoint — full suite green.

> This is the synthetic, always-runnable form of the gate. The acceptance run (Task 8) re-asserts it on **two real frames** of the chosen clip where the ball is visibly in the left third — the same `frac_dots_in_left_third` against real projected `WorldState`s.

---

## Task 8: Acceptance run on a public clip (the §7-v2 gate)

Not a unit test — the human/agent acceptance gate that proves v2 works end-to-end. Run after Tasks 1–7 are green, reusing the v1 acceptance clip + a calibration for that mount.

**Steps:**

- [ ] **Step 1: Calibrate the mount.** Run `python -m footballcv.calibrate --frame samples/<clip>.mp4 --at 00:00:30 --out config/calibration.yaml`; click 6–8 well-separated, non-collinear pitch landmarks; confirm the self-grader prints **GOOD** (held-out reprojection error under the §7.2 seed threshold) and did **not** reject the set as ill-conditioned. Re-pick if RE-PICK.

- [ ] **Step 2: Benchmark the ball pass (sets the default).** On the 3060, run the dedicated ball model on a sample of frames **plain `imgsz=1280`** vs **`sv.InferenceSlicer` 2×2 tiling**; measure recall (against a few hand-marked ball positions) and wall-clock; set `BallDetector(tiling=...)` default to the **recall-per-second winner** and record which config the §10 wall-clock now assumes (note it in the run log + ADR §10).

- [ ] **Step 3: Complete the `run_v2` wiring** left as `...` in Task 6: per `--sample-fps` frame run the v1 detect+track+teams loop for image-space `WorldState`s; gather the per-frame best ball candidate; release the player model and run the ball pass (second resident model); `postprocess_ball_track` the ball stream (gate + ≤0.5 s capped interpolation + `ball_known_fraction`); `projector.project_worldstate` each frame (feet + ball → `pitch_xy`); assign GK via `gk_team_pitch_space`; then **two encode passes** — `write_annotated_video` (boxes + IDs + team colours + ball marker) and `write_radar_video` (top-down board), both 1080p.

- [ ] **Step 4: Run:**

```bash
cd vision && source .venv/bin/activate
python -m footballcv.pipeline --input samples/<clip>.mp4 --device cuda \
    --sample-fps 5 --imgsz 1280 --calibration config/calibration.yaml \
    --ball --radar --out out/clip/
```
Expected: `out/clip/annotated.mp4` (now with a ball marker) and `out/clip/radar.mp4` written.

- [ ] **Step 5: Verify the §7-v2 success criteria — (a) pipeline-correctness (checkable now):**
  - **Homography geometry (HELD-OUT, §7.2):** the calibrator graded GOOD on held-out points; the reported error is stated as **pixel error at a named region** plus the implied metre figure (≈ ≤1.5 m near-camera, ≈ ≤4 m far-side — far side honestly worse, documented). A near-collinear/centre-clustered set is rejected (re-confirmed against the real frame).
  - **Radar fidelity (visual):** the radar matches the video — left-wing play ⇒ left-clustered dots; both teams' shapes track the video; no per-frame jitter (constant H ⇒ none by construction; a centre-clustered landmark set can still give a *stable wrong* far side — that is the calibrator's job to reject, §7.2).
  - **Ball honesty:** interpolated ball segments are visibly flagged on `annotated.mp4` (distinct marker); over-cap gaps are empty (no fabrication); `ball_known_fraction` is reported.
  - **Anchoring (numeric):** pick **2 real frames** with the ball visibly in the left third; assert **> X %** of the in-possession team's dots have `pitch_x` in the left third (`frac_dots_in_left_third` on the real projected `WorldState`s — the Task 7 gate, on real data).
  - **Privacy/offline:** `--ball`/`--radar` make **no** run-time network calls; the v1 no-network + manifest-integrity tests still pass (the ball weight is SHA-verified on load).

- [ ] **Step 6: Verify — (b) accuracy (deferred to fine-tune):** ball present on the radar for the large majority of frames after interpolation ("fraction of frames with a believable radar position", **not** raw mAP) — **explicitly deferred** behind "fine-tune on the real target view once a camera + footage exist" (ADR §7 two-tier criteria, §12-Q1). Not a phase gate for v2.

- [ ] **Step 7:** Append the result (clip, calibration held-out error, chosen ball config + its recall/wall-clock, `ball_known_fraction`, any radar far-side caveats) to the `vision/README.md` "v2 acceptance" subsection. v2 is done when the (a) criteria above hold.

---

## Self-Review

Run against ADR-0023 §7-v2 + the load-bearing §7.2/§8 controls:

**1. Spec coverage:**
- v2 deliverables (ball marked on `annotated.mp4`; top-down radar of both teams + ball on `SoccerPitchConfiguration`) → Tasks 3/6 (ball) + 2/5/6 (radar) + 8 (acceptance). ✓
- §7.2 homography held-out validation + collinearity/small-hull rejection (load-bearing) → Task 1 (`grade_calibration` fit-on-4/measure-on-rest + `point_set_is_degenerate`), unit-tested with a synthetic known homography. ✓
- §8 ball recall bottleneck + mandatory ≤0.5 s capped interpolation + `interpolated=True` + `ball_known_fraction` → Task 4, full unit tests (injected gaps + outlier). ✓
- §5 ball model `football-ball-detection-rejhg`, `sv.InferenceSlicer` 2×2 tiling **benchmark-decides-default** (not slow opt-in), second resident model (12 GB), vendored `ViewTransformer`/`SoccerPitchConfiguration` → Tasks 3/2/5. ✓
- §4 stage contracts (`pitch`/`radar`) + `BallObs`/`WorldState` (unchanged v1 dataclasses) → Tasks 2/5, consume the real v1 `types.py` fields. ✓
- §10 perf (two NVENC encode passes, both 1080p, OpenCV not matplotlib) → Tasks 5/6. ✓
- §7.3/§8 GK → pitch-space + GK excluded from team-shape → Task 6 (`gk_team_pitch_space`, `exclude_gk_from_shape`). ✓
- §7-v2 numeric anchoring gate (ball left-third ⇒ in-possession team left-clustered) → Task 7 (synthetic) + Task 8 Step 5 (real). ✓
- Out of v2 (correctly absent): analytics/possession/distance (v3), `stats.json`/`summary.txt` (v3), GoPro 360 de-warp (v4). ✓ (noted)

**2. Placeholder scan:** the only intentional `...` is the `run_v2` body completed in Task 8 Step 3 (it depends on the live Ultralytics detect+track loop, an acceptance-run integration, not unit-testable without weights) and `_pick_points_interactive` / `_open_nvenc_writer` explicitly flagged as UI/build-time pieces. No "TODO/TBD" in tested logic; every code-step ships real, runnable code with exact-value assertions.

**3. Type consistency:** `PitchProjector.project_worldstate` returns a `WorldState` with `PlayerObs.pitch_xy`/`BallObs.pitch_xy` filled (the real v1 fields, via `dataclasses.replace`); `ball_postprocess` emits `BallObs` matching `types.py` (`image_xy`/`pitch_xy`/`confidence`/`interpolated`); `BallDetector.best_ball_candidate` output feeds `gate_candidates`' `(ts, xy, conf)` stream; `radar.render_radar_frame` consumes `WorldState`/`PlayerObs.team`/`pitch_xy` and reuses `report.py`'s `TEAM_COLORS`; `resolve_weight("ball", ...)`/`load_manifest` match the v1 `models_io` signatures; `assign_goalkeeper` (v1 `teams.py`) is reused unchanged by `gk_team_pitch_space`. Verified external APIs: `sv.InferenceSlicer(callback, slice_wh, overlap_wh=abs-px, overlap_filter, iou_threshold)` called as `slicer(image)`; `ViewTransformer(source,target).transform_points((N,2))`; `SoccerPitchConfiguration` 12000×7000 cm + `.vertices`; `cv2.findHomography(img, pit, cv2.RANSAC)` + `cv2.perspectiveTransform`; `sv.crop_image(image=, xyxy=)`. ✓

---

## Execution Handoff

Plan complete and saved to `docs/vision/2026-06-19-v2-implementation-plan.md`. Builds on the green v1 suite. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration (superpowers:subagent-driven-development).

**2. Inline Execution** — execute tasks in this session with checkpoints (superpowers:executing-plans).

**Which approach?**
