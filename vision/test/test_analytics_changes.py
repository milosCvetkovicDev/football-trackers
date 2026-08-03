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
