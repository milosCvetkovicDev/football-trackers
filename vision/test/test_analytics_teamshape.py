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
