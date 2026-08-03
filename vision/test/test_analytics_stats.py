# vision/test/test_analytics_stats.py
from footballcv.analytics import build_stats, write_summary, write_stats
from footballcv.types import PlayerObs, BallObs, WorldState

def _states():
    out = []
    for i in range(10):
        out.append(WorldState(i, i / 5.0, "raw",
            [PlayerObs(7, "player", 0, (0,0,1,1), (3000.0 + 50.0*i, 3500.0), 0.9),
             PlayerObs(8, "player", 1, (0,0,1,1), (9000.0, 3500.0), 0.9)],
            BallObs((0, 0), (3010.0 + 50.0*i, 3500.0), 0.8, False)))
    return out

def test_build_stats_has_schema_shape_and_provenance():
    prov = {"detector": "football-players-detection-3zvbc", "detector_sha256": "abc",
            "ball_model_sha256": None, "tracker_config_hash": "h", "seed": 0,
            "device": "cpu", "engine": "pytorch", "vendored_sports_sha": "s",
            "vision_git_sha": None, "fine_tuned": False, "ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "samples/clip.mp4", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov, passes=False)
    assert stats["schema_version"] == 1
    assert stats["provenance"]["heuristic"] is True and stats["provenance"]["ids"] == "raw"
    assert "team0_pct" in stats["possession"] and "ball_known_fraction" in stats["possession"]
    assert {p["id"] for p in stats["players"]} == {7, 8}
    assert all(p["distance_is_lower_bound"] for p in stats["players"])
    assert "0" in stats["teams"] and "1" in stats["teams"]      # JSON-string team keys (§7.4)
    assert "possession_changes" not in stats                    # passes=False => omitted

def test_build_stats_includes_changes_only_when_passes():
    prov = {"ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "x", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov, passes=True)
    assert stats["possession_changes"]["opt_in"] is True and stats["possession_changes"]["heuristic"] is True

def test_no_player_name_anywhere_in_stats():
    import json
    prov = {"ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "x", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov)
    # the name-firewall: only numeric ids + team, never a name key/value
    blob = json.dumps(stats)
    assert "name" not in blob.lower()

def test_summary_is_readable_and_flags_honesty():
    prov = {"ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "samples/clip.mp4", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov)
    txt = write_summary(stats)
    assert "Possession" in txt and "lower bound" in txt.lower()
    assert "heuristic" in txt.lower() or "unvalidated" in txt.lower()
    assert txt.count("\n") < 40                       # fits one screen

def test_write_stats_emits_both_files(tmp_path):
    import json, os
    prov = {"ids": "raw", "heuristic": True}
    stats = build_stats(_states(), clip_meta={"source": "x", "duration_s": 2.0,
                        "sample_fps": 5, "frames_analysed": 10}, provenance=prov)
    sj, st = write_stats(stats, str(tmp_path))
    assert os.path.exists(sj) and os.path.exists(st)
    assert json.loads(open(sj).read())["schema_version"] == 1
