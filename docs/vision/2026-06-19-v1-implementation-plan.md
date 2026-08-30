# Camera/CV Track — v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given any *public adult/pro* football clip, produce an annotated video with player/GK/referee boxes, stable per-player track IDs, and two deterministically-anchored team colours — and land the privacy/reproducibility controls the board made must-fix-before-code.

**Architecture:** A new standalone Python subproject `vision/` (inner package `footballcv`) with one module per pipeline stage behind clear `WorldState` I/O contracts. v1 runs `decode → detect → track → teams → report(annotated only)`; no ball, no homography, no radar. Stages are swappable; the deterministic logic (manifest verify, offline guards, team anchoring, config builder) is unit-tested, the thin Ultralytics/`supervision` wrappers are validated by a contract test + a final acceptance run on a clip.

**Tech Stack:** Python 3.11 · Ultralytics YOLO11 (`model.track`, BoT-SORT) · Roboflow `supervision` 0.29 (vendored `sports` recipe) · `transformers` SigLIP + scikit-learn (PCA→KMeans) · OpenCV · torch/torchvision CUDA (RTX 3060) / MPS-CPU (Mac) · ffmpeg/NVENC · pytest.

**Source spec:** [ADR-0023 (build-spec form)](../decisions/0023-camera-cv-offline-analysis.md) as amended by the [2026-06-19 board review](../architecture/reviews/2026-06-19-cv-track-board-review.md). This plan implements **v1 only** (ADR §7-v1); v2 (ball+homography+radar), v3 (analytics), v4 (GoPro 360) are separate later plans.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from ADR-0023 §3/§5.

- **Python 3.11** is the single pinned interpreter (`pyproject.toml` `requires-python == "3.11.*"`); 3.10–3.13 are known-compatible-but-untested.
- **Dependency pins (range in `requirements.txt`, exact frozen in committed `requirements.lock`):** `ultralytics >=8.4.60,<8.5`, `supervision ==0.29.*`, `opencv-python` 4.x (pick exactly one of `opencv-python`/`-headless` in a fresh venv), `torch`/`torchvision` from the **cu12x CUDA wheel index** (pin the index URL — the part most likely to break a reinstall), `transformers`, `scikit-learn`, `numpy` (let `supervision` pull 2.x; pin `<2` only if forced), `PyYAML`, `pytest`.
- **Do NOT use `sv.ByteTrack`** (removed in supervision 0.30). v1 tracking is BoT-SORT via Ultralytics `model.track(persist=True, tracker=<yaml>)`.
- **Roboflow `sports` is VENDORED, not installed** — copy its modules into `footballcv/vendor/sports/`, pinned to a recorded upstream commit SHA (note it in `vision/README.md`).
- **AGPL note:** Ultralytics is AGPL-3.0; fine while `vision/` stays private/undistributed. Keep `detect` and `track` behind swappable interfaces so the RF-DETR + ByteTrack escape hatch stays a two-module change (ADR §5/§12-Q3). No publish planned.
- **Privacy gate (#1, non-negotiable):** PUBLIC adult/pro footage ONLY, every phase. No youth footage anywhere in v1. `vision/.gitignore` lands FIRST (Task 1), before `samples/` exists. All tests run on synthetic fixtures or the one SHA-pinned public clip — never children's data.
- **Offline guards:** `pipeline.py` sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and disables Ultralytics analytics **unconditionally at startup**, and asserts they are set, before loading any model.
- **Determinism:** set `PYTHONHASHSEED` + `torch`/`numpy`/`random` seeds + `torch.use_deterministic_algorithms(True)` where feasible; PCA+KMeans use a fixed `random_state`. "Two runs identical" means **team-id anchoring/mapping stability**, not bit-equality (CUDA/BoT-SORT are not bit-reproducible); assertions are pinned to the owner's device (the 3060).
- **GPU budget:** the 3060 has 12 GB; models load/release **one at a time** (detector, then SigLIP) — never co-resident.
- **VERSION CONTROL:** the repo is **NOT a git repo** today. There are therefore **no per-task git commits**; each task's checkpoint is *the full test suite green*. `vision/.gitignore` is still authored correctly in Task 1 so the privacy firewall is in force the moment the tree is ever placed under git (the ADR §3 must-fix). Where a step references git (e.g. the ignore-tracking test), it degrades gracefully when `.git` is absent.
- **EXECUTION (Docker only):** all commands run in Docker via `vision/docker-compose.yml` — never on the host. Read every `Run: pytest …` / `python -m footballcv …` step below as `docker compose run --rm test` (suite) or `docker compose run --rm selftest`, from `vision/`. The dev image is `python:3.11-slim` (CPU, light test deps only — no torch); the GPU pipeline runs on the RTX 3060 desktop behind the `gpu` profile (`docker compose --profile gpu run --rm run …`). The host `.venv` is not used.
- **Source-driven discipline:** code blocks for the Ultralytics/`supervision`/`transformers` wrappers are written against the pinned versions above; before implementing each wrapper, confirm the exact call signature against that version's docs (the repo's source-driven-development rule). The deterministic-logic tasks (1–5, 8, 10) are fully specified and need no external verification.

---

## File Structure

Created in this plan (all under `vision/`; matches ADR §6):

```
vision/
  .gitignore                  # Task 1 — COMMITTED, lands first; ignores models/ samples/ out/ config/calibration.yaml *.360 *.mp4 *.pt *.engine .venv
  pyproject.toml              # Task 1 — declares the single footballcv package; requires-python ==3.11.*
  requirements.txt            # Task 1 — range pins
  requirements.lock           # Task 11 — exact frozen versions (pip freeze / uv lock) after venv validates
  README.md                   # Task 11 — opens with the §3 PRIVACY GATE
  samples.manifest.jsonl      # Task 11 — COMMITTED clip provenance (non-gitignored)
  fetch_models.py             # Task 4 — SETUP-ONLY network; pulls weights; writes models/MANIFEST.json
  fetch_fixtures.py           # Task 11 — SETUP-ONLY; pulls one SHA-pinned public clip for tests
  config/
    calibration.example.yaml  # Task 1 — pitch-point template (committed, no real data)
    botsort_football.yaml     # Task 5 — generated tracker config (override set)
  footballcv/
    __init__.py               # Task 1
    types.py                  # Task 2 — WorldState / PlayerObs / BallObs
    runtime.py                # Task 3 — offline guards + deterministic seeding
    models_io.py              # Task 4 — MANIFEST.json SHA256 verify-on-load
    track_config.py           # Task 5 — BoT-SORT yaml builder
    decode.py                 # Task 6 — frame iterator + sampling
    detect.py                 # Task 7 — YOLO11 detector behind a swappable interface
    teams.py                  # Task 8 — embeddings → PCA → KMeans → anchoring (+ GK centroid, degenerate guard)
    report.py                 # Task 9 — annotate frames + encode annotated.mp4
    pipeline.py               # Task 10 — CLI orchestrator + --selftest (never imports fetch_models)
    vendor/sports/            # Task 7/8 — vendored Roboflow sports modules (pinned SHA)
  models/                     # gitignored; weights land here; MANIFEST.json IS committed
  samples/                    # gitignored; PUBLIC clips only
  out/                        # gitignored; generated artifacts
  test/
    __init__.py
    conftest.py               # Task 6 — synthetic-clip + synthetic-frame fixtures
    fixtures/                 # COMMITTED tiny synthetic fixtures (no footage)
    test_*.py                 # per-task tests
```

