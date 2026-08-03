import cv2, numpy as np, pytest


@pytest.fixture
def known_homography():
    """A known image<->pitch homography + 8 well-separated correspondences.
    Pitch points are cm on the 12000x7000 SoccerPitchConfiguration; image points
    are their projection through a fixed, deliberately-perspective H (so fit-on-4 /
    measure-on-rest has real, non-trivial held-out error near zero but not exactly 0)."""
    pitch = np.array([[0, 0], [12000, 0], [12000, 7000], [0, 7000],
                      [6000, 0], [6000, 7000], [6000, 3500], [0, 3500]], np.float32)
    # a plausible elevated-wide camera homography (pitch cm -> image px)
    H = np.array([[0.05, 0.004, 60.0],
                  [0.0,  0.03,  40.0],
                  [0.0,  3e-6,  1.0]], np.float32)
    img = cv2.perspectiveTransform(pitch.reshape(-1, 1, 2), H).reshape(-1, 2)
    return {"image_points": img.astype(np.float32),
            "pitch_points": pitch, "H": H}


@pytest.fixture
def ball_track_with_gaps():
    """20 frames @10 fps. Ball moves +5px/frame in x. Frames 5-7 are MISSING (a 0.3 s gap,
    under the 0.5 s cap -> interpolatable). Frames 14-19 are MISSING (a 0.6 s gap -> over cap,
    left empty). Frame 10 carries a wild OUTLIER (+400 px jump) at high confidence."""
    fps = 10.0
    frames = []
    for i in range(20):
        ts = i / fps
        if i in (5, 6, 7) or i >= 14:
            frames.append((ts, None, 0.0))
        elif i == 10:
            frames.append((ts, (10.0 * i + 400.0, 50.0), 0.85))   # outlier jump
        else:
            frames.append((ts, (10.0 * i, 50.0), 0.7))
    return {"frames": frames, "fps": fps}


@pytest.fixture
def synthetic_clip(tmp_path):
    """A 2 s, 10 fps, 64x48 clip (20 frames) — no footage, generated on the fly."""
    path = str(tmp_path / "synth.mp4")
    w, h, fps, n = 64, 48, 10, 20
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    assert vw.isOpened(), "cv2.VideoWriter failed to open (codec/backend issue)"
    for i in range(n):
        frame = np.full((h, w, 3), i, dtype=np.uint8)   # frame i is solid grey i
        vw.write(frame)
    vw.release()
    return {"path": path, "fps": fps, "n": n}
