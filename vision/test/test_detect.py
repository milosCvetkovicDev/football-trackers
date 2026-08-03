import numpy as np
from footballcv.detect import YoloDetector

class _FakeResult:                       # placeholder; from_ultralytics is monkeypatched below
    pass

class _FakeModel:
    names = {0: "player", 1: "goalkeeper", 2: "referee", 3: "ball"}
    def predict(self, frame, **kw): return [_FakeResult()]

def test_v1_drops_ball_and_keeps_person_classes(monkeypatch):
    import footballcv.detect as d
    import supervision as sv
    det = sv.Detections(xyxy=np.array([[0,0,10,10],[5,5,9,9]], float),
                        confidence=np.array([0.9,0.8]),
                        class_id=np.array([0,3]),                  # player + ball
                        data={"class_name": np.array(["player","ball"])})
    monkeypatch.setattr(d, "_detections_from_model_result", lambda r, names: det)
    out = YoloDetector(model=_FakeModel()).detect(np.zeros((48,64,3), np.uint8))
    assert set(out.data["class_name"]) == {"player"}               # ball dropped in v1
    assert len(out) == 1
