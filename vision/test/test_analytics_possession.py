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