---

## Task 1: Privacy firewall + project scaffold

Lands the `.gitignore` first (ADR §3 must-fix #3), the package skeleton, and the dependency manifest. Nothing else may be created before this task's `.gitignore`.

**Files:**
- Create: `vision/.gitignore`, `vision/pyproject.toml`, `vision/requirements.txt`, `vision/footballcv/__init__.py`, `vision/test/__init__.py`, `vision/config/calibration.example.yaml`, `vision/test/fixtures/.gitkeep`
- Test: `vision/test/test_privacy_firewall.py`

**Interfaces:**
- Produces: the `footballcv` package root and a committed `.gitignore` whose patterns later tasks rely on for the privacy guarantee.

- [ ] **Step 1: Write the failing test**

```python
# vision/test/test_privacy_firewall.py
import shutil, subprocess
from pathlib import Path

VISION = Path(__file__).resolve().parents[1]
REQUIRED_IGNORES = ["models/", "samples/", "out/", "config/calibration.yaml",
                    "*.360", "*.mp4", "*.pt", "*.engine", ".venv/"]

def test_gitignore_exists_and_covers_required_patterns():
    gi = (VISION / ".gitignore").read_text()
    for pat in REQUIRED_IGNORES:
        assert pat in gi, f"missing ignore pattern: {pat}"

def test_committed_manifests_are_NOT_ignored():
    gi = (VISION / ".gitignore").read_text().splitlines()
    # MANIFEST.json and samples.manifest.jsonl must stay committable
    assert not any(line.strip() in ("MANIFEST.json", "samples.manifest.jsonl") for line in gi)

def test_no_video_or_weight_files_tracked_if_under_git():
    # Degrades gracefully when the tree is not under git (current repo state).
    if not shutil.which("git") or not (VISION.parent / ".git").exists():
        return
    tracked = subprocess.run(["git", "ls-files", str(VISION)],
                             capture_output=True, text=True).stdout.split()
    bad = [f for f in tracked if f.endswith((".mp4", ".360", ".pt", ".engine"))]
    assert not bad, f"video/weight files tracked under vision/: {bad}"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest vision/test/test_privacy_firewall.py -v`
Expected: FAIL — `.gitignore` does not exist (FileNotFoundError).

- [ ] **Step 3: Create the `.gitignore` (FIRST artifact in the tree)**

```gitignore
# vision/.gitignore — privacy firewall (ADR-0023 §3). MUST be in force before any clip lands.
# Footage and weights NEVER enter version control.
models/
samples/
out/
config/calibration.yaml
*.360
*.mp4
*.mov
*.pt
*.engine
.venv/
__pycache__/
*.pyc
# Committed despite the above (carry no footage/weights/keys):
!models/MANIFEST.json
!samples.manifest.jsonl
```

- [ ] **Step 4: Create the scaffold files**

```toml
# vision/pyproject.toml
[project]
name = "footballcv"
version = "0.1.0"
requires-python = "==3.11.*"

[tool.setuptools.packages.find]
include = ["footballcv*"]

[tool.pytest.ini_options]
testpaths = ["test"]
```

```text
# vision/requirements.txt — range pins; exact versions frozen in requirements.lock (Task 11)
# torch/torchvision: install from the CUDA cu12x index on the 3060, e.g.
#   pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
ultralytics>=8.4.60,<8.5
supervision==0.29.*
opencv-python>=4.9,<5
transformers>=4.44
scikit-learn>=1.4
numpy
PyYAML
pytest
```

```python
# vision/footballcv/__init__.py
"""footballcv — offline camera/CV match analysis (ADR-0023). PUBLIC footage only."""
```

```yaml
# vision/config/calibration.example.yaml — template; the real calibration.yaml is gitignored (v2).
# pixel point -> pitch point (cm, SoccerPitchConfiguration 12000x7000). Filled by footballcv.calibrate in v2.
image_points: []   # [[px, py], ...]  >= 6 well-separated, non-collinear
pitch_points: []   # [[x_cm, y_cm], ...] same order
```

Also create empty `vision/test/__init__.py` and `vision/test/fixtures/.gitkeep`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest vision/test/test_privacy_firewall.py -v`
Expected: PASS (3 tests). Checkpoint — suite green.

---

## Task 2: The `WorldState` contract (`types.py`)

The frozen per-frame data shape every stage is tested against (ADR §4).

**Files:**
- Create: `vision/footballcv/types.py`
- Test: `vision/test/test_types.py`

**Interfaces:**
- Produces: `PlayerObs(track_id:int, cls:str, team:int|None, image_bbox:tuple, pitch_xy:tuple|None, confidence:float)`, `BallObs(image_xy:tuple|None, pitch_xy:tuple|None, confidence:float, interpolated:bool)`, `WorldState(frame_idx:int, frame_ts:float, track_id_space:str, players:list[PlayerObs], ball:BallObs)`. Every later task consumes these.

- [ ] **Step 1: Write the failing test**

```python
# vision/test/test_types.py
from footballcv.types import PlayerObs, BallObs, WorldState

def test_worldstate_roundtrip_image_space_only():
    p = PlayerObs(track_id=7, cls="player", team=0, image_bbox=(1,2,3,4),
                  pitch_xy=None, confidence=0.9)
    ws = WorldState(frame_idx=0, frame_ts=0.0, track_id_space="raw",
                    players=[p], ball=BallObs(image_xy=None, pitch_xy=None,
                                              confidence=0.0, interpolated=False))
    assert ws.track_id_space == "raw"
    assert ws.players[0].pitch_xy is None      # v1: no homography yet
    assert ws.players[0].team == 0

def test_referee_has_no_team():
    r = PlayerObs(track_id=1, cls="referee", team=None, image_bbox=(0,0,1,1),
                  pitch_xy=None, confidence=0.8)
    assert r.team is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest vision/test/test_types.py -v`
Expected: FAIL — `ModuleNotFoundError: footballcv.types`.

- [ ] **Step 3: Implement `types.py`**

```python
# vision/footballcv/types.py
from dataclasses import dataclass

@dataclass
class PlayerObs:
    track_id: int            # stable id from track (raw) / stitch (v3)
    cls: str                 # "player" | "goalkeeper" | "referee"
    team: int | None         # 0|1 for players/GK; None for referee. ANCHORED + stable per clip (§7.1)
    image_bbox: tuple        # (x1, y1, x2, y2) in source pixels
    pitch_xy: tuple | None   # (x_cm, y_cm); None pre-homography (always None in v1)
    confidence: float

@dataclass
class BallObs:
    image_xy: tuple | None
    pitch_xy: tuple | None
    confidence: float
    interpolated: bool

@dataclass
class WorldState:
    frame_idx: int
    frame_ts: float          # seconds from clip start
    track_id_space: str      # 'raw' | 'stitched' — analytics asserts its precondition
    players: list[PlayerObs]
    ball: BallObs
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest vision/test/test_types.py -v` → PASS.

- [ ] **Step 5: Checkpoint** — `python -m pytest vision/test -v` all green.

---

## Task 3: Offline guards + deterministic seeding (`runtime.py`)

The run-time half of the §3 no-network guarantee, plus the seeding that backs the §11 determinism gate. Must run before any model load.

**Files:**
- Create: `vision/footballcv/runtime.py`
- Test: `vision/test/test_runtime.py`

**Interfaces:**
- Produces: `set_offline_guards() -> None` (sets+asserts env vars), `seed_everything(seed:int=0) -> None`.

- [ ] **Step 1: Write the failing test**

```python
# vision/test/test_runtime.py
import os
from footballcv.runtime import set_offline_guards, seed_everything

def test_offline_guards_set_and_asserted(monkeypatch):
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    set_offline_guards()
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert os.environ.get("YOLO_OFFLINE") == "1"

def test_seed_everything_is_idempotent_and_sets_pythonhashseed(monkeypatch):
    seed_everything(0)
    assert os.environ["PYTHONHASHSEED"] == "0"
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest vision/test/test_runtime.py -v` → FAIL (module missing).

- [ ] **Step 3: Implement `runtime.py`**

```python
# vision/footballcv/runtime.py
import os, random

def set_offline_guards() -> None:
    """Set + ASSERT the env guards that neutralise auto-download/telemetry in
    transformers/ultralytics/roboflow. Call FIRST in pipeline.py, before any import
    that loads a model. (ADR §3/§5.)"""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["YOLO_OFFLINE"] = "1"           # ultralytics analytics/telemetry off
    # ultralytics settings telemetry (best-effort; verify key name vs installed ultralytics)
    try:
        from ultralytics import settings
        settings.update({"sync": False})
    except Exception:
        pass
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert os.environ["YOLO_OFFLINE"] == "1"

def seed_everything(seed: int = 0) -> None:
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except Exception:
        pass
    try:
        import torch
        torch.manual_seed(seed)
        torch.use_deterministic_algorithms(True, warn_only=True)
    except Exception:
        pass
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest vision/test/test_runtime.py -v` → PASS.

- [ ] **Step 5: Checkpoint** — full suite green.

---

## Task 4: Model-fetch integrity (`models_io.py` + `fetch_models.py`)

ADR §5 must-fix #2: weights are SHA256-pinned in a committed `models/MANIFEST.json`; the pipeline verifies on load and refuses to run on mismatch.

**Files:**
- Create: `vision/footballcv/models_io.py`, `vision/fetch_models.py`
- Test: `vision/test/test_models_io.py`

**Interfaces:**
- Produces: `resolve_weight(name:str, models_dir:Path, manifest:dict) -> Path` (raises `IntegrityError` on SHA mismatch / missing), `sha256_of(path:Path) -> str`, `load_manifest(models_dir:Path) -> dict`.

- [ ] **Step 1: Write the failing test**

```python
# vision/test/test_models_io.py
import json, pytest
from pathlib import Path
from footballcv.models_io import resolve_weight, sha256_of, IntegrityError

def _make(tmp_path, content=b"fake-weights"):
    models = tmp_path / "models"; models.mkdir()
    w = models / "players.pt"; w.write_bytes(content)
    manifest = {"weights": {"players": {"file": "players.pt", "sha256": sha256_of(w),
                "url": "https://example/x", "model_version": "3zvbc/1", "bytes": len(content)}}}
    (models / "MANIFEST.json").write_text(json.dumps(manifest))
    return models, manifest

def test_resolve_returns_path_when_sha_matches(tmp_path):
    models, manifest = _make(tmp_path)
    p = resolve_weight("players", models, manifest)
    assert p.name == "players.pt"

def test_resolve_refuses_on_sha_mismatch(tmp_path):
    models, manifest = _make(tmp_path)
    (models / "players.pt").write_bytes(b"TAMPERED")     # change file, not manifest
    with pytest.raises(IntegrityError):
        resolve_weight("players", models, manifest)

def test_resolve_refuses_when_missing(tmp_path):
    models, manifest = _make(tmp_path)
    (models / "players.pt").unlink()
    with pytest.raises(IntegrityError):
        resolve_weight("players", models, manifest)
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest vision/test/test_models_io.py -v` → FAIL (module missing).

- [ ] **Step 3: Implement `models_io.py`**

```python
# vision/footballcv/models_io.py
import hashlib, json
from pathlib import Path

class IntegrityError(RuntimeError):
    pass

def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def load_manifest(models_dir: Path) -> dict:
    mf = Path(models_dir) / "MANIFEST.json"
    if not mf.exists():
        raise IntegrityError(f"missing manifest: {mf} (run fetch_models.py)")
    return json.loads(mf.read_text())

def resolve_weight(name: str, models_dir: Path, manifest: dict) -> Path:
    entry = manifest.get("weights", {}).get(name)
    if not entry:
        raise IntegrityError(f"'{name}' not in MANIFEST.json")
    path = Path(models_dir) / entry["file"]
    if not path.exists():
        raise IntegrityError(f"weight file absent: {path} (run fetch_models.py)")
    actual = sha256_of(path)
    if actual != entry["sha256"]:
        raise IntegrityError(f"SHA256 mismatch for {name}: {actual} != {entry['sha256']}")
    return path
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest vision/test/test_models_io.py -v` → PASS (3 tests).

- [ ] **Step 5: Implement `fetch_models.py` (setup-only; the ONLY networked module)**

```python
# vision/fetch_models.py  — SETUP ONLY. The single network-touching module (ADR §5).
# Run once: `export ROBOFLOW_API_KEY=...; python fetch_models.py`
import json, os, time
from pathlib import Path
from footballcv.models_io import sha256_of

MODELS = Path(__file__).resolve().parent / "models"
# roboflow-jvuqo Universe models (ADR §5). Resolve concrete download URLs via the
# roboflow/inference SDK at fetch time — verify the SDK call against its current docs.
WEIGHTS = {
    "players": {"model_version": "football-players-detection-3zvbc/<v>"},
    # ball + field models are fetched here too but only USED from v2/v4.
    "ball":    {"model_version": "football-ball-detection-rejhg/<v>"},
    "field":   {"model_version": "football-field-detection-f07vi/<v>"},
}

def main():
    assert os.environ.get("ROBOFLOW_API_KEY"), "set ROBOFLOW_API_KEY (never commit it)"
    MODELS.mkdir(exist_ok=True)
    manifest = {"weights": {}}
    for name, meta in WEIGHTS.items():
        dest = MODELS / f"{name}.pt"
        url = _download_via_roboflow_sdk(meta["model_version"], dest)  # implement vs SDK docs
        manifest["weights"][name] = {
            "file": dest.name, "url": url, "model_version": meta["model_version"],
            "sha256": sha256_of(dest), "bytes": dest.stat().st_size,
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    (MODELS / "MANIFEST.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote {MODELS/'MANIFEST.json'} with {len(manifest['weights'])} weights")

if __name__ == "__main__":
    main()
```

> `_download_via_roboflow_sdk` is the one piece that talks to the network; implement it against the current `roboflow`/`inference` SDK (source-driven). It returns the resolved download URL recorded in the manifest. It is NOT imported by `pipeline.py` (asserted in Task 10).

- [ ] **Step 6: Checkpoint** — `python -m pytest vision/test -v` green. (`fetch_models.py` network path is exercised manually at setup, not in the suite.)

---

## Task 5: BoT-SORT config builder (`track_config.py`)

ADR §5: build `config/botsort_football.yaml` by copying the *installed* `botsort.yaml` and overriding only five fields, pinning `track_buffer` to the tracker fps.

**Files:**
- Create: `vision/footballcv/track_config.py`
- Test: `vision/test/test_track_config.py`

**Interfaces:**
- Produces: `build_botsort_config(installed_yaml:dict, tracker_fps:float) -> dict`, `write_botsort_config(out_path:Path, installed_yaml_path:Path|None, tracker_fps:float) -> dict`.

- [ ] **Step 1: Write the failing test**

```python
# vision/test/test_track_config.py
from footballcv.track_config import build_botsort_config

INSTALLED = {"tracker_type": "botsort", "track_high_thresh": 0.5, "with_reid": True,
             "gmc_method": "sparseOptFlow", "track_buffer": 30, "match_thresh": 0.8,
             "new_track_thresh": 0.6, "some_other_field": 123}

def test_overrides_only_the_five_fields_and_pins_buffer_to_fps():
    cfg = build_botsort_config(INSTALLED, tracker_fps=5.0)
    assert cfg["with_reid"] is False
    assert cfg["gmc_method"] == "none"
    assert cfg["match_thresh"] == 0.75
    assert cfg["new_track_thresh"] == 0.4
    assert cfg["track_buffer"] == 15          # ~3 s at 5 fps
    assert cfg["tracker_type"] == "botsort"   # preserved
    assert cfg["some_other_field"] == 123     # untouched
    assert cfg["track_high_thresh"] == 0.5    # untouched

def test_buffer_pins_to_native_30fps():
    assert build_botsort_config(INSTALLED, tracker_fps=30.0)["track_buffer"] == 90
```

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `track_config.py`**

```python
# vision/footballcv/track_config.py
from pathlib import Path
import yaml

# ~3 s horizon expressed in frames, pinned to the tracker's actual fps (ADR §5).
TARGET_BUFFER_SECONDS = 3.0
OVERRIDES = {"with_reid": False, "gmc_method": "none",
             "match_thresh": 0.75, "new_track_thresh": 0.4}

def build_botsort_config(installed_yaml: dict, tracker_fps: float) -> dict:
    cfg = dict(installed_yaml)               # start from installed defaults
    cfg.update(OVERRIDES)
    cfg["track_buffer"] = round(TARGET_BUFFER_SECONDS * tracker_fps)
    return cfg

def write_botsort_config(out_path: Path, installed_yaml_path: Path | None,
                         tracker_fps: float) -> dict:
    if installed_yaml_path is None:
        from ultralytics.utils import ROOT          # verify path vs installed ultralytics
        installed_yaml_path = ROOT / "cfg/trackers/botsort.yaml"
    installed = yaml.safe_load(Path(installed_yaml_path).read_text())
    cfg = build_botsort_config(installed, tracker_fps)
    Path(out_path).write_text(yaml.safe_dump(cfg, sort_keys=False))
    return cfg
```

- [ ] **Step 4: Run to verify it passes** → PASS (2 tests).

- [ ] **Step 5: Checkpoint** — full suite green.

---

## Task 6: Frame decode + sampling (`decode.py`)

**Files:**
- Create: `vision/footballcv/decode.py`, `vision/test/conftest.py`
- Test: `vision/test/test_decode.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `iter_frames(video_path:str, sample_fps:float|None=None) -> Iterator[tuple[int,float,np.ndarray]]` yielding `(frame_idx, frame_ts_seconds, frame_bgr)`; `frame_idx`/`frame_ts` are the **source** frame index/time (so sampling never lies about timestamps).

- [ ] **Step 1: Add a synthetic-clip fixture**

```python
# vision/test/conftest.py
import cv2, numpy as np, pytest

@pytest.fixture
def synthetic_clip(tmp_path):
    """A 2 s, 10 fps, 64x48 clip (20 frames) — no footage, generated on the fly."""
    path = str(tmp_path / "synth.mp4")
    w, h, fps, n = 64, 48, 10, 20
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for i in range(n):
        frame = np.full((h, w, 3), i, dtype=np.uint8)   # frame i is solid grey i
        vw.write(frame)
    vw.release()
    return {"path": path, "fps": fps, "n": n}
```

- [ ] **Step 2: Write the failing test**

```python
# vision/test/test_decode.py
from footballcv.decode import iter_frames

def test_full_rate_yields_all_frames(synthetic_clip):
    frames = list(iter_frames(synthetic_clip["path"]))
    assert len(frames) == synthetic_clip["n"]
    idx0, ts0, img0 = frames[0]
    assert idx0 == 0 and ts0 == 0.0 and img0.shape == (48, 64, 3)

def test_sampling_thins_but_keeps_source_timestamps(synthetic_clip):
    # 10 fps source, sample 5 fps -> every 2nd frame; timestamps stay source-true
    frames = list(iter_frames(synthetic_clip["path"], sample_fps=5))
    assert len(frames) == synthetic_clip["n"] // 2
    assert frames[1][0] == 2                      # source idx, not 1
    assert abs(frames[1][1] - 0.2) < 1e-6         # 2 frames @10fps = 0.2 s
```

- [ ] **Step 3: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 4: Implement `decode.py`**

```python
# vision/footballcv/decode.py
from collections.abc import Iterator
import cv2, numpy as np

def iter_frames(video_path: str, sample_fps: float | None = None
                ) -> Iterator[tuple[int, float, np.ndarray]]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"cannot open video: {video_path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = 1 if not sample_fps else max(1, round(src_fps / sample_fps))
    try:
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                yield idx, idx / src_fps, frame      # SOURCE idx/time, never sample-relative
            idx += 1
    finally:
        cap.release()
```

- [ ] **Step 5: Run to verify it passes** → PASS. Checkpoint — full suite green.

---

## Task 7: Player/GK/referee detection (`detect.py`)

Swappable detector interface + the YOLO11 implementation. v1 detects players/GK/referee only (no ball). Vendor the `sports` recipe here.

**Files:**
- Create: `vision/footballcv/detect.py`, `vision/footballcv/vendor/sports/__init__.py` (+ copied modules, pinned SHA)
- Test: `vision/test/test_detect.py`

**Interfaces:**
- Consumes: a frame `np.ndarray` (from `decode`).
- Produces: `class Detector(Protocol): def detect(self, frame) -> "sv.Detections"`; `class YoloDetector(Detector)` constructed with a verified weight path; class ids mapped to `{"player","goalkeeper","referee"}` (ball class dropped in v1). `sv.Detections` carries `xyxy`, `confidence`, `class_id`, and `data["class_name"]`.

- [ ] **Step 1: Write the failing contract test (mocked model — no weights needed)**

```python
# vision/test/test_detect.py
import numpy as np
from footballcv.detect import YoloDetector

class _FakeResult:                       # mimics ultralytics Results just enough for from_ultralytics
    def __init__(self): ...
class _FakeModel:
    names = {0: "player", 1: "goalkeeper", 2: "referee", 3: "ball"}
    def predict(self, frame, **kw): return [_FakeResult()]

def test_v1_drops_ball_and_keeps_person_classes(monkeypatch):
    import footballcv.detect as d
    # from_ultralytics is wrapped so we can return a known sv.Detections in the test
    import supervision as sv
    det = sv.Detections(xyxy=np.array([[0,0,10,10],[5,5,9,9]], float),
                        confidence=np.array([0.9,0.8]),
                        class_id=np.array([0,3]),                  # player + ball
                        data={"class_name": np.array(["player","ball"])})
    monkeypatch.setattr(d, "_detections_from_model_result", lambda r, names: det)
    out = YoloDetector(model=_FakeModel()).detect(np.zeros((48,64,3), np.uint8))
    assert set(out.data["class_name"]) == {"player"}               # ball dropped in v1
    assert len(out) == 1
```

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `detect.py`**

```python
# vision/footballcv/detect.py
from typing import Protocol
import numpy as np
import supervision as sv

PERSON_CLASSES = ("player", "goalkeeper", "referee")   # v1: ball excluded

class Detector(Protocol):
    def detect(self, frame: np.ndarray) -> sv.Detections: ...

def _detections_from_model_result(result, names) -> sv.Detections:
    # Verify against supervision 0.29: sv.Detections.from_ultralytics(result)
    return sv.Detections.from_ultralytics(result)

class YoloDetector:
    def __init__(self, weight_path: str | None = None, device: str = "cuda",
                 imgsz: int = 1280, conf: float = 0.3, model=None):
        if model is None:
            from ultralytics import YOLO            # AGPL; private use only
            model = YOLO(weight_path)
        self.model, self.device, self.imgsz, self.conf = model, device, imgsz, conf

    def detect(self, frame: np.ndarray) -> sv.Detections:
        result = self.model.predict(frame, device=self.device, imgsz=self.imgsz,
                                    conf=self.conf, verbose=False)[0]
        det = _detections_from_model_result(result, getattr(self.model, "names", {}))
        names = det.data.get("class_name")
        if names is not None:
            keep = np.array([n in PERSON_CLASSES for n in names])
            det = det[keep]
        return det
```

> Vendoring: copy Roboflow `sports` modules into `footballcv/vendor/sports/` at a pinned commit SHA (record it in `README.md`, Task 11). v1 uses none of its runtime classes yet except as reference; `teams.py` (Task 8) reuses its `TeamClassifier`/`resolve_goalkeepers_team_id` patterns.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Checkpoint** — full suite green. (Real detection quality is checked in Task 12's acceptance run.)

---

## Task 8: Team classification + anchoring (`teams.py`)

The most logic-heavy stage. Embedding → PCA → KMeans(2) → deterministic anchoring (§7.1), GK by nearest team centroid in **image** xy (v1), referee untouched, degenerate-cluster guard. Tested on **injected synthetic embeddings** — no SigLIP weights needed for the logic.

**Files:**
- Create: `vision/footballcv/teams.py`
- Test: `vision/test/test_teams.py`

**Interfaces:**
- Consumes: per-track player crops (for embedding) + each track's mean image-x.
- Produces: `fit_teams(embeddings:np.ndarray, mean_image_x:np.ndarray, *, seed:int=0, margin:float=...) -> TeamFit` where `TeamFit` has `.label_of(track_index)->int`, `.confidence:str` ("ok"|"low"), `.team0_cluster:int`; an `Embedder` Protocol with a `SiglipEmbedder` impl; `assign_goalkeeper(gk_xy, team_centroids_image) -> int`.

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_teams.py
import numpy as np
from footballcv.teams import fit_teams, assign_goalkeeper

def _two_clusters():
    rng = np.random.RandomState(0)
    a = rng.normal(0, 0.05, (10, 8)) + np.array([1,0,0,0,0,0,0,0])
    b = rng.normal(0, 0.05, (10, 8)) + np.array([0,1,0,0,0,0,0,0])
    emb = np.vstack([a, b])
    # cluster A players are on the LEFT (small x), B on the RIGHT
    xs = np.concatenate([np.full(10, 100.0), np.full(10, 900.0)])
    return emb, xs

def test_anchoring_left_cluster_is_team0_and_deterministic():
    emb, xs = _two_clusters()
    f1 = fit_teams(emb, xs, seed=0)
    f2 = fit_teams(emb, xs, seed=0)
    left_labels  = {f1.label_of(i) for i in range(10)}
    right_labels = {f1.label_of(i) for i in range(10, 20)}
    assert left_labels == {0} and right_labels == {1}        # left -> team 0 (§7.1)
    assert [f1.label_of(i) for i in range(20)] == [f2.label_of(i) for i in range(20)]
    assert f1.confidence == "ok"

def test_degenerate_clusters_flag_low_confidence():
    rng = np.random.RandomState(0)
    emb = rng.normal(0, 0.05, (20, 8))                       # one blob, no real 2-cluster
    xs = rng.uniform(0, 1000, 20)
    assert fit_teams(emb, xs, seed=0).confidence == "low"

def test_gk_assigned_to_nearest_team_centroid_image_xy():
    centroids = {0: np.array([100.0, 50.0]), 1: np.array([900.0, 50.0])}
    assert assign_goalkeeper(np.array([120.0, 55.0]), centroids) == 0
```

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `teams.py`**

```python
# vision/footballcv/teams.py
from dataclasses import dataclass
from typing import Protocol
import numpy as np
from sklearn.decomposition import PCA
from sklearn.cluster import KMeans

MIN_CLUSTER_MARGIN = 1.0   # min inter-centroid distance / mean intra spread for "ok" (seed; tune in §11)

class Embedder(Protocol):
    def embed(self, crops: list[np.ndarray]) -> np.ndarray: ...   # -> (N, D)

@dataclass
class TeamFit:
    labels: np.ndarray        # raw KMeans labels per input row
    team0_cluster: int        # which KMeans cluster is anchored to team 0
    confidence: str           # "ok" | "low"
    def label_of(self, i: int) -> int:
        return 0 if self.labels[i] == self.team0_cluster else 1

def fit_teams(embeddings: np.ndarray, mean_image_x: np.ndarray, *,
              seed: int = 0, margin: float = MIN_CLUSTER_MARGIN) -> TeamFit:
    # PCA + fixed seed (NOT UMAP) for determinism (ADR §5).
    n_comp = min(32, embeddings.shape[1])
    feats = PCA(n_components=n_comp, random_state=seed).fit_transform(embeddings) \
            if embeddings.shape[1] > n_comp else embeddings
    km = KMeans(n_clusters=2, random_state=seed, n_init=10).fit(feats)
    labels = km.labels_
    # degenerate-cluster guard: separation vs intra-cluster spread
    c0, c1 = km.cluster_centers_
    sep = np.linalg.norm(c0 - c1)
    spread = np.mean([np.linalg.norm(feats[labels == k] - km.cluster_centers_[k], axis=1).mean()
                      for k in (0, 1)])
    confidence = "ok" if spread > 0 and sep / spread >= margin else "low"
    # §7.1 anchoring: cluster with smaller mean image-x -> team 0 (tie-break omitted for v1 seed)
    mean_x = {k: mean_image_x[labels == k].mean() for k in (0, 1)}
    team0_cluster = 0 if mean_x[0] <= mean_x[1] else 1
    return TeamFit(labels=labels, team0_cluster=team0_cluster, confidence=confidence)

def assign_goalkeeper(gk_xy: np.ndarray, team_centroids_image: dict[int, np.ndarray]) -> int:
    return min(team_centroids_image, key=lambda t: np.linalg.norm(gk_xy - team_centroids_image[t]))

class SiglipEmbedder:
    """Default embedder; swappable for ResNet/CLIP. The §11 labelled-crop test picks the default."""
    def __init__(self, model_name: str = "google/siglip-base-patch16-224", device: str = "cuda"):
        from transformers import AutoModel, AutoProcessor   # verify call vs installed transformers
        self.processor = AutoProcessor.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name).to(device).eval()
        self.device = device

    def embed(self, crops: list[np.ndarray]) -> np.ndarray:
        import torch
        inputs = self.processor(images=crops, return_tensors="pt").to(self.device)
        with torch.no_grad():
            feats = self.model.get_image_features(**inputs)
        return feats.cpu().numpy()
```

- [ ] **Step 4: Run to verify it passes** → PASS (3 tests).

- [ ] **Step 5: Checkpoint** — full suite green.

---

## Task 9: Annotated-video output (`report.py`)

v1 writes `annotated.mp4` only (boxes + track IDs + team colours). Drawing via `supervision` annotators; encode via ffmpeg/NVENC (CPU `VideoWriter` is the known ~12 fps bottleneck — ADR §10).

**Files:**
- Create: `vision/footballcv/report.py`
- Test: `vision/test/test_report.py`

**Interfaces:**
- Consumes: a stream of `(frame_bgr, WorldState)` and an output dir.
- Produces: `annotate_frame(frame, ws:WorldState, team_colors:dict[int|None,tuple]) -> np.ndarray`; `write_annotated_video(frames_and_states, out_dir:str, fps:float) -> str` (returns the mp4 path).

- [ ] **Step 1: Write the failing test (drawing logic; no model needed)**

```python
# vision/test/test_report.py
import numpy as np
from footballcv.types import PlayerObs, BallObs, WorldState
from footballcv.report import annotate_frame, TEAM_COLORS

def _ws():
    p0 = PlayerObs(7, "player", 0, (5,5,20,40), None, 0.9)
    p1 = PlayerObs(8, "player", 1, (40,5,55,40), None, 0.9)
    return WorldState(0, 0.0, "raw", [p0, p1],
                      BallObs(None, None, 0.0, False))

def test_annotate_returns_modified_frame_same_shape():
    frame = np.zeros((48, 64, 3), np.uint8)
    out = annotate_frame(frame.copy(), _ws(), TEAM_COLORS)
    assert out.shape == frame.shape
    assert out.sum() > 0                      # something was drawn
```

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `report.py`**

```python
# vision/footballcv/report.py
from pathlib import Path
import subprocess
import numpy as np
import supervision as sv

TEAM_COLORS = {0: (0, 122, 255), 1: (255, 64, 64), None: (180, 180, 180)}  # BGR; None = referee

def _detections_and_labels(ws):
    if not ws.players:
        return sv.Detections.empty(), []
    xyxy = np.array([p.image_bbox for p in ws.players], float)
    class_id = np.array([0 if p.team is None else p.team for p in ws.players])
    det = sv.Detections(xyxy=xyxy, class_id=class_id,
                        tracker_id=np.array([p.track_id for p in ws.players]))
    labels = [f"#{p.track_id} {'REF' if p.team is None else 'T'+str(p.team)}" for p in ws.players]
    return det, labels

def annotate_frame(frame: np.ndarray, ws, team_colors: dict) -> np.ndarray:
    det, labels = _detections_and_labels(ws)
    if len(det) == 0:
        return frame
    palette = sv.ColorPalette([sv.Color(*team_colors[0][::-1]), sv.Color(*team_colors[1][::-1])])
    box = sv.BoxAnnotator(color=palette)            # verify annotator API vs supervision 0.29
    lab = sv.LabelAnnotator(color=palette)
    frame = box.annotate(frame, det)
    frame = lab.annotate(frame, det, labels=labels)
    return frame

def write_annotated_video(frames_and_states, out_dir: str, fps: float) -> str:
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    path = out / "annotated.mp4"
    proc, w, h = None, None, None
    for frame, ws in frames_and_states:
        if proc is None:
            h, w = frame.shape[:2]
            proc = _open_nvenc_writer(str(path), w, h, fps)   # ffmpeg -c:v hevc_nvenc, stdin rawvideo
        proc.stdin.write(annotate_frame(frame, ws, TEAM_COLORS).tobytes())
    if proc:
        proc.stdin.close(); proc.wait()
    return str(path)

def _open_nvenc_writer(path, w, h, fps):
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-c:v", "hevc_nvenc", "-pix_fmt", "yuv420p", path]   # verify NVENC flags on the 3060
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)
```

> `annotate_frame` is the unit-tested logic; `_open_nvenc_writer` is exercised by the Task 12 acceptance run (needs ffmpeg + NVENC). For Mac dev without NVENC, fall back to `-c:v libx264` behind a `--encoder` flag.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Checkpoint** — full suite green.

---

## Task 10: Pipeline orchestrator + `--selftest` (`pipeline.py`)

Wires the stages, sets the offline guards FIRST, exposes the CLI, and carries the no-network enforcement (ADR §3/§11 must-fix #1).

**Files:**
- Create: `vision/footballcv/pipeline.py`
- Test: `vision/test/test_pipeline_nonetwork.py`

**Interfaces:**
- Consumes: all prior stages.
- Produces: `run_v1(input, out_dir, *, device, sample_fps, imgsz, models_dir) -> dict` (a small run-summary incl. `provenance`); `main(argv)` CLI with `--input --device --sample-fps --imgsz --out --selftest`; module-level guarantee: `pipeline.py` does **not** import `fetch_models`.

- [ ] **Step 1: Write the failing no-network + import-isolation tests**

```python
# vision/test/test_pipeline_nonetwork.py
import ast, socket
from pathlib import Path
import pytest

PIPE = Path(__file__).resolve().parents[1] / "footballcv" / "pipeline.py"

def test_pipeline_does_not_import_fetch_models():
    tree = ast.parse(PIPE.read_text())
    imported = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import): imported |= {a.name for a in n.names}
        if isinstance(n, ast.ImportFrom): imported.add(n.module or "")
    assert not any("fetch_models" in m for m in imported)

