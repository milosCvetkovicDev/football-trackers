# vision/test/test_ball_postprocess.py
import numpy as np
from footballcv.ball_postprocess import (
    postprocess_ball_track, ball_known_fraction, interpolate_gaps)


def test_outlier_is_gated_out(ball_track_with_gaps):
    balls, _ = postprocess_ball_track(ball_track_with_gaps["frames"],
                                      conf_floor=0.3, max_jump_px=150.0, max_gap_s=0.5)
    # frame 10's +400px jump must be rejected -> not a real detection there
    assert balls[10].image_xy is None or balls[10].interpolated is True


def test_under_cap_gap_is_interpolated_and_flagged(ball_track_with_gaps):
    balls, _ = postprocess_ball_track(ball_track_with_gaps["frames"],
                                      conf_floor=0.3, max_jump_px=150.0, max_gap_s=0.5)
    for i in (5, 6, 7):                      # the 0.3 s gap < 0.5 s cap -> filled, flagged
        assert balls[i].image_xy is not None and balls[i].interpolated is True
    # linearly between frame4 (x=40) and frame8 (x=80): frame6 ~= 60
    assert abs(balls[6].image_xy[0] - 60.0) < 1.0


def test_over_cap_gap_left_empty(ball_track_with_gaps):
    balls, _ = postprocess_ball_track(ball_track_with_gaps["frames"],
                                      conf_floor=0.3, max_jump_px=150.0, max_gap_s=0.5)
    for i in range(14, 20):                  # the 0.6 s tail gap > cap -> never fabricated
        assert balls[i].image_xy is None and balls[i].interpolated is False


def test_known_fraction_excludes_interpolated_and_missing(ball_track_with_gaps):
    balls, frac = postprocess_ball_track(ball_track_with_gaps["frames"],
                                         conf_floor=0.3, max_jump_px=150.0, max_gap_s=0.5)
    # known = real detections only (not interpolated, not missing); independently recomputed
    assert abs(frac - ball_known_fraction(balls)) < 1e-9
    assert 0.0 <= frac <= 1.0
    # 20 frames, 9 missing/gated, 3 interpolated -> ~8 truly-known
    assert 0.3 < frac < 0.6


def test_interpolate_respects_explicit_cap():
    # a single 1.0 s hole between two knowns at a 1 fps timebase -> over a 0.5 s cap -> empty
    from footballcv.types import BallObs
    observed = [BallObs((0.0, 0.0), None, 0.7, False), None,
                BallObs((20.0, 0.0), None, 0.7, False)]
    ts = [0.0, 1.0, 2.0]
    out = interpolate_gaps(observed, ts, max_gap_s=0.5)
    assert out[1].image_xy is None and out[1].interpolated is False
