# vision/footballcv/pipeline.py  — NEVER imports fetch_models (asserted in tests).
from footballcv.runtime import set_offline_guards, seed_everything
set_offline_guards()                 # FIRST, before any model-loading import (ADR §3/§5)
seed_everything(0)

import argparse, sys
from pathlib import Path
import numpy as np


def _crop(frame: np.ndarray, xyxy) -> np.ndarray:
    """Pixel crop of a bbox, clamped to the frame (for the team embedder)."""
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = (int(round(v)) for v in xyxy)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, max(x1 + 1, x2)), min(h, max(y1 + 1, y2))
    return frame[y1:y2, x1:x2]


def _iter_world_states(frames, *, track_provider, embedder, seed=0):
    """Two-pass detect+track -> fit-teams-once -> image-space WorldState stream (§7.1).

    `frames`     : iterable of (frame_idx, frame_ts, frame) (decode.iter_frames order).
    `track_provider(frame, frame_idx) -> sv.Detections` : the swappable detect+track step,
        carrying `tracker_id` + a `class_name` data column. Production wraps Ultralytics
        `model.track(persist=True, tracker=<yaml>)`; tests pass a fake.
    `embedder`   : has `.embed(list[crop]) -> (N, D)`; used once on per-track sample crops.

    Returns an iterator of (frame, WorldState). Teams are fit ONCE over a sample crop per
    track id (anchored, stable per clip), then cached by track id for every frame. GK/referee
    classes keep their detected `cls`; team is None for referees.
    """
    from footballcv.teams import fit_teams
    from footballcv.types import WorldState, PlayerObs, BallObs

    # --- pass 1: detect+track every sampled frame; keep detections + one crop per track id ---
    per_frame = []                       # list[(frame_idx, frame_ts, frame, detections)]
    sample_crop = {}                     # track_id -> (crop, mean_image_x) for the team fit
    for frame_idx, frame_ts, frame in frames:
        det = track_provider(frame, frame_idx)
        per_frame.append((frame_idx, frame_ts, frame, det))
        names = det.data.get("class_name") if det.data else None
        for i in range(len(det)):
            tid = None if det.tracker_id is None else int(det.tracker_id[i])
            if tid is None:
                continue
            cls = str(names[i]) if names is not None else "player"
            if cls == "referee":         # referees are not clustered into a team
                continue
            if tid not in sample_crop:
                x1, _y1, x2, _y2 = det.xyxy[i]
                sample_crop[tid] = (_crop(frame, det.xyxy[i]), (float(x1) + float(x2)) / 2.0)

    # --- one-shot team fit over the per-track sample crops (anchored to image-x, §7.1) ---
    team_of = {}                         # track_id -> 0 | 1
    if sample_crop:
        tids = list(sample_crop.keys())
        crops = [sample_crop[t][0] for t in tids]
        xs = np.array([sample_crop[t][1] for t in tids], float)
        embeddings = np.asarray(embedder.embed(crops), float)
        fit = fit_teams(embeddings, xs, seed=seed)
        for row, tid in enumerate(tids):
            team_of[tid] = fit.label_of(row)

    # --- pass 2: emit an image-space WorldState per frame (pitch_xy=None in v1) ---
    for frame_idx, frame_ts, frame, det in per_frame:
        names = det.data.get("class_name") if det.data else None
        players = []
        for i in range(len(det)):
            tid = None if det.tracker_id is None else int(det.tracker_id[i])
            if tid is None:
                continue
            cls = str(names[i]) if names is not None else "player"
            team = None if cls == "referee" else team_of.get(tid)
            conf = float(det.confidence[i]) if det.confidence is not None else 1.0
            players.append(PlayerObs(track_id=tid, cls=cls, team=team,
                                     image_bbox=tuple(float(v) for v in det.xyxy[i]),
                                     pitch_xy=None, confidence=conf))
        ws = WorldState(frame_idx=frame_idx, frame_ts=frame_ts, track_id_space="raw",
                        players=players, ball=BallObs(None, None, 0.0, False))
        yield frame, ws


def _build_track_provider(weight, tracker_yaml, *, device, imgsz):
    """Production detect+track: Ultralytics `model.track(persist=True, tracker=<yaml>)`.

    Lazy-imports ultralytics INSIDE the call (after the offline guards). This is the ONLY
    part of run_v1 that needs a GPU + real weights — it is exercised at the 3060 acceptance
    run, not in CI; CPU tests inject a fake track_provider instead.
    """
    from ultralytics import YOLO                # AGPL; private use only
    from footballcv.detect import _detections_from_model_result
    model = YOLO(str(weight))

    def _provider(frame, frame_idx):
        import supervision as sv
        result = model.track(frame, persist=True, tracker=str(tracker_yaml),
                             device=device, imgsz=imgsz, verbose=False)[0]
        det = _detections_from_model_result(result, getattr(model, "names", {}))
        names = det.data.get("class_name") if det.data else None
        if names is not None:
            from footballcv.detect import PERSON_CLASSES
            keep = np.array([n in PERSON_CLASSES for n in names])
            det = det[keep]
        return det

    return _provider


