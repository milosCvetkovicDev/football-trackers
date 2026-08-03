import os, random

def set_offline_guards() -> None:
    """Set + ASSERT the env guards that neutralise auto-download/telemetry in
    transformers/ultralytics/roboflow. Call FIRST in pipeline.py, before any import
    that loads a model. (ADR §3/§5.)"""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["YOLO_OFFLINE"] = "1"           # ultralytics analytics/telemetry off
    # ultralytics settings telemetry (best-effort; verify key name vs installed ultralytics)
    try:
        from ultralytics import settings
        settings.update({"sync": False})
    except Exception:
        pass
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert os.environ["YOLO_OFFLINE"] == "1"

def seed_everything(seed: int = 0) -> None:
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except Exception:
        pass
    try:
        import torch
        torch.manual_seed(seed)
        torch.use_deterministic_algorithms(True, warn_only=True)
    except Exception:
        pass
