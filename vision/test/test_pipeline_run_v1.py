# vision/test/test_pipeline_run_v1.py
#
# End-to-end integration of run_v1 over the synthetic_clip fixture, driving the real
# decode -> detect+track -> fit-teams-once -> WorldState -> annotate orchestration with
# FAKES at the three injectable seams (track_provider / embedder / writer). No torch,
# no weights, no ffmpeg, no network — everything runs in the CPU image.
#
# The ONLY part of run_v1 not exercised here is the production track_provider
# (Ultralytics `model.track(persist=True, tracker=<yaml>)`), which needs a GPU + real
# weights and is covered by the 3060 acceptance run, not CI.

import ast
import json
from pathlib import Path

import numpy as np
import supervision as sv

from footballcv.models_io import sha256_of
from footballcv.pipeline import run_v1


# --- fixture builders -------------------------------------------------------

def _make_models_dir(tmp_path) -> Path:
    """A minimal valid models/ dir: a tiny stub weight blob + a MANIFEST.json whose
    sha256 matches it, so load_manifest/resolve_weight("players", ...) pass."""
    models = tmp_path / "models"
    models.mkdir()
    blob = b"stub-player-weights-not-a-real-pt"
    weight = models / "players.pt"
    weight.write_bytes(blob)
    manifest = {"weights": {"players": {
        "file": "players.pt", "sha256": sha256_of(weight),
        "url": "https://example/players", "model_version": "3zvbc/1", "bytes": len(blob)}}}
    (models / "MANIFEST.json").write_text(json.dumps(manifest))
    return models, manifest


def _fake_track_provider(frame, frame_idx):
    """Four tracked players with STABLE tracker_ids across frames + class_name 'player'.
    Two sit on the left (small image-x) and two on the right, giving the one-shot team fit
    real image-x spread to anchor team 0 to the left half (§7.1). (>=3 crops are needed for
    the silhouette guard inside fit_teams.)"""
    return sv.Detections(
        xyxy=np.array([[10.0, 10.0, 20.0, 40.0],
                       [15.0, 10.0, 25.0, 40.0],
                       [40.0, 10.0, 50.0, 40.0],
                       [45.0, 10.0, 55.0, 40.0]], float),
        confidence=np.array([0.9, 0.88, 0.85, 0.83]),
        class_id=np.array([0, 0, 0, 0]),
        tracker_id=np.array([11, 12, 21, 22]),
        data={"class_name": np.array(["player", "player", "player", "player"])})


class _FakeEmbedder:
    """Deterministic embeddings keyed off each crop's mean colour. The synthetic clip paints
    frame i a solid grey i, and the four fake bboxes sit at distinct x-offsets, so a crop's
    mean is a stable per-track scalar. We map it to one of two well-separated clusters by the
    crop's column position (left two tracks vs right two) -> a clean 2-team split, no torch."""
    def __init__(self):
        self.calls = 0

    def embed(self, crops):
        self.calls += 1
        # crops arrive in track-discovery order: [11, 12, 21, 22] -> first two left, last two right
        n = len(crops)
        return np.array([[0.0, 0.0] if i < n // 2 else [100.0, 100.0] for i in range(n)], float)


class _CapturingWriter:
    """Collects (frame, ws) pairs instead of NVENC-encoding; returns a fake out path."""
    def __init__(self):
        self.captured = []

    def __call__(self, frames_and_states, out_dir, fps):
        for frame, ws in frames_and_states:
            self.captured.append((frame, ws))
        self.fps = fps
        return str(Path(out_dir) / "annotated.mp4")


# --- tests ------------------------------------------------------------------

def test_run_v1_iterates_sampled_frames_and_builds_worldstates(tmp_path, synthetic_clip):
    models, manifest = _make_models_dir(tmp_path)
    embedder = _FakeEmbedder()
    writer = _CapturingWriter()

    # synthetic_clip is 20 frames @ 10 fps. sample_fps=5 -> step = round(10/5)=2 -> 10 frames.
    result = run_v1(synthetic_clip["path"], str(tmp_path / "out"),
                    device="cpu", sample_fps=5.0, imgsz=320, models_dir=str(models),
                    track_provider=_fake_track_provider, embedder=embedder, writer=writer)

    expected_frames = 10
    assert len(writer.captured) == expected_frames
    assert embedder.calls == 1                      # teams fit EXACTLY once over the whole clip

    src_fps = synthetic_clip["fps"]
    for sample_i, (frame, ws) in enumerate(writer.captured):
        src_idx = sample_i * 2                       # decode step is 2 at sample_fps=5
        assert ws.frame_idx == src_idx               # SOURCE idx, not sample-relative
        assert abs(ws.frame_ts - src_idx / src_fps) < 1e-9
        assert ws.track_id_space == "raw"
        assert frame.shape[2] == 3                   # a real decoded frame was passed through
        assert {p.track_id for p in ws.players} == {11, 12, 21, 22}  # stable ids every frame
        for p in ws.players:
            assert p.team in (0, 1)                   # every player anchored to a team
            assert p.cls == "player"
            assert p.pitch_xy is None                 # v1 is image-space only
        # both teams are present and the left tracks anchor to team 0 (image-x anchoring, §7.1)
        assert {p.team for p in ws.players} == {0, 1}
        team_of = {p.track_id: p.team for p in ws.players}
        assert team_of[11] == team_of[12] == 0       # left two -> team 0
        assert team_of[21] == team_of[22] == 1       # right two -> team 1

    # team assignment is STABLE per track id across all frames (no per-frame flicker)
    team_by_tid = {}
    for _frame, ws in writer.captured:
        for p in ws.players:
            team_by_tid.setdefault(p.track_id, p.team)
            assert team_by_tid[p.track_id] == p.team

    # provenance carries the required fields
    prov = result["provenance"]
    assert prov["detector"] == manifest["weights"]["players"]["model_version"]
    assert prov["detector_sha256"] == manifest["weights"]["players"]["sha256"]
    assert prov["device"] == "cpu"
    assert prov["seed"] == 0
    assert prov["sample_fps"] == 5.0
    assert prov["track_id_space"] == "raw"
    assert result["out"].endswith("annotated.mp4")  # the writer's return is surfaced


def test_run_v1_does_not_import_fetch_models():
    # mirror the v2 plan's ast-based guard: the orchestrator never pulls the fetch module
    pipe = Path(__file__).resolve().parents[1] / "footballcv" / "pipeline.py"
    tree = ast.parse(pipe.read_text())
    mods = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            mods |= {a.name for a in n.names}
        if isinstance(n, ast.ImportFrom):
            mods.add(n.module or "")
    assert not any("fetch_models" in m for m in mods)
