import hashlib
import json

import pytest

import fetch_models
from footballcv.models_io import sha256_of, resolve_weight, load_manifest

# A tiny fake ".pt" blob — what a mocked download writes to `dest`. Distinct per model so the
# per-model sha256 in the manifest is actually exercised, not just one shared value.
FAKE = {
    "players": b"fake-players-weights",
    "ball":    b"fake-ball-weights",
    "field":   b"fake-field-weights",
}


@pytest.fixture(autouse=True)
def _pin_the_fakes(monkeypatch):
    """Since the fetch became checksum-PINNED (audit §6 "Vision"), a download whose bytes do not
    match the pin is refused — which is the whole point, and which these fakes would otherwise trip
    on every call. So the pins are re-pointed at the fake blobs for this module: it tests the
    orchestration, and test_fetch_pinning.py tests the pin comparison itself."""
    pinned = {n: dict(m, sha256=hashlib.sha256(FAKE[n]).hexdigest())
              for n, m in fetch_models.WEIGHTS.items()}
    monkeypatch.setattr(fetch_models, "WEIGHTS", pinned)


def _fake_downloader(file_id, dest):
    """Stand-in for _download_via_gdown: never imports gdown, never hits the network. Picks the
    blob by reverse-mapping the Drive id back to its model name, writes it, returns a fake url."""
    name = next(n for n, m in fetch_models.WEIGHTS.items() if m["drive_id"] == file_id)
    dest.write_bytes(FAKE[name])
    return f"fake://drive/{file_id}"


def test_fetch_all_writes_manifest_with_correct_shas(tmp_path, monkeypatch):
    # No ROBOFLOW_API_KEY in the environment — the default gdown path must not require it.
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    models = tmp_path / "models"

    manifest = fetch_models.fetch_all(models_dir=models, downloader=_fake_downloader)

    # MANIFEST.json was written to the tmp models dir (NOT the real models/).
    mf = models / "MANIFEST.json"
    assert mf.exists()
    on_disk = json.loads(mf.read_text())
    assert on_disk == manifest

    # One entry per model, with the keys models_io needs (file, sha256, model_version),
    # and the sha256 equals sha256_of the fake blob actually written.
    assert set(manifest["weights"]) == set(fetch_models.WEIGHTS)
    for name in fetch_models.WEIGHTS:
        entry = manifest["weights"][name]
        assert entry["file"] == f"{name}.pt"
        assert "model_version" in entry
        assert entry["drive_id"] == fetch_models.WEIGHTS[name]["drive_id"]
        assert entry["bytes"] == len(FAKE[name])
        assert entry["sha256"] == sha256_of(models / f"{name}.pt")


def test_manifest_is_consumable_by_models_io(tmp_path, monkeypatch):
    # End-to-end with the real consumer: load_manifest + resolve_weight must accept what we wrote.
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    models = tmp_path / "models"

    fetch_models.fetch_all(models_dir=models, downloader=_fake_downloader)

    manifest = load_manifest(models)
    for name in fetch_models.WEIGHTS:
        p = resolve_weight(name, models, manifest)   # verifies sha256 against the file on disk
        assert p.name == f"{name}.pt"


def test_no_api_key_required(tmp_path, monkeypatch):
    # Explicitly: with the key unset, main()'s default path (via fetch_all) succeeds. We swap the
    # module default downloader so main() uses the fake, then point MODELS at the tmp dir.
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    models = tmp_path / "models"
    monkeypatch.setattr(fetch_models, "MODELS", models)
    monkeypatch.setattr(fetch_models, "_download_via_gdown", _fake_downloader)
    # SigLIP pre-fetch needs transformers + network (absent in the CPU test image) — stub it out;
    # the real call is exercised at setup in the cpu-run/gpu image, not here.
    monkeypatch.setattr(fetch_models, "_prefetch_team_classifier", lambda *a, **k: "stub")

    fetch_models.main()   # must not raise / must not require the key

    assert (models / "MANIFEST.json").exists()
    assert len(json.loads((models / "MANIFEST.json").read_text())["weights"]) == 3