def test_selftest_fails_on_any_socket_connection(monkeypatch):
    import footballcv.pipeline as p
    attempts = []
    real_connect = socket.socket.connect
    def boom(self, addr, *a, **k):
        attempts.append(addr)
        raise AssertionError(f"network attempt to {addr}")
    monkeypatch.setattr(socket.socket, "connect", boom)
    rc = p.main(["--selftest"])
    assert attempts == [], "pipeline made a network call at run time"
    assert rc == 0
```

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement `pipeline.py`**

```python
# vision/footballcv/pipeline.py  — NEVER imports fetch_models (asserted in tests).
from footballcv.runtime import set_offline_guards, seed_everything
set_offline_guards()                 # FIRST, before any model-loading import (ADR §3/§5)
seed_everything(0)

import argparse, sys
from pathlib import Path
import numpy as np

def run_v1(input: str, out_dir: str, *, device="cuda", sample_fps=5.0, imgsz=1280,
           models_dir="models") -> dict:
    from footballcv.decode import iter_frames
    from footballcv.detect import YoloDetector
    from footballcv.track_config import write_botsort_config
    from footballcv.models_io import load_manifest, resolve_weight
    from footballcv.report import write_annotated_video
    from footballcv.types import WorldState, PlayerObs, BallObs

    manifest = load_manifest(Path(models_dir))
    weight = resolve_weight("players", Path(models_dir), manifest)   # SHA-verified or refuse
    tracker_yaml = write_botsort_config(Path("config/botsort_football.yaml"), None, sample_fps)
    # detect+track via Ultralytics model.track(persist=True, tracker=<yaml>); teams fit-once.
    # (Full wiring uses YoloDetector/teams.fit_teams; built incrementally — see Task 12 acceptance.)
    ...
    return {"provenance": {"detector": manifest["weights"]["players"]["model_version"],
                           "detector_sha256": manifest["weights"]["players"]["sha256"],
                           "device": device, "seed": 0, "sample_fps": sample_fps,
                           "track_id_space": "raw"},
            "out": out_dir}

