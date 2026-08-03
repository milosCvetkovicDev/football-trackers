# ADR-0023 (build-spec form) — Offline camera/CV match analysis (`vision/`): Track B, Path 2

**Status:** Proposed · **Date:** 2026-06-19

This is an **ADR in build-spec form** (a 14-section buildable spec, not the house Context→Decision→Consequences→Alternatives layout) — labelled as such so the README index and this header agree on what it is.

> Incorporates the [2026-06-19 architecture board review](../architecture/reviews/2026-06-19-cv-track-board-review.md) (APPROVE WITH CHANGES): its four must-fix blockers, eleven majors, and polish items are folded into the sections below.

This is the buildable spec (for a later build) for the **camera / computer-vision** initiative — the documented "Track B" of [ADR-0020](0020-tactical-event-detection.md) and "Path 2" of [ADR-0005](0005-technical-metrics-sensor-strategy.md). It defines a **new, standalone Python subproject `vision/`** that does **offline (post-match)** analysis of a **recorded video file**: it detects and tracks both teams + the ball, projects them onto a top-down pitch radar, and emits a stats report. It is the Veo/Trace-style "full analysis" the project has wanted but could not get from 10 Hz single-team GPS. The future capture device is a **GoPro Max 2 (360, 8K)** mounted elevated near the centre line; until it is bought, the software is prototyped on **public** YouTube/broadcast football footage. `vision/` sits **alongside** `firmware/`, `server/`, `client/` — it is **not live**, **not in the Bun server**, and shares no process with the live pipeline. Its output shape (player positions on a pitch over time) is a **structurally analogous** positions-over-time series that a **future adapter can map onto the GPS analytics surface** (`TeamShapeBucket`/`EventsResult`) later — it is not the *same* shape (see §4/§7.3/§12-Q2 for the three concrete mismatches an adapter must bridge).

**Definition of done for the whole initiative:** v1–v4 complete and are useful **on public adult/pro footage alone**. No phase here processes youth footage; the build is never blocked on — nor tempted toward — the real-youth-footage gate (§3, §14).

---

## 1. Overview

`vision/` is a CLI tool: feed it a video file, get back (1) an **annotated video** (boxes + stable IDs + team colours on players, marker on the ball), (2) a **top-down radar animation** (tactical board), and (3) a **stats report** (JSON + a short human-readable summary, schema in §7.4). It runs on the owner's **RTX 3060 (12 GB)** desktop; short clips can be prototyped on a Mac (CPU / Apple **MPS**). The approach is to **stand on proven open source** — Ultralytics YOLO + Roboflow `supervision` + a built-in tracker, with the Roboflow `sports`/football-ai soccer example as the **recipe** — and write only a **thin own modular layer** for the radar, analytics, and export. We do **not** build CV from scratch, and we do **not** wholesale-adopt a foreign end-to-end project.

---

## 2. Goals & Non-Goals

**Goals**
- Detect + track players, split into two teams, detect the ball, project onto a top-down pitch, compute coach-meaningful analytics, and export annotated video + radar + a report — **fully offline**, on the 3060.
- Produce the **same "positions on a pitch over time" data shape** as the GPS pipeline so it can converge with the existing review/metrics surface later.
- Modular stages with crisp input→output contracts, each testable and swappable in isolation.
- Stay essentially free to run (local, no API/LLM/licence fees; only disk for large 360 files).

**Non-Goals (explicitly out of scope)**
- **Not live.** No streaming, no real-time. The latency budget is wall-clock minutes-to-hours, not milliseconds.
- **Not in the Bun server.** `vision/` never imports from `server/`, never touches MQTT/WS/`bun:sqlite`, never runs on the event loop. Convergence with the review path is a **later, separate** integration, not part of this build.
- **No youth footage in any phase.** The entire v1–v4 build runs on public adult/pro footage only (see §3).
- **Not building CV from scratch.** We fine-tune and orchestrate proven models; we do not train detectors or trackers from zero.
- **No 3D ball height, no pass/shot ball-contact events, no jersey-number OCR identity** in v1–v3 (deferred; see §8).
- **No broadcast-grade robustness.** Broadcast TV (cuts/zooms/replays) is supported only as a best-effort prototype target, never the design centre.

---

## 3. Privacy gate (the #1 constraint — non-negotiable)

Children's location/imagery is this project's #1 protected asset ([ADR-0010](0010-location-data-retention.md), [ADR-0020](0020-tactical-event-detection.md) §6 Track-B/B2, [ADR-0005](0005-technical-metrics-sensor-strategy.md) Path 2). Camera footage of minors is a **new, higher-risk data plane** than the pseudonymous GPS store, because it carries **faces**. This spec **realises ADR-0020's deferred Track-B/B2 camera path and inherits — does not discharge — its DPIA obligation.**

