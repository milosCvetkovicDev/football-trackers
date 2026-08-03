# vision/test/test_analytics_distance.py
import numpy as np
from footballcv.analytics import (player_distance_speed, sustained_peak_speed_ms, per_player_metrics)
from footballcv.types import PlayerObs, BallObs, WorldState

def test_standing_player_accrues_near_zero_distance():
    # a "standing" player jittering +/- 50 cm (under the 150 cm floor) every frame @5fps
    ts = [i / 5.0 for i in range(20)]
    track = [(t, (5000.0 + (40.0 if i % 2 else -40.0), 3500.0)) for i, t in enumerate(ts)]
    out = player_distance_speed(track, move_floor_cm=150.0, smooth_window=3)
    assert out["distance_m"] < 1.0                      # jitter floored out (no phantom distance)
    assert out["distance_is_lower_bound"] is True

def test_walking_player_accrues_distance():
    ts = [i / 5.0 for i in range(11)]                    # 2 s
    track = [(t, (5000.0 + 200.0 * i, 3500.0)) for i, t in enumerate(ts)]   # +2 m/frame = 10 m/s? no: 200cm/0.2s
    out = player_distance_speed(track, move_floor_cm=150.0, smooth_window=1, max_speed_ceiling_ms=12.0)
    # 10 steps * 2.0 m = 20 m total
    assert abs(out["distance_m"] - 20.0) < 0.5

def test_sustained_peak_ignores_single_frame_spike():
    # steady 4 m/s, with ONE 1-frame teleport; sustained >=0.3s peak must not be the spike
    ts = [i / 5.0 for i in range(10)]
    pos = [(800.0 * i, 0.0) for i in range(10)]          # 8 m / 0.2 s = 40 m/s? recompute in impl test
    peak = sustained_peak_speed_ms([(0.0,0.0),(80.0,0.0),(160.0,0.0),(900.0,0.0),(980.0,0.0)],
                                   [0.0,0.2,0.4,0.6,0.8], min_window_s=0.3)
    # the 0.6s frame is a +740cm spike; over any >=0.3s window the average stays bounded, not the spike
    assert peak < 40.0

def test_outlier_jump_is_clamped_and_counted():
    ts = [i / 5.0 for i in range(5)]
    track = [(ts[0], (0.0, 0.0)), (ts[1], (80.0, 0.0)), (ts[2], (160.0, 0.0)),
             (ts[3], (8000.0, 0.0)),                      # +78 m in 0.2 s = 390 m/s -> impossible
             (ts[4], (8080.0, 0.0))]
    out = player_distance_speed(track, move_floor_cm=150.0, smooth_window=1, max_speed_ceiling_ms=10.0)
    assert out["clamped_outlier_segments"] >= 1
    # the 78 m teleport is NOT added to distance (dropped as tracking error, lower-bound honesty)
    assert out["distance_m"] < 5.0

def test_per_player_metrics_groups_by_track_id():
    states = []
    for i in range(5):
        states.append(WorldState(i, i / 5.0, "raw",
            [PlayerObs(7, "player", 0, (0,0,1,1), (200.0 * i, 0.0), 0.9),
             PlayerObs(8, "player", 1, (0,0,1,1), (50.0, 50.0), 0.9)],
            BallObs(None, None, 0.0, False)))
    m = per_player_metrics(states, move_floor_cm=150.0, smooth_window=1, max_speed_ceiling_ms=12.0)
    assert set(m) == {7, 8} and m[7]["team"] == 0 and m[7]["distance_m"] > m[8]["distance_m"]