def _selftest() -> int:
    """Synthetic clip + offline-guard assertion + device/seed/weight-SHA print. No network. (ADR §9.)"""
    import os
    assert os.environ["HF_HUB_OFFLINE"] == "1" and os.environ["TRANSFORMERS_OFFLINE"] == "1"
    # build a tiny synthetic clip in-memory and run only the network-free stages (decode/teams logic)
    from footballcv.teams import fit_teams
    emb = np.random.RandomState(0).normal(size=(20, 8)); xs = np.arange(20.0)
    fit = fit_teams(emb, xs, seed=0)
    print(f"selftest OK | device-check skipped | seed=0 | anchoring={fit.team0_cluster} "
          f"| offline_guards=set")
    return 0

def main(argv=None) -> int:
    ap = argparse.ArgumentParser("footballcv")
    ap.add_argument("--input"); ap.add_argument("--out", default="out/clip/")
    ap.add_argument("--device", default="cuda"); ap.add_argument("--sample-fps", type=float, default=5.0)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return _selftest()
    run_v1(args.input, args.out, device=args.device, sample_fps=args.sample_fps, imgsz=args.imgsz)
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

> `_selftest` deliberately exercises only network-free stages so it proves the offline guarantee without needing weights — the fail-on-connect test asserts zero socket attempts. The weight-present-vs-removed case from ADR §11 is covered by Task 4's `resolve_weight` tests; a fuller end-to-end no-network run is added in the Task 12 acceptance once weights exist.

