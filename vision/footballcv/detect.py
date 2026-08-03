from typing import Protocol
import numpy as np
import supervision as sv

PERSON_CLASSES = ("player", "goalkeeper", "referee")   # v1: ball excluded

class Detector(Protocol):
    def detect(self, frame: np.ndarray) -> sv.Detections: ...

def _detections_from_model_result(result, names) -> sv.Detections:
    # Verify against supervision 0.29: sv.Detections.from_ultralytics(result)
    return sv.Detections.from_ultralytics(result)

class YoloDetector:
    def __init__(self, weight_path: str | None = None, device: str = "cuda",
                 imgsz: int = 1280, conf: float = 0.3, model=None):
        if model is None:
            from ultralytics import YOLO            # AGPL; private use only
            model = YOLO(weight_path)
        self.model, self.device, self.imgsz, self.conf = model, device, imgsz, conf

    def detect(self, frame: np.ndarray) -> sv.Detections:
        result = self.model.predict(frame, device=self.device, imgsz=self.imgsz,
                                    conf=self.conf, verbose=False)[0]
        det = _detections_from_model_result(result, getattr(self.model, "names", {}))
        names = det.data.get("class_name")
        if names is not None:
            keep = np.array([n in PERSON_CLASSES for n in names])
            det = det[keep]
        return det


BALL_CLASS = "ball"


def best_ball_candidate(det: "sv.Detections") -> tuple[float, float, float] | None:
    """The single highest-confidence ball detection as (x_centre, y_centre, conf)."""
    if len(det) == 0:
        return None
    i = int(np.argmax(det.confidence))
    x1, y1, x2, y2 = det.xyxy[i]
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0, float(det.confidence[i]))


class BallDetector:
    """Dedicated small-ball pass (football-ball-detection-rejhg). Loads as a SECOND model
    (one resident at a time, 12 GB — release the player detector first, §5).
    `tiling`: False = plain imgsz=1280; True = sv.InferenceSlicer 2x2 (matches the model's
    2x2-tiled-640 training regime). The recall-per-second winner is the DEFAULT (benchmark in
    the acceptance run); `tiling` defaults to the benchmarked winner once known."""
    def __init__(self, weight_path: str | None = None, device: str = "cuda",
                 imgsz: int = 1280, conf: float = 0.2, tiling: bool = False, model=None):
        if model is None:
            from ultralytics import YOLO            # AGPL; private use only
            model = YOLO(weight_path)
        self.model, self.device, self.imgsz, self.conf, self.tiling = \
            model, device, imgsz, conf, tiling

    def _predict_plain(self, frame: np.ndarray) -> "sv.Detections":
        result = self.model.predict(frame, device=self.device, imgsz=self.imgsz,
                                    conf=self.conf, verbose=False)[0]
        return _ball_only(_detections_from_model_result(result, getattr(self.model, "names", {})))

    def detect(self, frame: np.ndarray) -> "sv.Detections":
        if not self.tiling:
            return self._predict_plain(frame)
        # 2x2 tiling: slice_wh = half the frame, overlap_wh ~100 px, NMS to dedupe seams.
        # supervision 0.29: InferenceSlicer(callback, slice_wh, overlap_wh, overlap_filter, iou_threshold)
        h, w = frame.shape[:2]
        slicer = sv.InferenceSlicer(
            callback=lambda tile: self._predict_plain(tile),
            slice_wh=(w // 2 + 100, h // 2 + 100),
            overlap_wh=(100, 100),
            overlap_filter=sv.OverlapFilter.NON_MAX_SUPPRESSION,
            iou_threshold=0.1)
        return _ball_only(slicer(frame))


def _ball_only(det: "sv.Detections") -> "sv.Detections":
    names = det.data.get("class_name") if det.data else None
    if names is None:
        return det
    keep = np.array([n == BALL_CLASS for n in names])
    return det[keep]
