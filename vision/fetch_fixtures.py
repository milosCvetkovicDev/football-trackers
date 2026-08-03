# vision/fetch_fixtures.py — SETUP ONLY. Pulls ONE URL+SHA256-pinned PUBLIC adult/pro clip
# into samples/ for the few tests that need real video (§11). Mirrors fetch_models integrity.
import sys, urllib.request
from pathlib import Path
from footballcv.models_io import sha256_of

SAMPLES = Path(__file__).resolve().parent / "samples"
# Pin one public adult/pro clip once it is chosen (Task 12). Default-deny: only add a clip
# whose competition is positively identified as adult/senior; record it in samples.manifest.jsonl.
FIXTURE = {"url": None, "sha256": None, "name": "fixture.mp4"}

def main():
    if not FIXTURE["url"]:
        print("no fixture pinned yet — set FIXTURE['url']/['sha256'] when a public clip is chosen")
        return 0
    SAMPLES.mkdir(exist_ok=True)
    dest = SAMPLES / FIXTURE["name"]
    urllib.request.urlretrieve(FIXTURE["url"], dest)
    got = sha256_of(dest)
    if got != FIXTURE["sha256"]:
        dest.unlink(missing_ok=True)
        print(f"SHA256 mismatch: {got} != {FIXTURE['sha256']}"); return 1
    print(f"fetched {dest} (sha256 ok)"); return 0

if __name__ == "__main__":
    sys.exit(main())