- [ ] **Step 4: Run to verify it passes** → PASS (2 tests).

- [ ] **Step 5: Checkpoint** — `python -m pytest vision/test -v` all green.

---

## Task 11: Setup docs + provenance + lockfile (`README.md`, `samples.manifest.jsonl`, `fetch_fixtures.py`, `requirements.lock`)

The privacy README is a v1 deliverable (ADR §6); the lockfile + clip provenance close must-fix/major items.

**Files:**
- Create: `vision/README.md`, `vision/samples.manifest.jsonl`, `vision/fetch_fixtures.py`, `vision/requirements.lock`
- Test: `vision/test/test_setup_docs.py`

**Interfaces:**
- Produces: `samples.manifest.jsonl` rows `{source, channel, competition, adult_senior_confirmed, date}`; `requirements.lock` (exact frozen versions incl. the torch cu12x index).

- [ ] **Step 1: Write the failing tests**

```python
# vision/test/test_setup_docs.py
import json
from pathlib import Path
V = Path(__file__).resolve().parents[1]

def test_readme_opens_with_privacy_gate():
    head = (V / "README.md").read_text().lower()[:800]
    assert "privacy" in head and ("public" in head and "youth" in head)

def test_samples_manifest_is_valid_jsonl_with_required_fields():
    lines = [l for l in (V / "samples.manifest.jsonl").read_text().splitlines() if l.strip()]
    for l in lines:
        row = json.loads(l)
        for k in ("source", "competition", "adult_senior_confirmed", "date"):
            assert k in row
        assert row["adult_senior_confirmed"] is True     # default-deny: only confirmed adult/pro

def test_lockfile_pins_torch_cuda_index():
    lock = (V / "requirements.lock").read_text()
    assert "download.pytorch.org/whl/cu12" in lock        # the index most likely to break a reinstall
```

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Author the files**

