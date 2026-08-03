import numpy as np
from footballcv.types import PlayerObs, BallObs, WorldState
from footballcv.report import annotate_frame, TEAM_COLORS, _carry_forward_index


def test_carry_forward_picks_latest_state_at_or_before_frame_ts():
    ts_list = [0.0, 0.5, 1.0]          # detections at 0.0 / 0.5 / 1.0 s
    assert _carry_forward_index(ts_list, 0.0, 0) == 0
    assert _carry_forward_index(ts_list, 0.3, 0) == 0   # between 0.0 and 0.5 -> hold 0.0
    assert _carry_forward_index(ts_list, 0.5, 0) == 1   # exactly at 0.5 -> advance
    assert _carry_forward_index(ts_list, 0.9, 0) == 1   # between 0.5 and 1.0 -> hold 0.5
    assert _carry_forward_index(ts_list, 9.9, 0) == 2   # past the last -> hold the last
    # index is monotonic: passing a higher start index never goes backwards
    assert _carry_forward_index(ts_list, 0.3, 1) == 1

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
