import shutil, subprocess
from pathlib import Path

VISION = Path(__file__).resolve().parents[1]
REQUIRED_IGNORES = ["models/", "samples/", "out/", "config/calibration.yaml",
                    "*.360", "*.mp4", "*.pt", "*.engine", ".venv/"]

def test_gitignore_exists_and_covers_required_patterns():
    gi = (VISION / ".gitignore").read_text()
    for pat in REQUIRED_IGNORES:
        assert pat in gi, f"missing ignore pattern: {pat}"

def test_committed_manifests_are_NOT_ignored():
    gi = (VISION / ".gitignore").read_text().splitlines()
    # MANIFEST.json and samples.manifest.jsonl must stay committable
    assert not any(line.strip() in ("MANIFEST.json", "samples.manifest.jsonl") for line in gi)

def test_no_video_or_weight_files_tracked_if_under_git():
    # Degrades gracefully when the tree is not under git (current repo state).
    if not shutil.which("git") or not (VISION.parent / ".git").exists():
        return
    tracked = subprocess.run(["git", "ls-files", str(VISION)],
                             capture_output=True, text=True).stdout.split()
    bad = [f for f in tracked if f.endswith((".mp4", ".360", ".pt", ".engine"))]
    assert not bad, f"video/weight files tracked under vision/: {bad}"