`vision/README.md` — first section is the privacy gate:

```markdown
# footballcv — offline camera/CV match analysis

> ## ⚠️ PRIVACY GATE (ADR-0023 §3 — non-negotiable)
> This tool runs on **PUBLIC adult/professional** football footage ONLY. **No youth/children's
> footage** at any phase. Filming a real youth match is a SEPARATE, later gate (DPIA, consent,
> retention) owned by a future ADR — this project inherits but does NOT discharge it. The pipeline
> makes **no run-time network calls**; weights are SHA-pinned in `models/MANIFEST.json`. `models/`,
> `samples/`, `out/`, and `config/calibration.yaml` are gitignored and never enter version control.

## What it is
v1: detect + track players, split into 2 anchored teams, draw an annotated video. See
[ADR-0023](../decisions/0023-camera-cv-offline-analysis.md).

## Setup
1. `python -m venv .venv && source .venv/bin/activate`
2. `pip install -r requirements.lock`
3. `export ROBOFLOW_API_KEY=...` (never commit it)
4. `python fetch_models.py` then `python fetch_fixtures.py`
5. `python -m footballcv.pipeline --selftest`

## Vendored code
Roboflow `sports` (MIT) is vendored under `footballcv/vendor/sports/` at commit `<RECORD SHA HERE>`.
Ultralytics is AGPL-3.0 — fine while this stays private/undistributed (ADR §5/§12-Q3).
```