**Hard rule for the entire build (v1–v4):**
- Prototype **ONLY on PUBLIC footage** — YouTube/broadcast, **adults/professionals**. No children, no real personal data of anyone the project knows.
- Public-footage-only **DEFERS** the child-video DPIA (which [ADR-0020](0020-tactical-event-detection.md) §6 flags this camera route **reopens**) — it does **not** resolve it. The DPIA is required and unchanged before any real youth footage.
- **Clip selection check (prevent accidental youth footage) — default-deny, durable provenance:** before adding any clip to `samples/`, it must be positively identified as adult/professional senior football. The real failure mode is ambiguous semi-pro / academy / mixed-age footage that *looks* adult, so the rule is **default-deny: discard any clip whose competition/age cannot be positively identified as adult/senior** (not merely "when in doubt, discard"). Do **not** pull "youth tournament" / age-group clips even when public. Provenance is recorded in a **committed, non-gitignored `vision/samples.manifest.jsonl`** (one line per clip: source URL, channel/uploader, competition/league, `adult_senior_confirmed: true`, date) — **not** a free-text note in the gitignored `samples/` dir (which the §10 prune would delete). The manifest is **excluded from the §10 prune**.
- Embeddings, crops, and colours computed by the `teams` stage are **ephemeral per-clip** and need not be persisted. No identity database, no face recognition, no name attribution.
- **Local retention for public clips:** `samples/` and `out/` are working scratch, capped and prunable — see §10 (mirrors the project's bounded-storage posture: the firmware's 256 KB backlog cap, [ADR-0010](0010-location-data-retention.md)'s time-boxed purge).

**Filming a REAL youth match is a SEPARATE, LATER GATE** — it is **not** unlocked, delivered, or closed by this spec (see §14):
- A **DPIA**, parental **consent**, **storage/retention** (mirror [ADR-0010](0010-location-data-retention.md)'s posture — local-only, time-boxed, erasable), and a **lawful basis** are all required before any real-match footage is captured or processed.
- **Nothing with faces or names ever leaves the desktop.** No cloud upload, no third-party API call on real footage, no sharing of raw clips.
- This gate is owned by a **future ADR**; `vision/` is built so that **`pipeline.py` sets offline guards and makes no run-time network calls** — models are downloaded once at setup, and at run time the pipeline sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and ultralytics analytics-off **unconditionally at startup**, so the underlying native code in `ultralytics`/`transformers`/`roboflow` (which historically auto-downloads missing weights and emits telemetry) cannot reach the network. This is **enforced** by the startup env guards plus a **fail-on-connect** test that asserts **zero** connection attempts (not merely zero swallowed exceptions), including a deliberately-removed-weight case that must **error rather than fetch** (see §5, §11).

The privacy README in `vision/` MUST restate this gate at the top, and a present, correct `vision/README.md` privacy section is a **v1 deliverable**.

---

## 4. Architecture — modular stages with data contracts

One pipeline, orchestrated by a CLI, composed of stages each with a **clear input→output contract** so units are testable/swappable in isolation:

```
[dewarp]? → decode → detect → track → teams → pitch(homography) → radar → analytics → report
                                          └ stitch (v3) ┘ before analytics
```

`dewarp` is an **optional out-of-band front pre-pass** (v4, §7.4) that turns a 360 file into a flat clip; the main pipeline begins at `decode` and is identical whether the input is a native flat clip or a de-warped one.

The shared currency is a per-frame **WorldState**. Stages upstream of `pitch` populate image-space fields; `pitch` fills in pitch-space; `analytics`/`report` consume the time series of WorldStates. This is a **structurally analogous "positions over time" series** to the GPS pipeline (`Telemetry` in `server/src/types.ts`): there, a player is `{playerId, serverTs, lat, lon}`; here, a player is `{track_id, team, frame_ts, pitch_xy}`. **It is analogous, not identical** — the durable GPS surface a future adapter would target is `TeamShapeBucket`/`EventsResult` (team-aggregate, lat/lon-equirectangular, **no `playerId`** by privacy design), not per-fix `Telemetry`. **Three concrete mismatches an adapter must bridge:** (1) per-player CV identity → team-aggregate GPS identity; (2) cm-on-`SoccerPitchConfiguration` → lat/lon-equirectangular; (3) anchored-team-0/1 → teamless. The seam is intentional but the mapping is real work (§12-Q2), not a drop-in.

**Data-plane bright line (privacy — holds *when* convergence happens).** The §14 children's-data store is shaped by the live GPS path; do **not** read "same shape, intentional seam" as licence to pipe image-derived artifacts into it. **The only thing that may cross from `vision/` into `server/` or any live store is the de-identified position series** — `{track_id, team, pitch_xy, frame_ts}` — **never** crops, `annotated.mp4`, or any face-bearing frame. Any such integration on real youth data is itself gated behind the §14 future ADR.

**Core per-frame data shape (the frozen contract):**

```python
# pitch_xy is in the SoccerPitchConfiguration space (cm); None until the pitch stage runs.
@dataclass
class PlayerObs:
    track_id: int            # stable id from track stage (raw) / stitch stage (v3)
    cls: str                 # "player" | "goalkeeper" | "referee"
    # NOTE: team in {0,1} bakes in a two-team + GK + referee assumption; bibs / mixed-kit
    # youth scenarios are known FUTURE CONTRACT PRESSURE on this field (see §8 / §14).
    team: int | None         # 0 | 1 for players/GK; None for referee. ANCHORED + stable per clip (§7.1)
    image_bbox: tuple        # (x1, y1, x2, y2) in source pixels
    pitch_xy: tuple | None   # (x_cm, y_cm) top-down, from feet point; None pre-homography
    confidence: float

@dataclass
class BallObs:
    image_xy: tuple | None   # (x, y) pixel centre; None if no detection this frame
    pitch_xy: tuple | None   # ground projection; None pre-homography / no detection
    confidence: float
    interpolated: bool       # True if this position was filled, not detected (honesty flag)

@dataclass
class WorldState:
    frame_idx: int
    frame_ts: float          # seconds from clip start
    track_id_space: str      # 'raw' | 'stitched' — so analytics can ASSERT its precondition
                             # instead of trusting call order; makes the v3 stitch insertion safe
    players: list[PlayerObs]
    ball: BallObs
```

**Stage contracts:**

| Stage | Input | Output | Notes |
|---|---|---|---|
| **dewarp** (v4, optional) | `.360`/equirectangular file + fixed yaw/pitch/fov | rectilinear MP4, locked virtual camera, target **~4K (3840×2160) or 1080p, square pixels (SAR 1:1), distortion already de-warped** | out-of-band ffmpeg `v360` pre-pass (§7.4); output is the `decode` input |
| **decode** | (flat) video file path, sample fps | iterator of `(frame_idx, frame_ts, ndarray BGR)` | frame sampling lever (§10); native rate for tracking, thinned only downstream |
| **detect** | frame | `sv.Detections` (player/GK/ref + ball classes) | YOLO11 via Ultralytics; ball is a **separate pass** (§8) |
| **track** | per-frame detections (persistent) | detections **with `track_id`** | BoT-SORT via `model.track(persist=True)`; ReID **off** for fixed cam. Behind a **swappable tracker interface** (§5) |
| **teams** | player crops (sampled once) + per-frame player detections | `team ∈ {0,1}` per player track (anchored, §7.1); GK by centroid; ref untouched | fit-once embeddings → KMeans; cache per track_id |
| **pitch** | one precomputed homography `H` + player feet points + ball point | `pitch_xy` for each | `cv2.perspectiveTransform`; H is **constant** for a fixed-cam clip |
| **stitch** (v3) | full list of `WorldState` with raw `track_id` | same list with **stable stitched ids** | offline tracklet split/merge; runs before analytics. **Spike, gated** (§7.3) |
| **radar** | stream of `WorldState` | top-down animation frames (+ optional smoothed) | own thin layer; temporal smoothing added here |
| **analytics** | full list of `WorldState` (stitched ids) | metrics dict (possession, distance, etc.) | metric defs in §7.3; keys on **stitched** id |
| **report** | metrics dict + annotated video + radar | files on disk: `annotated.mp4`, `radar.mp4`, `stats.json` (§7.4), `summary.txt` | the deliverable |

Each stage is a module with one public function and a dataclass I/O — swappable (e.g. swap the embedder behind `teams`, swap the detector for RF-DETR behind `detect`, swap the tracker behind `track`).

---

## 5. Tech stack & dependencies (concrete)

- **Python 3.11 — pinned as the single interpreter** for the owner's env (`pyproject.toml` `python_requires == 3.11`); 3.10–3.13 are treated as **known-compatible but untested** (`trackers` package requires ≥3.10).
- **`ultralytics` (pin `>=8.4.60,<8.5`; freeze the exact patch in a lockfile once the venv is validated)** — YOLO11 family (`yolo11n/s/m/l/x`). Start large (`yolo11l`/`yolo11x`) for the wide full-pitch shot. **Licence: AGPL-3.0-or-later** (see note below). Provides `model.track(persist=True, tracker=...)` with built-in **BoT-SORT** (default) / ByteTrack. **Do not pin to a day-old patch release** — pinning to newest-available risks transient yank/regression; choose a known-good release and freeze via lockfile.
- **`supervision` (pin `==0.29.*`; freeze exact in lockfile)** (MIT) — `sv.Detections.from_ultralytics()`, annotators (`BoxAnnotator`, `LabelAnnotator`, `EllipseAnnotator`, `TraceAnnotator`), video I/O (`VideoInfo`, `get_video_frames_generator`, `VideoSink`), `sv.InferenceSlicer` (2×2 tiling for the ball — **this matches the ball model's training regime**, see ball-model note below; not a "slow opt-in"), `sv.crop_image`. **Do NOT use the deprecated `sv.ByteTrack`** (removed in 0.30). Use Ultralytics' tracker, or the standalone **`trackers`** package (Apache-2.0, `ByteTrackTracker`) if a permissive tracker is wanted — note `trackers` has **no ReID and no BoT-SORT** today (see AGPL note).
- **Lockfile + torch CUDA wheel index (committed v1 deliverable).** The range pins above are frozen into a committed **`requirements.lock`** (via `pip-compile`/`uv lock`, or at minimum `pip freeze` after the venv validates — matching `server/bun.lock`). **Pin the torch/torchvision CUDA wheel source explicitly** (the `cu12x` index URL for the 3060 — the part most likely to break a reinstall); re-derive the ultralytics/supervision pins from versions that actually exist at build time rather than from memory.
- **Tracker:** **BoT-SORT** via a versioned `botsort_football.yaml`. Build it by copying the installed `ultralytics/cfg/trackers/botsort.yaml` and overriding **only** these fields (seed values, tune later), leaving every other field — including `tracker_type` — at the installed default:
  - `with_reid: False` — v1 default; framed as **unevaluated on this fixed-cam look-alike-kit view**, not "buys little" (keep off for v1, revisit only with measurement)
  - `gmc_method: none` (fixed cam, no global motion comp)
  - `track_buffer: 90` — **frames, not seconds**, so its seconds-meaning is **fps-coupled** (3 s at native 30 fps, but 18 s at 5 fps). **Pin `track_buffer` to the actual tracker fps** so its real horizon is the intended ~3 s regardless of sample rate.
  - `match_thresh: 0.75`
  - `new_track_thresh: 0.4`

  Resolution of the "use these numbers vs read installed defaults" tension: **use the five seed values above as the override set; read every other field from the installed file at build time** (Ultralytics changes defaults across releases — never hardcode the full file from memory).
- **OpenCV** (`opencv-python` 4.x — note `supervision` may pull `opencv-python-headless`; pick one, fresh venv) — `cv2.findHomography`, `cv2.perspectiveTransform`, undistort, radar drawing.
- **numpy** — let `supervision` 0.29 pull numpy 2.x; pin `'numpy<2'` **only** if a dependency forces it.
- **torch / torchvision** with **CUDA** on the 3060; **MPS / CPU** on Mac. `--device {cuda,mps,cpu}` is a CLI flag (mirrors the `sports` example).
- **Team-classification trio:** `transformers` (SigLIP `google/siglip-base-patch16-224`) + `scikit-learn` (KMeans, **PCA**) — **PCA + fixed `random_state`** (not UMAP) for determinism. Keep the embedder behind a swappable interface (SigLIP / torchvision ResNet / CLIP). **The SigLIP-vs-ResNet/CLIP default is an open choice settled by the §11 labelled-crop test**, not by the blog post — public benchmarks merely *suggest* ResNet/CLIP can beat out-of-box SigLIP, so the default is whichever wins that test. **Degenerate-cluster guard:** if the two KMeans clusters are not separated by a minimum margin, flag **low team-split confidence** rather than emitting a confident 50/50.
- **Determinism scope (backs the §11 "two runs" gate).** PCA/KMeans determinism alone does not make the stack bit-reproducible — CUDA cuDNN kernels, BoT-SORT float-equal ties, and TensorRT-FP16 are not bit-identical. So: set `PYTHONHASHSEED` + torch/np/random seeds + `torch.use_deterministic_algorithms(True)` where feasible, **pin the assertion to the single device the owner runs (the 3060)**, and read the §11 "two runs" gate as **anchoring/team-id-mapping stability, not bit-equality** (TensorRT-FP16, the perf path, is validated by the tolerance/visual checks, not the equality assertion).
- **ffmpeg** with the **`v360`** filter (`equirect:flat`) — the GoPro de-warp **pre-pass** (v4 only). **`v360` is a CPU-only filter** and is the dominant single-threaded cost of the de-warp; `-hwaccel cuda` does **not** accelerate it and, applied naïvely, makes the graph fail (decoded frames live in GPU memory; "Impossible to convert between the formats…"). NVENC (`-c:v hevc_nvenc`) still helps the encode around the CPU-bound middle; the genuine GPU route for a fixed virtual camera is precomputed **`remap`/`remap_opencl`**. See §9/§10 for the corrected command and cost narrative.
- **Optional:** `obss/sahi` or `sv.InferenceSlicer` (ball **2×2 tiling**, v2 — this matches the ball model's training regime, **benchmark-decides-default**, not "slow opt-in"; see ball-model note + §8/§10); `filterpy` (Kalman ball-trajectory smoothing); NVIDIA **TensorRT** (`yolo export format=engine`, FP16) for the **optional** speedup that brings the v2+ wall-clock under the §10 ceiling (per-GPU/imgsz/batch engine build) — not a prerequisite to ship (§12-Q2).

**GPU-memory budget:** the 3060 has **12 GB**. Stages run **sequentially, one model resident at a time** — the player detector, the ball detector, and the SigLIP embedder are loaded/released in turn, never co-resident. `yolo11x` + `yolov8x`-ball + SigLIP do **not** need to fit together; do not run them concurrently.

**Models — downloaded at setup, NOT committed:**
- `football-players-detection-3zvbc` (player / goalkeeper / referee / ball) — primary detector.
- `football-ball-detection-rejhg` (dedicated small-ball model, YOLOv8x) — the v2 ball pass. **The quoted figures are the model's own held-out Bundesliga test split** (the public card reports mAP@50 ≈ **0.925**; older notes circulated ≈ 0.895 / precision ≈ 0.974 / **recall ≈ 0.78** — verify against the **live card at setup**, treat as remembered numbers otherwise). All are broadcast-split figures: **target-view recall is unmeasured and likely worse** — which is exactly why interpolation is **mandatory** and why **recall is the bottleneck, not precision** (§8). This model was trained on **2×2-tiled 640 crops**, so tiled inference (`sv.InferenceSlicer` 2×2) matches its training regime — see the ball-tiling note in §8/§10.
- `football-field-detection-f07vi` (32-point pitch keypoint pose model) — **v4** auto-calibration only.
- All from Roboflow Universe workspace `roboflow-jvuqo`, trained on **DFL Bundesliga broadcast** footage — expect poor transfer to amateur/youth and to a fixed wide GoPro view; **plan to fine-tune** on a small hand-labelled set of the target view before relying on v2/v3 **accuracy** numbers (§7, §8). **Weights carry their own licences** (the Universe ball model card is **CC BY 4.0**); fine for a private project, but attribution is required if weights/outputs are ever redistributed — note alongside the AGPL/publish discussion below.

**Weight fetch (`fetch_models.py`):** a single setup script downloads the three weights into the gitignored `models/`. Source: Roboflow Universe (`roboflow-jvuqo`) via the `roboflow`/`inference` SDK or the model's hosted weights URL; **a Roboflow API key is required** and is read from the `ROBOFLOW_API_KEY` env var (never committed; documented in `vision/README.md`). `fetch_models.py` is the **only** module permitted to touch the network, and only at setup time — it is **not** imported by `pipeline.py`. If a weight is already present in `models/`, the pipeline uses it and makes no call.

**Model-fetch integrity pinning (reproducibility + privacy both rest on it).** Roboflow Universe slugs can be **re-trained under the same name**, so two fetches months apart can silently yield different weights — and `provenance.detector` records only the model *name*, so the divergence would be invisible: you could not prove the binary you ran is the one you reviewed. Therefore `fetch_models.py` writes a **committed `models/MANIFEST.json`** recording, per weight: source URL, Roboflow **model + dataset version**, **SHA256**, byte size, and fetch timestamp. The pipeline **verifies SHA256 on load and refuses to run on mismatch**; the weight hash is surfaced in `stats.json` provenance (§7.4). One committed manifest — no registry, no signing. `MANIFEST.json` itself is committed (it carries no footage and no key), even though `models/` weights are gitignored.

**Offline guards (set unconditionally at startup, per §3).** Before loading any model, `pipeline.py` sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and disables ultralytics analytics/telemetry — unconditionally, not behind a flag — and asserts they are set. This neutralises the auto-download/telemetry paths in `transformers`/`ultralytics`/`roboflow` at run time; it is the run-time half of the §3 "no run-time network calls" guarantee, the other half being the §11 fail-on-connect test.

**Roboflow `sports` (MIT) is a RECIPE, not a dependency.** It is barely maintained (last real commit mid-2024, 1 contributor, no releases). **Vendor** its modules into `vision/` — copy, **pinned to a recorded upstream commit SHA** (note it in `vision/README.md`) — rather than `pip install`-ing it: `ViewTransformer`, `SoccerPitchConfiguration` (12000×7000 cm template), `TeamClassifier`, the radar annotators, `resolve_goalkeepers_team_id`. Vendoring means inheriting its MIT licence and any bugs and tracking upstream fixes manually; the pinned SHA keeps the copy reproducible. This avoids version skew with `supervision` 0.29.

**Licence note (AGPL).** Ultralytics YOLO is **AGPL-3.0**, and it is **viral**: training your own weights does not exempt you; code that "connects directly to the model" is a derivative work. **While `vision/` stays private and undistributed (this hobby project), AGPL does not bite — it only bites on distribution.** The escape hatch, **should the repo ever be published**, is to swap the detector to **RF-DETR** (`rfdetr`, Apache-2.0, **Medium** checkpoint — Base deprecated). **Important coupling:** the primary tracker, BoT-SORT via `model.track()`, is **also** Ultralytics/AGPL code. Taking the escape hatch is therefore **not** a one-module detector swap — it is a detector **and tracker** change: you drop BoT-SORT for the `trackers` package's **ByteTrack** (no BoT-SORT, no ReID there today), which weakens the §8 ID-association story that the v3 stitch spike already leans on. Keeping **both** `detect` and `track` behind clean swappable interfaces (§4) makes this a two-module change rather than a rewrite. No publish is planned, so this is parked (§12).

---

## 6. Project structure

A proposed `vision/` layout — modules per stage, a single CLI entry, a calibration config, gitignored data. The inner package is named **`footballcv/`** (not `vision/`) to avoid a top-level/inner name self-shadow: with two `vision/` levels, `python -m vision.calibrate` and `import vision.types` resolve only by CWD luck (a dual-import trap). Renaming the package makes imports read `from footballcv import types` and the entry point `python -m footballcv.pipeline`; `pyproject.toml` declares the single `footballcv` package.

```
vision/
  README.md                 # what it is + the §3 PRIVACY GATE restated at top (v1 deliverable)
  .gitignore                # COMMITTED — v1 deliverable; lands in the first vision/ commit (§3, must-fix); ignores models/ samples/ out/ config/calibration.yaml *.360 *.mp4 weights
  requirements.txt          # range pins (§5); exact versions frozen in a lockfile after venv validation
  requirements.lock         # COMMITTED — v1 deliverable; pip-compile/uv lock or pip freeze after venv validates (§5)
  pyproject.toml            # declares the single footballcv package; python_requires ==3.11 (3.10–3.13 known-compatible/untested)
  fetch_models.py           # SETUP-ONLY: the only module that touches the network; pulls roboflow-jvuqo weights; writes models/MANIFEST.json (§5)
  fetch_fixtures.py         # SETUP-ONLY: pulls one URL+SHA256-pinned public clip for the test suite (§11)
  config/
    calibration.example.yaml  # pitch-point template (committed, no real data)
    botsort_football.yaml     # versioned tracker config (override set per §5)
  footballcv/               # the package (renamed from vision/ to avoid the self-shadow)
    __init__.py
    pipeline.py             # CLI / orchestrator: decode->...->report (never imports fetch_models); python -m footballcv.pipeline
    decode.py               # frame iterator + sampling
    detect.py               # YOLO11 player+ref+GK; ball pass; swappable detector iface
    track.py                # BoT-SORT wrapper (model.track persist=True); swappable tracker iface
    teams.py                # TeamClassifier (SigLIP->PCA->KMeans), GK centroid, ref passthrough, anchoring
    stitch.py               # v3 SPIKE: offline tracklet stitching -> stable ids (gated, §7.3)
    pitch.py                # ViewTransformer + load homography from calibration.yaml
    dewarp.py               # v4: ffmpeg v360 equirect->flat pre-pass wrapper (out-of-band)
    radar.py                # top-down board renderer + temporal smoothing
    analytics.py            # v3: possession / distance / possession-changes (opt-in, was "passes") / team-shape
    report.py               # writes annotated mp4, radar mp4, stats.json (§7.4), summary.txt
    types.py                # WorldState / PlayerObs / BallObs dataclasses (the contract)
    calibrate.py            # interactive 4+-point picker -> calibration.yaml; self-grading (§11)
  models/                   # gitignored — downloaded weights land here; MANIFEST.json IS committed (§5)
  samples/                  # gitignored — PUBLIC adult/pro prototype clips only (§3); capped/prunable (§10)
  samples.manifest.jsonl    # COMMITTED, non-gitignored — clip provenance (§3); excluded from the §10 prune
  out/                      # gitignored — generated videos/reports; capped/prunable (§10)
  test/
    fixtures/               # COMMITTED tiny synthetic fixtures (no footage) for pixel-dependent stage tests (§11)
    ...                     # per-stage unit tests (see §11)
```

**`vision/.gitignore` is a committed v1 deliverable and must land in the very first commit that introduces `vision/`** — before `samples/` exists. The whole "no footage/weights in the repo" assurance rests on `models/`, `samples/`, `out/`, `config/calibration.yaml`, `*.360`, and `*.mp4` being ignored from the outset; a non-technical owner following §9 setup creates `samples/` and drops a clip in, and the AGPL "should the repo ever be published" path makes git initialisation a live scenario, so the ignore rules must be in force first (sequenced first in §9). A test asserts **no video/weight extensions are tracked** under `vision/` (§11). `config/calibration.example.yaml` is committed as a template; the real `calibration.yaml` (per camera mount) is gitignored. `models/MANIFEST.json` (§5) and `samples.manifest.jsonl` (§3) are **committed** (they carry no footage, no weights, no keys).

---

## 7. Phased delivery v1 → v4

Each phase has concrete deliverables, the components touched, and **checkable success criteria on a public clip**. Thresholds below are **proposed seeds — tune/validate later** (the [ADR-0020](0020-tactical-event-detection.md) convention for heuristics). **v1 is a thin slice** — first visible win, no ball, no homography. Prototype on **fixed, elevated, wide tactical-camera** clips; treat any broadcast result as a lower bound.

**Two-tier success criteria.** Because the Universe weights are broadcast-trained and **no GoPro/target footage exists yet** (§12 Q1), v2/v3 split their criteria:
- **(a) Pipeline-correctness** — geometry, determinism, honesty flags, ID-stability on public clips. **Checkable now**; this is what each phase actually delivers.
- **(b) Accuracy** — recall/possession/distance correctness vs ground truth. **Explicitly deferred** behind "fine-tune on the real target view once a camera and footage exist." Accuracy numbers are **not** phase-gate criteria for v2/v3.

### v1 — Players + tracking + team-split, drawn on the video
**Deliverables:** annotated video with player/GK/referee boxes, stable per-player track IDs, two **anchored** team colours, and the `vision/README.md` privacy section (§3). **No ball, no homography, no radar.**
**Components:** `decode`, `detect` (players/GK/ref classes only), `track` (BoT-SORT, ReID off, `gmc_method:none`), `teams` (fit-once SigLIP→PCA→KMeans; **GK by nearest team centroid in IMAGE xy** in v1, no homography yet; ref as separate class; **anchor** which cluster is team 0 vs team 1 — see §7.1), `report` (annotated mp4 only). `types.WorldState` populated with image-space fields.
**Success criteria (pipeline-correctness, on a fixed wide public clip):**
- **Detection:** outfield players, GKs, and the referee are detected and boxed in **≥ 90 %** of the frames in which they are clearly, unoccluded visible (count tolerance defined against the **actual visible-player count for the chosen clip**, not a nominal 22 — broadcast/wide shots rarely show all 22).
- **Team anchoring + no flicker:** team labels are **cached per track_id** (not re-predicted per frame) and **anchored deterministically** (§7.1) — a given track keeps the same team id for **100 %** of its frames after fit; the team-0/team-1 mapping is identical across two runs of the same clip.
- **ID stability:** on a static wide shot, players hold one id while spaced out; ID switches are concentrated (and expected) at scrums/throw-ins/crossings — documented as a known v1 limitation; the v3 stitch spike is the candidate fix.
- **Performance:** runs end-to-end on the 3060 within the §10 ceiling at the chosen sample rate; runs on a Mac for a <1 min clip.
- **Privacy:** `vision/README.md` opens with the §3 gate; the no-network-at-runtime test (§11) passes.

#### 7.1 Team anchoring (load-bearing for possession)
KMeans cluster ids are arbitrary per run. Possession reports "time-share **per team**", so team 0/1 must be **stable and anchored**, not arbitrary. Anchoring rule (deterministic): after fit, label as **team 0** the cluster whose players have the smaller mean image-x (left side) at the first analysed frame; tie-break by mean kit hue. This mapping is fixed for the whole clip and reproducible across runs (PCA + fixed seed). Anchoring is asserted by the v1 cross-run determinism criterion above.

### v2 — Ball + homography → top-down radar
**Deliverables:** ball detected and marked on the annotated video; a **top-down radar animation** showing both teams + the ball projected onto the `SoccerPitchConfiguration` (12000×7000 cm).
**Components:** `detect` gains a **separate dedicated ball pass** (the `football-ball-detection-rejhg` model). **Benchmark plain `imgsz=1280` vs `sv.InferenceSlicer` 2×2 tiling (2×2 tiles, ~100 px overlap, NMS iou≈0.1) for recall *and* wall-clock, and make the recall-per-second winner the default** — 2×2 tiling **matches the model's training regime** (not a "slow opt-in"); record in §10 which config the wall-clock estimates assume. A **ball post-process** keeps the single most-confident candidate near the recent centroid (confidence floor + max-jump gate), then **Kalman/linear gap-interpolation** with a **capped max gap (≤ 0.5 s)** and the `interpolated=True` honesty flag. `teams` GK assignment **switches to pitch-space centroids** now that H exists (matching §8's deferred note; GKs are excluded from possession/team-shape per §7.3). `calibrate.py` + `pitch.py`: pick **4+ well-separated, non-collinear** pitch landmarks **once** for the fixed mount (self-grading, held-out validated — §7.2), `cv2.findHomography(image_pts, pitch_pts, cv2.RANSAC)`, reuse the **constant** `H` for every frame; project the **feet** (bottom-centre of bbox), not the centre. **Caveat:** the feet-point projection assumes feet are **visible and on the ground plane** — clipped or occluded far-side bbox bottoms are a **distinct `pitch_xy` error source from homography** (a jumping/occluded player projects wrong even with a perfect `H`); documented as a known error mode. `radar.py` with temporal smoothing.
**Success criteria — (a) pipeline-correctness (checkable now on public clips):**
- **Homography geometry (validated on HELD-OUT points, §7.2):** pick **6–8** correspondences, **fit `H` on 4**, and **measure on the rest** — projecting the fit points back through `H` is near-zero **by construction** and proves nothing. The threshold is stated as **pixel error at a named image region** (e.g. ≤ N px near the centre circle) **plus the implied metre error** (≈ ≤ 1.5 m near-camera, ≈ ≤ 4 m far-side — the px→cm scale varies hugely across the frame, so the metre figure is region-dependent; far-side honestly worse, documented).
- **Radar fidelity:** on visual spot-check, the radar matches the video — left-wing play ⇒ left-clustered dots; both teams' shapes track the video; no per-frame jitter (constant H ⇒ none by construction — but a centre-clustered landmark set can still give a *stable wrong* far side, §7.2/§8).
- **Ball honesty:** interpolated segments are visibly flagged; gaps longer than the cap are left empty (no fabrication); a "ball-known fraction" is reported.
- **Anchoring (numeric — a left/right flip still produces "clustered dots", just on the wrong side):** team-0/team-1 mapping stays consistent from v1 (§7.1), **asserted numerically** — pick 2 frames with the ball visibly in the left third and assert **> X %** of the in-possession team's dots have `pitch_x` in the left third. (Only the anchoring check is numericised; the rest stay spot-checks.)
**Success criterion — (b) accuracy (deferred to fine-tune):** ball present on the radar for the large majority of frames after interpolation, evaluated as "fraction of frames with a believable radar position" (**not** raw mAP), on the eventual fixed target view.

#### 7.2 Homography validation (load-bearing for radar + possession + distance)
`findHomography` reprojection error is naturally in **pixels**, and the px→cm scale varies hugely across a wide shot, so a single metre threshold is a fiction — state error **at a named image region**. Validate on **held-out** correspondences: pick 6–8 well-separated landmarks, **fit on 4, measure error on the remaining 2–4** — measuring on the fit points is near-zero by construction and tells you nothing where radar error actually lives. `calibrate.py` is **self-grading**: it computes held-out reprojection error, prints **GOOD / RE-PICK** against the §7-v2 threshold, and **rejects near-collinear / small-convex-hull point sets** (which yield an ill-conditioned `H`), explicitly warning that a **centre-clustered** set (centre circle + halfway line only) produces a **confidently-wrong far side**. A constant `H` removes per-frame *jitter* but **not** the underlying ill-conditioning (§8) — a stable wrong radar is still wrong.

### v3 — Analytics: possession, distance/speed, possession-changes (opt-in), team shape
**Deliverables:** a stats report (`stats.json` per §7.4 + a one-screen `summary.txt`).
**Default path (ships first):** analytics run on **raw `track_id`s**, with the known-limitation caveat that re-entry after occlusion yields a new id (so per-player metrics can be split/merged incorrectly) surfaced in the report.
**Stitch spike (`stitch.py`, gated — §7.3 below):** an **offline tracklet split/merge** pass producing stable ids; attempted **only if** raw-id metric corruption is demonstrated on a target-view clip. The `WorldState` seam means it can be added without reworking analytics.

#### 7.3 Metric definitions (proposed, honest — mirror [ADR-0020](0020-tactical-event-detection.md)'s "movement-derived / unvalidated" labelling)
- **Possession %** — per analysed frame, assign the ball to the nearest player within a radius (seed **3 m**); possession = that player's team; report time-share per team. **Compute in the right-confidence frame:** the 3 m radius lives in `pitch_xy`, where the **far side carries the ≤ 4 m reprojection error the plan itself admits** — so far-side assignment mis-fires in a direction correlated with which team is attacking (structured bias). Therefore **restrict possession to the near/centre zone where reprojection error ≤ ~1.5 m, and emit "far-side possession: not computed"** rather than a biased number. **Honesty:** undefined during interpolated ball segments and dead-ball; report a `ball_known_fraction` alongside, and **when `ball_known_fraction < ~0.7` surface the split as low-confidence**, not a crisp "57.3 / 42.7" (a half-observed clip must not renormalise to a confident 100). **GKs are excluded** from the possession assignment (see GK note below).
- **Distance / speed** — per (stitched-or-raw) id, sum of frame-to-frame `pitch_xy` displacement, **mirroring the GPS metric-hygiene rules in `metric-definitions.md` §2.1/2.2/2.3** (the CV path must not reintroduce the phantom-distance pathology those gate against). Three required guards:
  - **Lower movement floor (noise floor):** ignore per-frame displacement below a floor **tied to the per-region reprojection error** (≈ **1.5 m near**, ≈ **4 m far** — the §7.2 figures are the natural per-region thresholds). Without it, every cm of homography wobble on a *standing* player accrues as distance. This is the CV analogue of §2.1's walking floor.
  - **Smoothing before differencing:** apply a **short moving average** to `pitch_xy` before taking displacements, so single-frame jitter does not become motion.
  - **Speed:** `speed = displacement / Δt` over the **thinned, sampled-fps** timebase — `Δt` = difference of consecutive **`frame_ts`** values (seconds), rate-honest at the sample rate (distance on thinned frames accepts a mild micro-movement under-count vs native rate — stated, not hidden). **`max_speed_ms` is the peak sustained over ≥ 0.3 s**, never a single inter-frame delta (a one-frame delta as peak speed is forbidden by §2.2). **Clamp** segments above the age-band sprint ceiling from [ADR-0019](0019-age-banded-zones-session-config.md) (e.g. ~6 m/s youngest band; adult ceiling ~10 m/s when prototyping on adults) as tracking error.
  - **Honesty label:** report **distance as a noise-floored lower-bound estimate**, not a true total. Reuse the GPS pipeline's youth speed-zone vocabulary where it converges later.
- **Possession changes (heuristic)** — same-team ball-possessor change with ball travel above a distance threshold and no opponent touch in between. **"No opponent touch between" is undetectable from a single camera**, so this is **renamed from "passes"**: surfaced as **"possession changes (heuristic)"** in `summary.txt` and gated behind an **opt-in `--passes` flag** (off by default). **The weakest metric**, a product of three noisy stages (detect → track → ball) — explicitly **not** the Track-B ball-contact event of [ADR-0005](0005-technical-metrics-sensor-strategy.md).
- **Team shape** — per team per time bucket: centroid, convex-hull surface area, stretch/compactness, spread — the same shape *vocabulary* as the GPS Track-A series ([ADR-0020](0020-tactical-event-detection.md)). **Not directly comparable yet:** CV team-shape is **pitch-aligned** (true length × width on `SoccerPitchConfiguration`) while GPS Track-A is **orientation-free** (hull/stretch/spread), so convergence needs the §5/§4 adapter, not a direct join. **GKs are excluded** from the team-shape hull (a GK pinned to the box distorts compactness).

**`stitch.py` is a SPIKE, not a committed deliverable.** GTA-style tracklet split/merge (AFLink + Gaussian-smoothed interpolation patterns) is research-grade machinery, and v3 analytics numbers are unreliable until fine-tuning happens regardless of stitch quality. So: ship analytics on raw ids first; build stitch **only after** raw-id corruption is demonstrated on a real target-view clip; do **not** commit a numeric ID-switch-reduction target before any target footage exists to measure on.

**Success criteria — (a) pipeline-correctness (checkable now):**
- Report writes valid `stats.json` (schema §7.4 validates) + a `summary.txt` readable in one screen.
- `ball_known_fraction` is present and drives possession honesty (low fraction surfaced as low-confidence per §7.3, not hidden); far-side possession is reported "not computed".
- Distance is monotonic-nondecreasing per id, uses the documented sampled-fps timebase, and applies the §7.3 noise floor + pre-smoothing (a standing player accrues ~0 distance); clamped outliers are counted; `max_speed_ms` reflects ≥ 0.3 s sustained peak.
**Success criteria — (b) accuracy (deferred to fine-tune):** possession % directionally correct on a hand-annotated 1-min clip (team camped in attack reads higher); if the stitch spike runs, it measurably reduces ID switches vs raw on a hand-checked clip.

#### 7.4 `stats.json` schema (the primary external deliverable)
Stable, documented shape. Units: distances **m**, speeds **m/s**, pitch coords **cm** (SoccerPitchConfiguration), time **s**. All numbers carry provenance flags so consumers know what is heuristic.

```jsonc
{
  "schema_version": 1,
  "clip": { "source": "samples/clip.mp4", "duration_s": 91.4,
            "sample_fps": 5, "frames_analysed": 457 },
  "provenance": { "detector": "football-players-detection-3zvbc",
                  "detector_sha256": "…",         // weight hash, verified on load vs models/MANIFEST.json (§5)
                  "ball_model_sha256": "…",        // weight hash (null until v2)
                  "tracker_config_hash": "…",      // hash of the resolved botsort_football.yaml
                  "seed": 1234,                    // the fixed seed (PYTHONHASHSEED + torch/np/random)
                  "device": "cuda",                // the single device the run/determinism gate is pinned to (§5)
                  "engine": "pytorch" | "tensorrt-fp16", // perf path; tensorrt validated by tolerance/visual, not equality (§5/§11)
                  "vendored_sports_sha": "…",      // pinned upstream Roboflow `sports` commit (§5)
                  "vision_git_sha": "…",           // the vision/ commit that produced this run
                  "fine_tuned": false,             // true once §12-Q1 fine-tune is applied
                  "ids": "raw" | "stitched",       // which id space metrics key on (mirrors WorldState.track_id_space)
                  "heuristic": true },             // all metrics below are movement-derived/unvalidated
  "possession": {
    "team0_pct": 57.3, "team1_pct": 42.7,
    "confidence": "ok" | "low",                   // "low" when ball_known_fraction < ~0.7 (§7.3) — do not read the split as crisp
    "ball_known_fraction": 0.81,                  // 1 - (interpolated+missing)/frames; honesty gate
    "zone": "near_centre_only",                   // far-side possession not computed (reproj > ~1.5 m there) — §7.3
    "far_side": "not_computed",
    "assign_radius_m": 3.0
  },
  "teams": {
    // GKs excluded from shape hull (§7.3); orientation-FIXED (pitch-aligned), not directly comparable to GPS Track-A (§7.3)
    "0": { "label": "left-at-kickoff",            // anchoring provenance (§7.1)
           "shape": [ { "t_s": 0.0, "centroid_cm": [4210, 3380],
                        "hull_area_m2": 920.0, "spread_m": 31.4 } /* per time bucket */ ] },
    "1": { "label": "right-at-kickoff", "shape": [ /* ... */ ] }
  },
  "players": [
    { "id": 7, "team": 0,
      "distance_m": 812.4,                        // noise-floored LOWER-BOUND estimate (§7.3), not a true total
      "distance_is_lower_bound": true,
      "max_speed_ms": 7.1,                        // peak sustained over >= 0.3 s (§7.3), not a single inter-frame delta
      "clamped_outlier_segments": 3 }             // count of jump-clamped segments (§7.3)
    /* one per stitched-or-raw id */
  ],
  "possession_changes": { "count": 41, "min_travel_m": 5.0, "heuristic": true,
              "opt_in": true,                     // only emitted with --passes (§7.3); off by default
              "note": "renamed from 'passes'; single-camera, no opponent-touch detection; weakest metric" }
}
```

### v4 — GoPro 360 de-warp pre-pass (validated on PUBLIC 360 footage)
**Scope: software only.** v4 builds and validates the de-warp path **entirely on public 360 footage**. It does **not** process youth footage and does **not** open the real-match gate (that is §14, a future ADR).
**Deliverables:** a documented, working path from a 360 `.360`/equirectangular file to a flat virtual-camera clip the v1–v3 stack consumes unchanged.
**Components:** `dewarp.py` — an ffmpeg **`v360` de-warp pre-pass** (`equirect:flat`, **fixed** yaw/pitch/fov; **`v360` runs on CPU** — NVENC for the encode, no whole-graph `-hwaccel cuda`; precomputed `remap`/`remap_opencl` is the GPU route — §9) producing a **flat ~4K (3840×2160) or 1080p wide clip with square pixels (SAR 1:1) and a LOCKED virtual camera** — a drifting auto-reframe would silently break the constant-H assumption, so the virtual camera is fixed, not auto-tracking. The input must first be a **GoPro-Player-exported equirect MP4** (the `.360` is proprietary HEVC/EAC — §9). Distortion is handled here, **before** homography, so straight pitch lines stay straight. Then the existing stages run unchanged. Optional `football-field-detection-f07vi` **auto-calibration** for one-click homography once a camera can be remounted.
**Decision (was open): virtual-camera framing.** Default to a **single locked centre-line view → one constant H**. Two-view (per-touchline) stitching is **not** built; revisit it only if far-side reprojection error on a real mount exceeds the v2 ≤ 4 m far-side threshold.
**Success criteria (pipeline-correctness, on PUBLIC 360 footage):**
- A de-warped flat clip at the specified resolution/SAR feeds v1–v3 **with no stage changes**; players near the original 360 seams/poles are documented hard cases.
- **Line-straightness (numeric procedure):** overlay a known straight pitch line (e.g. the halfway/touchline) and assert **max pixel deviation ≤ N** from a fitted straight line across the de-warped frame (not a "looks straight" eyeball).
- The de-warp is reproducible from recorded yaw/pitch/fov; output properties match the §4 `dewarp` contract.

*(Real youth pitch dimensions, real-footage handling, DPIA/consent/retention all live in §14 — outside this build.)*

---

## 8. Hard problems & mitigations

| Problem | Why hard | Chosen mitigation | Deferred |
|---|---|---|---|
| **Ball detection** | Tiny, fast, motion-blurred, occluded, look-alikes (heads). **Recall (target-view unmeasured, broadcast-split ~0.78 on the dedicated model)** is the bottleneck, not precision. | **Separate** dedicated ball model; **2×2 tiling (`sv.InferenceSlicer`) matches the model's training regime** — in v2, **benchmark plain `imgsz=1280` vs 2×2 tiling for recall *and* wall-clock and make the recall-per-second winner the default** (do not assume plain 1280; record which config the §10 numbers assume). **Mandatory** trajectory interpolation (Kalman/linear) with a **capped gap (≤0.5 s)** + `interpolated` flag; single-candidate-near-centroid + confidence floor + max-jump gate. | 3D ball height (single camera can't recover it); MaxVit/temporal ball models. |
| **Homography calibration** | Auto per-frame keypoint homography is fragile in central views (near-collinear keypoints → ill-conditioned → radar jitter); the Roboflow radar has known flicker. | **Fixed camera ⇒ compute H ONCE** from 4+ hand-picked, well-separated landmarks; reuse constant H; **validate on held-out points** (§7.2); project feet not centre; undistort first. **Removes per-frame jitter (not the underlying ill-conditioning)** — a centre-clustered landmark set still gives a stable *wrong* far side, so `calibrate.py` rejects near-collinear / small-hull sets (§7.2). | Auto pitch-keypoint model (`f07vi`) and PnLCalib → v4, for camera-motion tolerance / one-click. |
| **Team-colour ambiguity** | Similar kits (white vs light-blue), shadows, GK/ref clashes; UMAP non-deterministic. | Embedding-based split (SigLIP, swappable to ResNet/CLIP — **default settled by the §11 labelled-crop test**, not a blog post), **PCA + fixed seed** for determinism, fit-once across the clip, cache+majority-vote per track_id, crop the bbox core, **degenerate-cluster guard** (flag low confidence if the two clusters lack a minimum margin, never a confident 50/50). Ref = separate class; GK = nearest team centroid (**image-space in v1, pitch-space from v2**), but **GK assignment is unreliable during sustained attacks** (the very phase the possession spot-check evaluates) so **GKs are excluded from possession and team-shape** (§7.3). **Anchor** team 0/1 deterministically (§7.1). | Fine-tuning the embedder on the owner's kits; GK's own kit cluster instead of nearest-centroid. |
| **ID switches** | Both built-in trackers are IoU/Kalman-motion based; re-entry after occlusion gets a NEW id by design; same-team jerseys are a worst case for appearance ReID. | Best frame-to-frame tracker (BoT-SORT, **good football detector**, **native frame rate**) + an **offline tracklet-stitch SPIKE** (`stitch.py`) attempted only if raw-id corruption is shown (§7.3); analytics key on the chosen id space. **Do NOT** enable ReID expecting it to fix swaps (cost for little gain on look-alike kits). | A real ReID layer (OSNet via BoxMOT); jersey-number OCR identity. |
| **Detector transfer** | Universe models are trained on **broadcast Bundesliga** — transfers poorly to amateur/youth and to a fixed wide GoPro view. | Prototype on the closest-available fixed wide public clips; **fine-tune** on a small hand-labelled set of the target view before relying on v2/v3 **accuracy** numbers (pipeline-correctness is checkable without it — §7). Detection quality dominates everything downstream. | Full re-train; newer YOLO families (adopt only if re-training own weights for speed). |
| **Broadcast vs fixed cam** | Cuts/zooms/replays shred IDs and homography at every cut; least transferable to the GoPro-from-centre setup. | **Prefer fixed elevated wide tactical clips** for all real evaluation; broadcast = best-effort only, results treated as a lower bound. | Per-shot homography re-estimation; shot-boundary detection. |

---

## 9. How to run

One-time setup. **Sequence the privacy firewall first:** `vision/.gitignore` (the committed v1 deliverable, §3/§6) must be in force **before** `samples/` exists or any clip is downloaded — i.e. it lands in the first commit that creates `vision/`, ahead of the steps below. Then (downloads weights into the gitignored `models/` and writes the committed `models/MANIFEST.json`; the **only** networked step):
```
# 0. PRIVACY FIRST: vision/.gitignore committed (models/ samples/ out/ config/calibration.yaml *.360 *.mp4)
#    before samples/ exists — see §3/§6.
cd vision && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt       # or: pip install -r requirements.lock (the committed lock, §5)
export ROBOFLOW_API_KEY=...            # required by fetch_models.py; never committed
python fetch_models.py                 # pulls roboflow-jvuqo weights into models/ + writes models/MANIFEST.json (SHA256-pinned)
python fetch_fixtures.py               # pulls the one URL+SHA256-pinned public test clip (§11)
```

Calibrate once per fixed camera mount (interactive: click 4+ known pitch points on one representative frame → writes `config/calibration.yaml`; **self-grading** — displays held-out reprojection error with GOOD/RE-PICK and warns on near-collinear / small-hull point sets, §7.2/§11):
```
python -m footballcv.calibrate --frame samples/clip.mp4 --at 00:00:30 --out config/calibration.yaml
```

Run the pipeline (v1 has no `--ball`/`--radar`; v2+ enable them; `--passes` is opt-in, §7.3). **No network access at run time** (offline guards set at startup, §3/§5):
```
python -m footballcv.pipeline --input samples/clip.mp4 --device cuda \
    --sample-fps 5 --imgsz 1280 \
    --calibration config/calibration.yaml \
    --ball --radar --analytics \
    --out out/clip/
# inputs: a flat (rectilinear) video file + the calibration for that mount
# outputs land in out/clip/:
#   annotated.mp4   (boxes + IDs + team colours + ball marker)
#   radar.mp4       (top-down tactical board)
#   stats.json      (machine-readable metrics; schema in §7.4)
#   summary.txt     (one-screen human-readable summary)
```

GoPro path (v4) is an out-of-band pre-pass that produces a flat clip first, then the same command. **The `.360` does not feed `-i` directly:** it is HEVC in GoPro's proprietary EAC packaging, so the realistic path is to **export it to an equirectangular MP4 in GoPro Player first**, then run `ffmpeg v360`. **`v360` runs on CPU** and is the dominant single-threaded cost; `-hwaccel cuda` only helps the HEVC decode + NVENC encode around that CPU-bound middle, and applied to the whole graph it fails ("Impossible to convert between the formats…") because the decoded frames sit in GPU memory. So either drop `-hwaccel cuda` (keep NVENC), or write the explicit hybrid graph that downloads to system memory for `v360` and uploads for encode:
```
# Step 0: GoPro Player → equirect MP4 (handles the proprietary .360/EAC container)
#   GS_match.360  →  equirect.mp4   (done in GoPro Player, not ffmpeg)

# Simple, correct: v360 on CPU, NVENC encode (no -hwaccel cuda on the whole graph)
ffmpeg -i equirect.mp4 \
  -vf "v360=equirect:flat:yaw=0:pitch=-20:h_fov=120:v_fov=70,scale=3840:2160,setsar=1:1" \
  -c:v hevc_nvenc flat.mp4

# Explicit hybrid (HEVC decode on GPU, v360 still on CPU via hwdownload, NVENC encode):
ffmpeg -hwaccel cuda -i equirect.mp4 \
  -vf "hwdownload,format=nv12,v360=equirect:flat:yaw=0:pitch=-20:h_fov=120:v_fov=70,scale=3840:2160,setsar=1:1,hwupload_cuda" \
  -c:v hevc_nvenc flat.mp4

python -m footballcv.pipeline --input flat.mp4 ...
```
For a **fixed** virtual camera the genuine GPU option is a precomputed **`remap`/`remap_opencl`** map instead of `v360` (compute the equirect→rectilinear map once, apply it on the GPU every frame). **Benchmark on the real 8K file before quoting any wall-clock** — the §10 figures are CPU-bound `v360` estimates, not measured.

Self-checks (so a non-technical owner never self-certifies a multi-hour run by eye):
```
python -m footballcv.pipeline --selftest   # synthetic clip + fail-on-connect no-network test + prints device/seed/weight-SHA + green/red
python -m footballcv.pipeline --bench      # measures the §10 wall-clock perf gate on a chosen clip
```

Mac prototyping: `--device mps`, short clips only.

---

## 10. Performance & cost

- **Frame sampling is the single biggest lever.** A 1 h match @30 fps = 108,000 frames; at **5 fps** = 18,000 (6× less work). 10 Hz GPS already proves 5–10 fps is plenty of temporal resolution for player positions; the tracker interpolates between sampled frames. **Run the tracker at native rate** for ID stability if budget allows, and thin only downstream for analytics — never downsample fps just to save time (bigger inter-frame motion → more ID switches).
- **RTX 3060 wall-clock for a 1 h match, by phase (estimates; the quoted figure assumes the config beside it):**
  - **v1** (players only, single detector pass), full 30 fps @1280, `yolo11x` + tracker ≈ **1.5–3 h** (slower than real time); **sampled 5 fps @1280 ≈ 30–60 min**; sampled 5 fps @640 nano ≈ 15–30 min.
  - **v2+** adds a **second** dedicated ball pass + SigLIP team embeddings + **two** final encode passes (`annotated.mp4` + `radar.mp4`). **These figures assume the *plain `imgsz=1280`* ball pass; if the v2 benchmark picks 2×2 tiling as the default (§5/§8), the ball pass multiplies forward passes and these numbers rise — re-state the assumed config once the benchmark decides.** Expect v2+ at sampled 5 fps to trend toward the **upper end / beyond 60 min** on the plain PyTorch path.
  - **Ceiling (phase gate):** with **TensorRT FP16** + sampling, the target is **≤ 60 min for a 1 h match at 5 fps / imgsz 1280** (v1; v2+ may exceed this without further optimisation — stated, not hidden). **Default stance (§12-Q2): v2+ running slow / overnight batch is fine; TensorRT is optional**, not a gate — it is the *optional* lever that brings v2+ under the ceiling, not a prerequisite to ship. Owner has not yet set a hard wall-clock ceiling (§12-Q2); until they do, "v2+ is slow, that's fine" is the working assumption.
- **Resolution tradeoff:** 640→1280 is ~3–4× slower but needed for small far-side players in a wide shot. **TensorRT FP16 export** gives roughly **~2–3× (up to ~3–4× for the large models)** — the default PyTorch path is the slower tier, and which config a quoted number assumes matters.
- **2×2 tiling / SAHI multiplies forward passes** — but it **matches the ball model's training regime** (§5/§8), so it is **not** a "slow opt-in": v2 **benchmarks plain 1280 vs 2×2 tiling for recall-per-second on the 3060 and makes the winner the default**, recording which config these wall-clock numbers assume. Painfully slow on Mac either way.
- **GoPro Max 2 file sizes & capture:** ~**50–65 GB/hour** at default 8K/120 Mbps (up to ~135 GB/hr at **300 Mbps — a GoPro Labs (non-default) firmware feature**, not stock). Continuous 8K is **thermally limited to roughly ~30 min in practice** (rated 66 min, but real-world 8K/30 review reports earlier thermal shutdown) — a full 45-min half + stoppages on one battery is **not** realistic without hot-swaps, cool-down, or dropping to 5.6K. **A static centre-line tripod is the thermal worst case** (no airflow from movement, sun-exposed) — plan for **5.6K or a half-time cool-down**. The 8K decode + `v360` de-warp + re-encode is a heavy **separate pre-pass**; **`v360` is CPU-only and single-threaded** — the 3060 does **not** accelerate the pixel-remap, so this is roughly real-time-to-slower, tens of minutes per match, **CPU-bound regardless of `-hwaccel cuda`** (which only helps the HEVC decode + NVENC encode at the ends, §9). The genuine GPU route is precomputed `remap`/`remap_opencl` (§9); benchmark on the real 8K file before quoting any number. Do it **once** to a flat clip; CV runs on the smaller clip. *(These are new capture-planning facts; no prior ADR records a file-size or battery figure to correct.)*
- **Output rendering is a non-trivial pass:** OpenCV box drawing is cheap, but CPU H.264 `VideoWriter` is a known bottleneck (~12 fps) — use **ffmpeg/NVENC** for the final encode and draw the radar with **OpenCV**, not matplotlib (matplotlib is tens of ms/frame). There are **two encode passes** to budget — `annotated.mp4` and `radar.mp4` — each its own NVENC pass; the wall-clock estimates above must include them. To keep that cheap, **both outputs are 1080p** (a coach review clip does not need 4K, even when the input is de-warped to 4K).
- **Mac:** Apple MPS shows high instantaneous FPS but low average in video loops; treat the Mac as a **short-clip dev box only**, never a match-processing box.
- **Cost:** essentially **free to run** — fully local on the 3060, a few RSD of electricity, **no LLM/API/licence fees** to run. The only recurring cost is **disk** for large 360/8K files.
- **Local retention (bounded local scratch):** `out/` and `samples/` are scratch, not an archive. Keep a soft cap (e.g. **≤ 100 GB** combined) and prune oldest artifacts + de-warped intermediates after processing; delete large de-warped intermediates once `stats.json` is written. This is **bounded local scratch, lighter than [ADR-0010](0010-location-data-retention.md)** because it holds **public** footage — the prune here is manual + size-based, whereas ADR-0010 mandates *automatic time-based* purge. **The committed `samples.manifest.jsonl` (§3) is excluded from this prune.** The §14 real-youth-footage gate **requires ADR-0010-style automatic time-based purge** (this size-based scratch policy is not sufficient there).

---

## 11. Testing approach (hardware-free, per the repo's culture)

Mirror the repo's "verified green without hardware" discipline ([ADR-0020](0020-tactical-event-detection.md), `server/test/e2e.ts`). Each stage is verifiable **in isolation** on **public** clips or synthetic inputs:

**Fixtures.** Pixel-dependent stage tests run against **committed tiny synthetic fixtures** (`test/fixtures/`, no footage) so the suite is runnable on a clean checkout where `samples/` is gitignored; one **URL+SHA256-pinned public clip** is pulled by `fetch_fixtures.py` (§6/§9) for the few tests that need real video.

- **types / contract:** dataclass round-trip; a `WorldState` fixture (including `track_id_space`) is the seam every stage is tested against.
- **gitignore (privacy firewall, must-fix):** assert **no video/weight extensions are tracked** under `vision/` (`git ls-files vision/` contains no `*.mp4`/`*.360`/weight files), proving `vision/.gitignore` (§6) is in force.
- **no-network (privacy gate — fail-on-connect, not "completes"):** (a) **intercept `socket.socket`/`connect` and fail on *any* connection attempt**, asserting **zero attempts** (not merely zero swallowed exceptions); (b) assert `pipeline.py` sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and ultralytics-analytics-off **at startup**; (c) run **two cases** — models pre-populated (run completes), and a **weight deliberately removed** (must **error rather than fetch**); (d) statically assert `pipeline.py`/stage modules do **not** import `fetch_models`. This is the enforcing test for the §3 "sets offline guards and makes no run-time network calls" claim.
- **manifest integrity (must-fix):** tamper a weight (or its recorded SHA256 in `models/MANIFEST.json`) and assert the pipeline **refuses to run on SHA mismatch**; assert the verified hash is surfaced in `stats.json` provenance.
- **decode:** assert frame count / timestamps for a known short clip at a given `--sample-fps`.
- **detect:** run on a handful of fixed frames; assert class counts within tolerance defined against the **actual visible-player count for the chosen clip** (not a nominal 22); **swappable-detector** parity test that the RF-DETR path produces the same `sv.Detections` shape (optional/deferred — only relevant to the parked publish scenario, §12).
- **track:** synthetic two-box-crossing sequence; assert IDs persist while separated; document the expected switch at the crossing (the thing the v3 stitch spike targets).
- **teams:** **determinism test** — same crops twice give identical labels **and identical team-0/1 anchoring** (proves PCA+fixed-seed + §7.1 anchoring, no UMAP); a small labelled crop set asserts **≥ 90 %** 2-team accuracy (this test, not a blog post, **picks the SigLIP/ResNet/CLIP default** — §5); **degenerate-cluster guard** test (clusters with no margin → low-confidence flag, not 50/50); assert no per-frame flicker (cached per track_id). The "two runs identical" determinism here means **team-id mapping/anchoring stability**, not bit-equality (CUDA/BoT-SORT/TensorRT-FP16 are not bit-reproducible — §5); pin the assertion to the single device (the 3060).
- **pitch (held-out validation — major):** **synthetic known homography** — feed known image↔pitch correspondences, assert `perspectiveTransform` recovers the pitch points within tolerance; on a real frame, **fit `H` on 4 landmarks and measure reprojection error on 2–4 HELD-OUT landmarks** (never on the fit points), reported as **pixel error at a named region** plus the implied metre figure against the v2 thresholds (§7.2). Assert `calibrate.py` **rejects a near-collinear / small-hull point set**.
- **ball post-process:** synthetic trajectory with injected gaps — assert interpolation fills within the cap, flags `interpolated=True`, leaves over-cap gaps empty, and a max-jump outlier is rejected.
- **report / stats.json:** validate emitted `stats.json` against the §7.4 schema (keys, units, **all provenance flags present** — weight SHAs, tracker-config hash, seed, device, engine, vendored-sports SHA, `vision_git_sha`, `ids`); assert `ball_known_fraction` ∈ [0,1], possession percentages sum to ~100 over **ball-known near/centre-zone** frames, possession `confidence` flips to `"low"` when `ball_known_fraction < ~0.7`, and `distance_is_lower_bound` is set.
- **radar / analytics:** **numeric anchoring check** (the one numericised gate, §7-v2) — 2 frames with the ball in the left third, assert > X % of the in-possession team's dots have `pitch_x` in the left third; plus a visual spot-check of the radar; analytics on a hand-annotated 1-min clip (known possessor sequence) asserts possession direction, **distance noise-floored at ~0 for a synthetic standing player**, distance monotonicity, `max_speed_ms` over a ≥ 0.3 s sustained window, and the sampled-fps `Δt` timebase.
- **dewarp (v4):** assert the pre-pass output matches the §4 contract (resolution, SAR 1:1, locked camera) on a public 360 clip; **numeric line-straightness** — overlay a known straight line and assert max pixel deviation ≤ N (§7-v4).
- **stitch (v3 spike, only if built):** a clip with a known mid-clip occlusion — assert the two raw tracklets merge to one stable id and ID-switch count drops vs the raw run.
- **`--selftest` / `--bench`:** assert `--selftest` (§9) chains the synthetic clip + fail-on-connect + device/seed/weight-SHA print and returns green/red; `--bench` reports the §10 wall-clock for the perf gate.

All tests run on **public footage / synthetic inputs only** — never children's data (§3).

---

## 12. Open questions & decisions to confirm

**Decisions to confirm (defaults already chosen, revisit triggers noted):**
1. **Fine-tuning trigger (decision-blocking for v2/v3 accuracy):** **Default decision —** v2/v3 ship and pass on **pipeline-correctness** criteria using the broadcast-trained weights; **accuracy** criteria are deferred until a hand-labelled set of the **target view** exists to fine-tune on. **Revisit trigger:** as soon as a GoPro and target-view footage exist, hand-label a small set and fine-tune before quoting any accuracy number. (No GoPro yet — §10.)
2. **Convergence with the GPS review path (genuinely deferred):** when (if ever) do we wire `vision/`'s `WorldState` series into the existing review/metrics surface, and over what interchange format? The target surface is `TeamShapeBucket`/`EventsResult` (not per-fix `Telemetry`), the interchange is the **de-identified position series only** (`{track_id, team, pitch_xy, frame_ts}` — no image artifact, §4 data-plane bright line), and the adapter must bridge the **three mismatches** in §4/§7.3. Any integration touching real youth data is itself gated behind the §14 ADR. Out of scope here; kept open.
3. **AGPL stance (PARKED — no publish planned):** AGPL only bites on distribution; `vision/` stays private and gitignored, so there is no obligation today. Build YOLO11 + BoT-SORT behind the swappable `detect`/`track` interfaces; revisit (swap to RF-DETR + ByteTrack, accepting the tracker downgrade — §5) **only if** publishing is ever planned.

**Owner questions from the [2026-06-19 board review](../architecture/reviews/2026-06-19-cv-track-board-review.md) (NOT yet answered — working defaults below stay in force until the owner answers):**
4. **Is the camera/CV track actually going to be built, or is it speculative?** No doc change either way: if speculative, the must-fix privacy/test hardening still applies the moment any code lands, but the GoPro purchase and v3/v4 work can wait.
5. **Will you accept v2+ "overnight batch" on a 1-hour match, or do you need a wall-clock ceiling?** **Working default (§10): v2+ is slow / overnight is fine; TensorRT optional** (it is the lever that brings v2+ under the ceiling, not a prerequisite to ship). Unchanged until the owner sets a ceiling.
6. **Does v3 need a hard "passes" count at all,** given it's the weakest, most over-claimable metric — or is "possession changes (heuristic)" enough? **Working default (§7.3): renamed to "possession changes (heuristic)" and made `--passes` opt-in (off by default); the capability is kept, just de-emphasised.**
7. **For the youth-footage day (still gated, §14 — not in this plan):** are the children Serbian / in Serbia, and is the club or the owner the **data controller**? This is the existing [ADR-0020](0020-tactical-event-detection.md) DPIA question, restated so it is not forgotten — this plan **inherits but does not discharge** it. **Left open here; resolved by the §14 future ADR, not by this spec.**

---

## 13. References

- [ADR-0005](0005-technical-metrics-sensor-strategy.md) — Leg IMU and/or camera CV for technical metrics; **Path 2** (the camera/CV route) is what this spec realises.
- [ADR-0020](0020-tactical-event-detection.md) **§6 / Track B (B2)** — ball-interaction events deferred pending new sensing; this is that Track-B/B2 camera path, and inherits (does not discharge) the child-video DPIA it flags.
- [ADR-0010](0010-location-data-retention.md) — children's-data retention/erasure posture the real-footage gate (§3, §14) must mirror.
- [ADR-0019](0019-age-banded-zones-session-config.md) — age-banded speed-zone (m/s) vocabulary reused for the distance/speed jump-clamp and future convergence.
- Roboflow `sports` (MIT, vendored recipe): https://github.com/roboflow/sports · soccer example: https://github.com/roboflow/sports/tree/main/examples/soccer
- Roboflow blogs: https://blog.roboflow.com/track-football-players/ · https://blog.roboflow.com/tracking-ball-sports-computer-vision/ · https://blog.roboflow.com/camera-calibration-sports-computer-vision/
- Universe models (`roboflow-jvuqo`, weights carry own licences — ball model CC BY 4.0): https://universe.roboflow.com/roboflow-jvuqo/football-players-detection-3zvbc · `football-ball-detection-rejhg` · https://universe.roboflow.com/roboflow-jvuqo/football-field-detection-f07vi
- Ultralytics: https://docs.ultralytics.com/models/yolo11 · https://docs.ultralytics.com/modes/track/ · `botsort.yaml`: https://github.com/ultralytics/ultralytics/blob/main/ultralytics/cfg/trackers/botsort.yaml · licence: https://www.ultralytics.com/license
- supervision: https://supervision.roboflow.com/ · SAHI: https://supervision.roboflow.com/develop/notebooks/small-object-detection-with-sahi/ · trackers: https://github.com/roboflow/trackers
- RF-DETR (Apache-2.0 alternative): https://github.com/roboflow/rf-detr
- Team split benchmark (SigLIP vs ResNet/CLIP, UMAP determinism): https://medium.com/@szym.kulpinski/clustering-football-players-using-image-embeddings-umap-and-k-means-c5acf9e28fce
- Offline ID stitching: GTA (arXiv:2411.08216) https://arxiv.org/html/2411.08216 · StrongSORT AFLink (arXiv:2308.16651)
- Central-view homography instability: https://arxiv.org/pdf/2504.20052 · PnLCalib (v4): https://github.com/mguti97/PnLCalib
- GoPro de-warp: ffmpeg `v360` https://www.trekview.org/blog/using-ffmpeg-process-gopro-max-360/ · GoPro Max 2 specs: https://gopro.com/en/us/shop/cameras/learn/max2/CHDHZ-311-master.html

---

## 14. Gate (post-v4, future ADR) — real youth footage, NOT delivered here

This section is **not** part of the v1–v4 build and is **not** discharged by this spec. It is the bright line of §3, restated so no phase accidentally crosses it. Before any real youth-match footage is **captured or processed**, a **future ADR** must establish:

- A **DPIA** for the child-video data plane ([ADR-0020](0020-tactical-event-detection.md) §6 flags this camera route reopens it), including the **data-controller / jurisdiction** determination still open as §12-Q7.
- Parental **consent** and a documented **lawful basis**.
- **Storage/retention/erasure** mirroring [ADR-0010](0010-location-data-retention.md) (local-only, erasable) — and specifically **ADR-0010-style *automatic time-based* purge**, not the §10 manual size-based scratch policy (which is sufficient only for public footage).
- The real **youth pitch dimensions** to swap into `SoccerPitchConfiguration` (the 12000×7000 cm default is for the public adult prototype only).
- A reaffirmation that **nothing with faces or names ever leaves the desktop** — no cloud, no third-party API, no raw-clip sharing. **Note `annotated.mp4` is a face-bearing derivative** (boxes drawn over faces, not de-identified): under this gate it is **in-scope for the no-egress / erasure rules exactly like raw clips**, not a "safe" output like `stats.json`.

Until that ADR exists and its gate is satisfied, `vision/` is exercised on public adult/pro footage only.
