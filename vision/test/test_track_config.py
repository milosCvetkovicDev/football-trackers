from footballcv.track_config import build_botsort_config

INSTALLED = {"tracker_type": "botsort", "track_high_thresh": 0.5, "with_reid": True,
             "gmc_method": "sparseOptFlow", "track_buffer": 30, "match_thresh": 0.8,
             "new_track_thresh": 0.6, "some_other_field": 123}

def test_overrides_only_the_five_fields_and_pins_buffer_to_fps():
    cfg = build_botsort_config(INSTALLED, tracker_fps=5.0)
    assert cfg["with_reid"] is False
    assert cfg["gmc_method"] == "none"
    assert cfg["match_thresh"] == 0.75
    assert cfg["new_track_thresh"] == 0.4
    assert cfg["track_buffer"] == 15          # ~3 s at 5 fps
    assert cfg["tracker_type"] == "botsort"   # preserved
    assert cfg["some_other_field"] == 123     # untouched
    assert cfg["track_high_thresh"] == 0.5    # untouched

def test_buffer_pins_to_native_30fps():
    assert build_botsort_config(INSTALLED, tracker_fps=30.0)["track_buffer"] == 90
