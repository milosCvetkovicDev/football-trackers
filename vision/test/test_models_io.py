import json, pytest
from pathlib import Path
from footballcv.models_io import resolve_weight, sha256_of, IntegrityError

def _make(tmp_path, content=b"fake-weights"):
    models = tmp_path / "models"; models.mkdir()
    w = models / "players.pt"; w.write_bytes(content)
    manifest = {"weights": {"players": {"file": "players.pt", "sha256": sha256_of(w),
                "url": "https://example/x", "model_version": "3zvbc/1", "bytes": len(content)}}}
    (models / "MANIFEST.json").write_text(json.dumps(manifest))
    return models, manifest

def test_resolve_returns_path_when_sha_matches(tmp_path):
    models, manifest = _make(tmp_path)
    p = resolve_weight("players", models, manifest)
    assert p.name == "players.pt"

def test_resolve_refuses_on_sha_mismatch(tmp_path):
    models, manifest = _make(tmp_path)
    (models / "players.pt").write_bytes(b"TAMPERED")     # change file, not manifest
    with pytest.raises(IntegrityError):
        resolve_weight("players", models, manifest)

def test_resolve_refuses_when_missing(tmp_path):
    models, manifest = _make(tmp_path)
    (models / "players.pt").unlink()
    with pytest.raises(IntegrityError):
        resolve_weight("players", models, manifest)