`vision/samples.manifest.jsonl` (seed with one row once a real public clip is added; ship with a header-comment-free example only when a clip is actually fetched — initially this file may legitimately be empty until Task 12). For the test to pass, add the first row when the acceptance clip is chosen:

```jsonl
{"source": "https://www.youtube.com/watch?v=<id>", "channel": "<uploader>", "competition": "<adult/senior league>", "adult_senior_confirmed": true, "date": "2026-06-19"}
```

`vision/fetch_fixtures.py` — pulls ONE URL+SHA256-pinned public clip into `samples/` (setup-only, networked; mirrors `fetch_models.py` integrity pattern using `sha256_of`).

`vision/requirements.lock` — produced by `pip freeze` after the venv validates; MUST include the torch cu12x index line, e.g. `--extra-index-url https://download.pytorch.org/whl/cu121` and exact `torch==…`/`ultralytics==…`/`supervision==…` pins.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Checkpoint** — full suite green.

---

## Task 12: Acceptance run on a public clip (the §7-v1 gate)

Not a unit test — the human/agent acceptance gate that proves v1 works end-to-end. Run after Tasks 1–11 are green.

**Steps:**

- [ ] **Step 1:** Choose ONE **fixed, elevated, wide tactical-camera** public adult/pro clip (broadcast is a lower bound — ADR §7). Add its provenance row to `samples.manifest.jsonl` (`adult_senior_confirmed: true`). Download via `fetch_fixtures.py` into the gitignored `samples/`.

