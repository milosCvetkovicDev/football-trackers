# vision/test/test_radar_anchoring.py
from footballcv.radar import frac_dots_in_left_third
from footballcv.types import PlayerObs, BallObs, WorldState


def _frame_with_left_attack(in_possession_team: int):
    """Ball in the left third; the in-possession team camped left, the other spread right."""
    players = []
    for i in range(6):                       # in-possession team: left third (x < 4000)
        players.append(PlayerObs(i, "player", in_possession_team, (0, 0, 1, 1),
                                 (500.0 + i * 400, 3000.0 + i * 100), 0.9))
    other = 1 - in_possession_team
    for i in range(6):                       # other team: right two-thirds
        players.append(PlayerObs(10 + i, "player", other, (0, 0, 1, 1),
                                 (7000.0 + i * 600, 3000.0 + i * 100), 0.9))
    ball = BallObs(image_xy=(0, 0), pitch_xy=(1500.0, 3500.0), confidence=0.8, interpolated=False)
    return WorldState(0, 0.0, "raw", players, ball)


def test_left_third_attack_clusters_in_possession_team_left():
    X = 0.8                                   # the §7-v2 ">X%" threshold (seed)
    for poss_team in (0, 1):                  # holds regardless of which team has the ball
        ws = _frame_with_left_attack(poss_team)
        # 2 frames with the ball in the left third (§7-v2) — reuse the same synthetic frame twice
        for _ in range(2):
            assert frac_dots_in_left_third(ws, poss_team) > X
            assert frac_dots_in_left_third(ws, 1 - poss_team) < X   # other team NOT left-clustered
