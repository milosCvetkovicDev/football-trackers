import hashlib, json
from pathlib import Path

class IntegrityError(RuntimeError):
    pass

def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def load_manifest(models_dir: Path) -> dict:
    mf = Path(models_dir) / "MANIFEST.json"
    if not mf.exists():
        raise IntegrityError(f"missing manifest: {mf} (run fetch_models.py)")
    return json.loads(mf.read_text())

def resolve_weight(name: str, models_dir: Path, manifest: dict) -> Path:
    entry = manifest.get("weights", {}).get(name)
    if not entry:
        raise IntegrityError(f"'{name}' not in MANIFEST.json")
    path = Path(models_dir) / entry["file"]
    if not path.exists():
        raise IntegrityError(f"weight file absent: {path} (run fetch_models.py)")
    actual = sha256_of(path)
    if actual != entry["sha256"]:
        raise IntegrityError(f"SHA256 mismatch for {name}: {actual} != {entry['sha256']}")
    return path