- [ ] **Step 2:** Complete the `run_v1` wiring left as `...` in Task 10: per `--sample-fps` frame, `YoloDetector.detect`, feed detections through Ultralytics `model.track(persist=True, tracker="config/botsort_football.yaml")` for `track_id`s, collect player crops per track for a **one-shot** `teams.fit_teams`, cache team per `track_id`, build `WorldState`s (image-space only, `pitch_xy=None`), and `write_annotated_video`.

- [ ] **Step 3:** Run:

```bash
cd vision && source .venv/bin/activate
python -m footballcv.pipeline --input samples/<clip>.mp4 --device cuda --sample-fps 5 --imgsz 1280 --out out/clip/
```
Expected: `out/clip/annotated.mp4` written.

- [ ] **Step 4: Verify the §7-v1 success criteria (pipeline-correctness):**
  - **Detection:** clearly-visible players/GKs/referee are boxed in **≥ 90 %** of frames where unoccluded (count against the clip's actual visible-player count, not 22).
  - **Team anchoring + no flicker:** each `track_id` keeps ONE team colour for 100 % of its frames after fit; **run the clip twice and confirm the team-0/team-1 mapping is identical** (the §7.1 anchoring + determinism gate).
  - **ID stability:** players hold one id while spaced out; ID switches cluster at scrums/throw-ins/crossings — note them as the known v1 limitation (v3 stitch is the candidate fix).
  - **Performance:** completes on the 3060 within the §10 ceiling at 5 fps; a <1 min clip also runs on Mac (`--device mps`).
  - **Privacy:** `README.md` opens with the §3 gate; `python -m footballcv.pipeline --selftest` is green; the no-network test passes.

- [ ] **Step 5:** Record the result (clip, runtime, observed detection rate, any ID-switch hotspots) in a short note appended to `vision/README.md` "v1 acceptance" subsection. v1 is done when the five criteria above hold.

---

## Self-Review

Run against ADR-0023 §7-v1 + the must-fix list:

**1. Spec coverage:**
- v1 deliverables (annotated video, boxes, track IDs, anchored team colours, privacy README) → Tasks 7/8/9/10/12 + 11. ✓
- Must-fix #1 no-network fail-on-connect + offline guards → Task 3 + Task 10. ✓
- Must-fix #2 model-fetch SHA MANIFEST verify-on-load → Task 4. ✓
- Must-fix #3 `vision/.gitignore` sequenced first + tracking test → Task 1. ✓
- Must-fix #4 ffmpeg `v360` — **N/A in v1** (de-warp is v4); not in scope. ✓ (noted)
- High-major #1 distance/speed hygiene, #2 homography held-out validation — **N/A in v1** (analytics=v3, homography=v2); deferred to those plans. ✓ (noted)
- Lockfile + torch cu12x pin → Task 11. Determinism/anchoring → Tasks 3/8. `footballcv` package (no self-shadow) → Task 1/pyproject. Clip provenance manifest → Task 11. ✓

**2. Placeholder scan:** the only intentional `...` is the `run_v1` body completed in Task 12 Step 2 (it depends on the live Ultralytics `model.track` loop, which is an acceptance-run integration, not unit-testable without weights) and the `_download_via_roboflow_sdk` / `_open_nvenc_writer` helpers explicitly flagged as source-driven build-time implementations. No "TODO/TBD" left in tested logic.

**3. Type consistency:** `WorldState`/`PlayerObs`/`BallObs` (Task 2) field names are used identically in Tasks 9/10; `TeamFit.label_of` (Task 8) and `fit_teams` signature match their test and the pipeline wiring; `resolve_weight`/`load_manifest` (Task 4) signatures match Task 10's call; `build_botsort_config`/`write_botsort_config` (Task 5) match Task 10. ✓

---

## Execution Handoff

Plan complete and saved to `docs/vision/2026-06-19-v1-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration (superpowers:subagent-driven-development).

**2. Inline Execution** — execute tasks in this session with checkpoints (superpowers:executing-plans).

**Which approach?**
