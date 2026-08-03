from footballcv.decode import iter_frames

def test_full_rate_yields_all_frames(synthetic_clip):
    frames = list(iter_frames(synthetic_clip["path"]))
    assert len(frames) == synthetic_clip["n"]
    idx0, ts0, img0 = frames[0]
    assert idx0 == 0 and ts0 == 0.0 and img0.shape == (48, 64, 3)

def test_sampling_thins_but_keeps_source_timestamps(synthetic_clip):
    # 10 fps source, sample 5 fps -> every 2nd frame; timestamps stay source-true
    frames = list(iter_frames(synthetic_clip["path"], sample_fps=5))
    assert len(frames) == synthetic_clip["n"] // 2
    assert frames[1][0] == 2                      # source idx, not 1
    assert abs(frames[1][1] - 0.2) < 1e-6         # 2 frames @10fps = 0.2 s
