# vision/test/test_radar.py
import numpy as np
from footballcv.radar import draw_pitch, pitch_to_canvas, render_radar_frame, TEAM_COLORS
from footballcv.types import PlayerObs, BallObs, WorldState


def test_draw_pitch_returns_canvas_of_expected_size():
    canvas = draw_pitch(width_px=1050, height_px=680)
    assert canvas.shape == (680, 1050, 3)
    assert canvas.sum() > 0                          # pitch lines drawn


def test_pitch_to_canvas_maps_corners_and_centre():
    # SoccerPitchConfiguration is 12000 x 7000 cm
    assert pitch_to_canvas((0, 0), (1050, 680)) == (0, 0)
    assert pitch_to_canvas((12000, 7000), (1050, 680)) == (1050, 680)
    cx, cy = pitch_to_canvas((6000, 3500), (1050, 680))
    assert (cx, cy) == (525, 340)


def test_render_places_team_and_ball_dots():
    p0 = PlayerObs(1, "player", 0, (0, 0, 1, 1), (3000.0, 3500.0), 0.9)   # left half
    p1 = PlayerObs(2, "player", 1, (0, 0, 1, 1), (9000.0, 3500.0), 0.9)   # right half
    ball = BallObs(image_xy=(0, 0), pitch_xy=(6000.0, 3500.0), confidence=0.8, interpolated=False)
    ws = WorldState(0, 0.0, "raw", [p0, p1], ball)
    canvas = render_radar_frame(ws, team_colors=TEAM_COLORS)
    assert canvas.shape[2] == 3 and canvas.sum() > 0
    # the team-0 dot's neighbourhood carries team-0 colour
    cx, cy = pitch_to_canvas((3000.0, 3500.0), (canvas.shape[1], canvas.shape[0]))
    patch = canvas[max(0, cy-6):cy+6, max(0, cx-6):cx+6].reshape(-1, 3)
    assert (patch == np.array(TEAM_COLORS[0])).all(axis=1).any()


def test_render_skips_players_without_pitch_xy():
    p = PlayerObs(1, "player", 0, (0, 0, 1, 1), None, 0.9)   # not projected yet
    ws = WorldState(0, 0.0, "raw", [p], BallObs(None, None, 0.0, False))
    render_radar_frame(ws, team_colors=TEAM_COLORS)          # must not raise
