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
