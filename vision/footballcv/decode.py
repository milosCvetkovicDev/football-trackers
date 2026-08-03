from collections.abc import Iterator
import cv2, numpy as np

def iter_frames(video_path: str, sample_fps: float | None = None
                ) -> Iterator[tuple[int, float, np.ndarray]]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"cannot open video: {video_path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = 1 if not sample_fps else max(1, round(src_fps / sample_fps))
    try:
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                yield idx, idx / src_fps, frame      # SOURCE idx/time, never sample-relative
            idx += 1
    finally:
        cap.release()
