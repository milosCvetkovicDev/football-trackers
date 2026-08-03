import os
from footballcv.runtime import set_offline_guards, seed_everything

def test_offline_guards_set_and_asserted(monkeypatch):
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    set_offline_guards()
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert os.environ.get("YOLO_OFFLINE") == "1"

def test_seed_everything_is_idempotent_and_sets_pythonhashseed(monkeypatch):
    seed_everything(0)
    assert os.environ["PYTHONHASHSEED"] == "0"
