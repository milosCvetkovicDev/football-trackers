# vision/test/test_pitch.py
import numpy as np
from footballcv.pitch import PitchProjector, feet_point
from footballcv.types import PlayerObs, BallObs, WorldState


def test_feet_point_is_bottom_centre_of_bbox():
    assert feet_point((10, 20, 30, 80)) == (20.0, 80.0)


def test_projection_recovers_known_pitch_points(known_homography):
    proj = PitchProjector(image_points=known_homography["image_points"],
                          pitch_points=known_homography["pitch_points"])
    out = proj.project(known_homography["image_points"])
    # image points were generated FROM the pitch points through H -> recover them
    assert np.allclose(out, known_homography["pitch_points"], atol=1.0)


def test_project_worldstate_fills_feet_and_ball(known_homography):
    proj = PitchProjector(image_points=known_homography["image_points"],
                          pitch_points=known_homography["pitch_points"])
    # a player whose FEET land exactly on a known image point -> known pitch point
    feet_img = tuple(known_homography["image_points"][0])      # corner (0,0) cm
    bbox = (feet_img[0] - 5, feet_img[1] - 40, feet_img[0] + 5, feet_img[1])
    ball_img = tuple(known_homography["image_points"][6])      # centre (6000,3500)
    ws = WorldState(0, 0.0, "raw",
                    [PlayerObs(1, "player", 0, bbox, None, 0.9)],
                    BallObs(image_xy=ball_img, pitch_xy=None, confidence=0.8, interpolated=False))
    out = proj.project_worldstate(ws)
    assert np.allclose(out.players[0].pitch_xy, [0.0, 0.0], atol=2.0)
    assert np.allclose(out.ball.pitch_xy, [6000.0, 3500.0], atol=2.0)


def test_project_worldstate_leaves_ball_none_when_no_detection(known_homography):
    proj = PitchProjector(image_points=known_homography["image_points"],
                          pitch_points=known_homography["pitch_points"])
    ws = WorldState(0, 0.0, "raw", [],
                    BallObs(image_xy=None, pitch_xy=None, confidence=0.0, interpolated=False))
    assert proj.project_worldstate(ws).ball.pitch_xy is None
