# vision/test/test_ball_detect.py
import numpy as np
import supervision as sv
from footballcv.detect import BallDetector, best_ball_candidate


class _FakeBallModel:
    names = {0: "ball"}
    def predict(self, frame, **kw):
        class _R: ...
        return [_R()]


def test_ball_detector_keeps_only_ball_class(monkeypatch):
    import footballcv.detect as d
    det = sv.Detections(xyxy=np.array([[10, 10, 16, 16], [50, 50, 70, 90]], float),
                        confidence=np.array([0.7, 0.4]),
                        class_id=np.array([0, 0]),
                        data={"class_name": np.array(["ball", "player"])})
    monkeypatch.setattr(d, "_detections_from_model_result", lambda r, names: det)
    out = BallDetector(model=_FakeBallModel(), tiling=False).detect(np.zeros((96, 128, 3), np.uint8))
    assert set(out.data["class_name"]) == {"ball"}
    assert len(out) == 1


def test_best_ball_candidate_picks_highest_confidence_centre():
    det = sv.Detections(xyxy=np.array([[10, 10, 16, 16], [40, 40, 46, 46]], float),
                        confidence=np.array([0.6, 0.9]),
                        class_id=np.array([0, 0]),
                        data={"class_name": np.array(["ball", "ball"])})
    x, y, c = best_ball_candidate(det)
    assert (round(x), round(y), c) == (43, 43, 0.9)        # centre of the 0.9 box


def test_best_ball_candidate_none_when_empty():
    assert best_ball_candidate(sv.Detections.empty()) is None


def test_tiling_flag_uses_inference_slicer(monkeypatch):
    import footballcv.detect as d
    calls = {"sliced": 0}
    class _FakeSlicer:
        def __init__(self, callback, **kw): self.callback = kw or callback
        def __call__(self, image):
            calls["sliced"] += 1
            return sv.Detections.empty()
    monkeypatch.setattr(d.sv, "InferenceSlicer", _FakeSlicer)
    BallDetector(model=_FakeBallModel(), tiling=True).detect(np.zeros((96, 128, 3), np.uint8))
    assert calls["sliced"] == 1                            # tiling path routed through the slicer
