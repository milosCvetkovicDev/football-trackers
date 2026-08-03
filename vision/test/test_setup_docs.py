import json
from pathlib import Path
V = Path(__file__).resolve().parents[1]

def test_readme_opens_with_privacy_gate():
    head = (V / "README.md").read_text().lower()[:800]
    assert "privacy" in head and ("public" in head and "youth" in head)

def test_samples_manifest_is_valid_jsonl_with_required_fields():
    lines = [l for l in (V / "samples.manifest.jsonl").read_text().splitlines() if l.strip()]
    for l in lines:
        row = json.loads(l)
        for k in ("source", "competition", "adult_senior_confirmed", "date"):
            assert k in row
        assert row["adult_senior_confirmed"] is True     # default-deny: only confirmed adult/pro

def test_lockfile_pins_torch_cuda_index():
    lock = (V / "requirements.lock").read_text()
    assert "download.pytorch.org/whl/cu12" in lock        # the index most likely to break a reinstall
