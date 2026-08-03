from footballcv.types import PlayerObs, BallObs, WorldState

def test_worldstate_roundtrip_image_space_only():
    p = PlayerObs(track_id=7, cls="player", team=0, image_bbox=(1,2,3,4),
                  pitch_xy=None, confidence=0.9)
    ws = WorldState(frame_idx=0, frame_ts=0.0, track_id_space="raw",
                    players=[p], ball=BallObs(image_xy=None, pitch_xy=None,
                                              confidence=0.0, interpolated=False))
    assert ws.track_id_space == "raw"
    assert ws.players[0].pitch_xy is None      # v1: no homography yet
    assert ws.players[0].team == 0

def test_referee_has_no_team():
    r = PlayerObs(track_id=1, cls="referee", team=None, image_bbox=(0,0,1,1),
                  pitch_xy=None, confidence=0.8)
    assert r.team is None
