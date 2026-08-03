# vision/test/test_calibrate.py
import numpy as np
import pytest
from footballcv.calibrate import grade_calibration, point_set_is_degenerate


def test_held_out_error_is_small_for_a_consistent_point_set(known_homography):
    g = grade_calibration(known_homography["image_points"],
                          known_homography["pitch_points"], n_fit=4)
    # fit on 4, measure on the other 4: a consistent set reprojects tightly
    assert g.held_out_px_error < 2.0
    assert g.verdict == "GOOD"
    assert g.ill_conditioned is False


def test_inconsistent_point_corrupts_held_out_error(known_homography):
    img = known_homography["image_points"].copy()
    img[5] += np.array([80.0, 80.0])              # shove one HELD-OUT point off
    g = grade_calibration(img, known_homography["pitch_points"], n_fit=4)
    assert g.held_out_px_error > 5.0 and g.verdict == "RE-PICK"


def test_rejects_near_collinear_point_set():
    # all image points on (almost) one line -> ill-conditioned H
    img = np.array([[100, 100], [200, 101], [300, 102], [400, 103],
                    [500, 104], [600, 105]], np.float32)
    bad, reason = point_set_is_degenerate(img, min_hull_frac=0.02, min_collinearity=0.15)
    assert bad and "collinear" in reason.lower()


def test_rejects_centre_clustered_small_hull_set():
    # 6 points crammed in a tiny central blob -> small convex hull -> degenerate
    img = np.array([[600, 350], [610, 352], [605, 360], [615, 358],
                    [608, 354], [612, 356]], np.float32)
    bad, reason = point_set_is_degenerate(img, min_hull_frac=0.02, min_collinearity=0.15)
    assert bad and "hull" in reason.lower()


def test_grade_flags_degenerate_set_as_ill_conditioned(known_homography):
    img = np.array([[100, 100], [200, 101], [300, 102], [400, 103],
                    [500, 104], [600, 105], [700, 106], [800, 107]], np.float32)
    g = grade_calibration(img, known_homography["pitch_points"], n_fit=4)
    assert g.ill_conditioned is True and g.verdict == "RE-PICK"