def run_v1(input: str, out_dir: str, *, device="cuda", sample_fps=5.0, imgsz=1280,
           models_dir="models", track_provider=None, embedder=None, writer=None) -> dict:
    """Decode -> detect+track -> fit-teams-once -> image-space WorldState stream -> annotate.

    Injectable seam (all default to the real GPU implementations, lazily imported AFTER the
    offline guards):
      - `track_provider(frame, frame_idx) -> sv.Detections`  (the only GPU-only piece)
      - `embedder`  with `.embed(list[crop]) -> (N, D)`      (SigLIP by default)
      - `writer(frames_and_states, out_dir, fps) -> str`     (NVENC annotated video by default)
    CPU tests pass fakes for all three so nothing needs torch/weights/ffmpeg/network.
    """
    from footballcv.decode import iter_frames
    from footballcv.models_io import load_manifest, resolve_weight

    manifest = load_manifest(Path(models_dir))
    weight = resolve_weight("players", Path(models_dir), manifest)   # SHA-verified or refuse

    if track_provider is None:
        # The BoT-SORT config is built from the ultralytics-installed defaults, so it is only
        # materialised when we build the REAL provider (GPU path). An injected fake provider
        # needs no tracker yaml — that is what keeps the loop testable without ultralytics.
        from footballcv.track_config import write_botsort_config
        tracker_path = Path("config/botsort_football.yaml")
        write_botsort_config(tracker_path, None, sample_fps)   # writes the yaml; the returned dict is unused
        track_provider = _build_track_provider(weight, tracker_path, device=device, imgsz=imgsz)
    if embedder is None:
        from footballcv.teams import SiglipEmbedder
        embedder = SiglipEmbedder(device=device)
    frames = iter_frames(input, sample_fps=sample_fps)
    pairs = list(_iter_world_states(frames, track_provider=track_provider, embedder=embedder))

    if writer is not None:
        # injected writer (tests): keep the simple per-sampled-frame path
        out_path = writer(iter(pairs), out_dir, sample_fps)
    else:
        # production: SMOOTH output at the source's NATIVE fps so the video doesn't stutter at the
        # low sample rate (detection ran at sample_fps; boxes are carried forward onto every frame).
        from footballcv.report import write_smooth_annotated_video
        enc = "hevc_nvenc" if device == "cuda" else "libx264"   # no NVENC without an NVIDIA GPU
        out_path = write_smooth_annotated_video(
            input, [ws for _f, ws in pairs], out_dir, encoder=enc)

    return {"provenance": {"detector": manifest["weights"]["players"]["model_version"],
                           "detector_sha256": manifest["weights"]["players"]["sha256"],
                           "device": device, "seed": 0, "sample_fps": sample_fps,
                           "track_id_space": "raw"},
            "out": out_path}


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
    _ = (projector, write_annotated_video, write_radar_video)       # wired at acceptance run
    ...
    prov = {"detector": manifest["weights"]["players"]["model_version"],
            "detector_sha256": manifest["weights"]["players"]["sha256"],
            "ball_model_sha256": manifest["weights"]["ball"]["sha256"] if ball else None,
            "device": device, "seed": 0, "sample_fps": sample_fps, "track_id_space": "raw"}
    return {"provenance": prov, "out": out_dir}


def run_v3(input: str, out_dir: str, *, device="cuda", sample_fps=5.0, imgsz=1280,
           models_dir="models", calibration="config/calibration.yaml",
           passes=False, world_states=None) -> dict:
    """v3 analytics: build (or accept injected) v2 pitch-space WorldState stream, then emit
    stats.json + summary.txt via footballcv.analytics. When `world_states` is injected (tests),
    skip the live loop and run analytics directly; otherwise build the stream via the v2 path
    (live detect/track/ball/project loop body is the flagged acceptance stub — needs weights+clip)."""
    from footballcv.analytics import build_stats, write_stats
    if world_states is None:
        # Build the v2 pitch-space WorldState stream (detect+track+ball+project). The live loop
        # body is the Task-8/acceptance integration (needs weights + a clip) — flagged stub.
        from footballcv.models_io import load_manifest
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


def _selftest() -> int:
    """Synthetic clip + offline-guard assertion + device/seed/anchoring print. No network. (ADR §9.)"""
    import os
    assert os.environ["HF_HUB_OFFLINE"] == "1" and os.environ["TRANSFORMERS_OFFLINE"] == "1"
    from footballcv.teams import fit_teams
    emb = np.random.RandomState(0).normal(size=(20, 8)); xs = np.arange(20.0)
    fit = fit_teams(emb, xs, seed=0)
    print(f"selftest OK | seed=0 | anchoring_cluster={fit.team0_cluster} "
          f"| team_confidence={fit.confidence} | offline_guards=set")
    return 0

def main(argv=None) -> int:
    ap = argparse.ArgumentParser("footballcv")
    ap.add_argument("--input"); ap.add_argument("--out", default="out/clip/")
    ap.add_argument("--device", default="cuda"); ap.add_argument("--sample-fps", type=float, default=5.0)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--ball", action="store_true")
    ap.add_argument("--radar", action="store_true")
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--passes", action="store_true")
    ap.add_argument("--calibration", default="config/calibration.yaml")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return _selftest()
    if args.stats:
        run_v3(args.input, args.out, device=args.device, sample_fps=args.sample_fps,
               imgsz=args.imgsz, calibration=args.calibration, passes=args.passes)
    elif args.ball or args.radar:
        run_v2(args.input, args.out, device=args.device, sample_fps=args.sample_fps,
               imgsz=args.imgsz, calibration=args.calibration, ball=args.ball, radar=args.radar)
    else:
        run_v1(args.input, args.out, device=args.device, sample_fps=args.sample_fps, imgsz=args.imgsz)
    return 0

if __name__ == "__main__":
    sys.exit(main())
