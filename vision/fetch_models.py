# vision/fetch_models.py  — SETUP ONLY. The single network-touching module (ADR §5).
#
# Run this ONCE inside the cpu-run / gpu Docker image (which ship `gdown`), not on the host:
#
#     docker compose --profile gpu run --rm run python fetch_models.py
#
# Default path = public Google-Drive weights via `gdown`. NO API key is required for the v1/v2
# weights — the three `.pt` files come from Roboflow `sports`' own PUBLIC Drive links (the same
# ids its `examples/soccer/setup.sh` uses). A free Roboflow account CANNOT download the raw `.pt`
# weights (paid Core/Enterprise only), so `ROBOFLOW_API_KEY` is an OPTIONAL fallback, used only
# when a Drive id is missing AND the key is set.
#
# Imports of `gdown` / `roboflow` are LAZY (inside the download functions) on purpose: nothing
# else may import this module (the pipeline asserts it), and it must import cleanly in the
# torch/gdown-free CPU test image.
import json, os, time
from pathlib import Path
from footballcv.models_io import sha256_of

MODELS = Path(__file__).resolve().parent / "models"

# Public Roboflow `sports` recipe weights — Google-Drive file ids, no API key needed.
# Source of truth: github.com/roboflow/sports examples/soccer/setup.sh (verified against
# docs/vision/v1-acceptance-runbook.md §3, 2026-06).
WEIGHTS = {
    "players": {"drive_id": "17PXFNlx-jI7VjVo_vQnB1sONjRyvoB-q",   # football-player-detection.pt
                "model_version": "football-players-detection-3zvbc/<v>"},
    # ball + field models are fetched here too but only USED from v2/v4.
    "ball":    {"drive_id": "1isw4wx-MK9h9LMr36VvIWlJD6ppUvw7V",   # football-ball-detection.pt
                "model_version": "football-ball-detection-rejhg/<v>"},
    "field":   {"drive_id": "1Ma5Kt86tgpdjCTKfum79YMgNnSjcoOyf",   # football-pitch-detection.pt
                "model_version": "football-field-detection-f07vi/<v>"},
}

# The team-classifier embedder (footballcv.teams.SiglipEmbedder default) is a HuggingFace model,
# NOT a Roboflow .pt — so it is pre-fetched into the HF cache HERE at setup, while the network is
# reachable. At RUNTIME the pipeline sets HF_HUB_OFFLINE=1 (privacy), so SigLIP MUST already be
# cached locally or the run fails. The Docker images point HF_HOME at the bind-mounted, gitignored
# models/hf so the cache persists across container runs.
SIGLIP_MODEL = "google/siglip-base-patch16-224"


def _prefetch_team_classifier(model_name: str = SIGLIP_MODEL) -> str:
    """SETUP-ONLY network call: download the SigLIP team-classifier into the HF cache so the
    OFFLINE runtime finds it locally. `transformers` is lazy-imported (absent from the CPU test
    image; present in the cpu-run/gpu images)."""
    from transformers import AutoModel, AutoImageProcessor   # lazy: not in the CPU test image
    AutoImageProcessor.from_pretrained(model_name)            # image-only (matches SiglipEmbedder)
    AutoModel.from_pretrained(model_name)
    return model_name


def _download_via_gdown(file_id: str, dest: Path) -> str:
    """SETUP-ONLY network call (default path). Lazily import `gdown` and download the public
    Drive weight to `dest`. Returns the resolved download URL for the manifest."""
    import gdown  # lazy: not present in the CPU test image
    url = f"https://drive.google.com/uc?id={file_id}"
    gdown.download(url, str(dest), quiet=False)
    if not dest.exists() or dest.stat().st_size < 1_000_000:
        raise RuntimeError(f"gdown download failed or too small: {dest}")
    return url


def _download_via_roboflow_sdk(model_version: str, dest: Path) -> str:
    """SETUP-ONLY network call (OPTIONAL fallback, only when ROBOFLOW_API_KEY is set AND no Drive
    id exists for a model). Lazily import `roboflow` and download the weight to `dest`. Note: a
    free Roboflow account cannot download raw `.pt` weights — this needs a paid plan."""
    import roboflow  # lazy: not present in the CPU test image
    key = os.environ.get("ROBOFLOW_API_KEY")
    if not key:
        raise RuntimeError(f"no Drive id for {model_version} and ROBOFLOW_API_KEY is unset")
    raise NotImplementedError(
        "Roboflow-SDK fallback is unused for v1/v2 (free accounts cannot download raw .pt "
        "weights); all current weights have a public Drive id. Implement against the current "
        "roboflow SDK only if a future weight has no public Drive id.")


def fetch_all(models_dir: Path = None, downloader=None) -> dict:
    """Download every weight in WEIGHTS into `models_dir` and write `MANIFEST.json`.

    `downloader(file_id_or_version, dest) -> url` is an injectable seam: the default downloads
    the public Drive id via gdown; tests pass a fake that writes a tiny blob (so the test never
    imports gdown and never touches the network). The manifest structure matches what
    `footballcv.models_io.load_manifest` / `resolve_weight` expect: each entry has `file`,
    `sha256`, and `model_version`.

    Defaults resolve module-level names at call time (so a test can monkeypatch MODELS /
    _download_via_gdown and have main() pick them up).
    """
    if models_dir is None:
        models_dir = MODELS
    if downloader is None:
        downloader = _download_via_gdown
    models_dir = Path(models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"weights": {}}
    for name, meta in WEIGHTS.items():
        dest = models_dir / f"{name}.pt"
        drive_id = meta.get("drive_id")
        if drive_id:
            url = downloader(drive_id, dest)
        else:
            # No public Drive id — fall back to the (optional) Roboflow SDK path.
            url = _download_via_roboflow_sdk(meta["model_version"], dest)
        manifest["weights"][name] = {
            "file": dest.name,
            "drive_id": drive_id,
            "url": url,
            "model_version": meta["model_version"],
            "sha256": sha256_of(dest),
            "bytes": dest.stat().st_size,
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    (models_dir / "MANIFEST.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main():
    manifest = fetch_all()
    print(f"wrote {MODELS/'MANIFEST.json'} with {len(manifest['weights'])} weights")
    name = _prefetch_team_classifier()
    print(f"pre-fetched team-classifier '{name}' into the HF cache "
          f"(HF_HOME={os.environ.get('HF_HOME', '~/.cache/huggingface')})")


if __name__ == "__main__":
    main()
