"""Job model + command construction + the privacy gate. Pure/stdlib + subprocess — no torch,
no yt-dlp import (both are shelled out), so this module imports cleanly in the CPU test image.

A "job" is a plain dict (thread-safe access is the server's concern). The heavy work is two
subprocess stages: (1) yt-dlp download, (2) the footballcv pipeline. `run` is injectable so
tests drive the whole orchestration with a fake that never touches the network or a GPU.
"""
from __future__ import annotations
import os
import re
import glob
import subprocess

# --- limits / vocab -------------------------------------------------------------------------
MAX_SECONDS = 600                      # cap the downloaded section (a clip, not a whole match)
DEFAULT_SECONDS = 60
LOG_CAP = 400                          # keep only the last N log lines per job

# v1 = players + teams + annotated video. It needs NO homography/calibration, so it runs fully
# automatically from a link. v2 (ball+radar) / v3 (analytics) need a pitch calibration step,
# so they are NOT offered by the auto flow yet (see the UI note).
SUPPORTED_LEVELS = {"v1"}

# ADR-0023 §2 is unambiguous: NO YOUTH FOOTAGE IN ANY PHASE. The real-youth gate is deferred to a future
# ADR requiring a DPIA, verified parental consent and a documented lawful basis (§14).
#
# This set used to carry a second, youth-with-parental-consent kind, offered as a dropdown in the UI —
# and the string had ZERO downstream effect. It was written to the ledger and never read again: download,
# decode, detect, annotate, write and serve all behaved identically, and nothing captured consent evidence,
# a controller, a lawful basis or a retention date. So it could not even discharge GDPR Art. 7(1)
# demonstrability; it was a checkbox that unlocked processing of children's faces and recorded a word about
# it (audit §4.3). Authorised by no ADR, so it is gone — and test_webui.py asserts the whole vocabulary
# stays a single value, so it cannot come back by accident. If youth footage is ever genuinely wanted it
# returns through the §14 ADR, not through this constant.
ATTEST_KINDS = {"public_adult"}

# youtube.com/watch, /shorts/, /live/, youtu.be/, m.youtube.com — nothing else.
_YT_RE = re.compile(
    r"^https?://(?:www\.|m\.)?(?:youtube\.com/(?:watch\?|shorts/|live/)|youtu\.be/)\S+$", re.I)


def validate_youtube_url(url: str) -> bool:
    return bool(_YT_RE.match((url or "").strip()))


def validate_job_request(body: dict) -> tuple[bool, str]:
    """The PRIVACY GATE + input validation, enforced server-side. Returns (ok, error_message).
    Refuses unless the caller explicitly attests the footage is allowed (ADR-0023)."""
    if not body.get("attest"):
        return False, "Morate potvrditi da je snimak javni (odrasli/profi) pre obrade."
    if body.get("attest_kind") not in ATTEST_KINDS:
        # Names the refusal instead of the old generic "Nepoznata vrsta potvrde", so a caller sending the
        # retired youth kind (an old client, a saved curl) learns WHY it is refused rather than assuming
        # a typo and retrying.
        return False, ("Ovaj alat obrađuje samo javne snimke odraslih/profi utakmica. Snimci dece se "
                       "ne obrađuju — ni uz saglasnost roditelja (ADR-0023).")
    url = (body.get("url") or "").strip()
    if not validate_youtube_url(url):
        return False, "Unesite ispravan YouTube link (youtube.com/watch…, youtu.be/…, /shorts/…)."
    level = body.get("level", "v1")
    if level not in SUPPORTED_LEVELS:
        return False, ("Ta vrsta obrade još nije podržana automatski — lopta/radar/statistika "
                       "traže kalibraciju terena (sledeći korak).")
    secs = body.get("seconds", DEFAULT_SECONDS)
    if not isinstance(secs, (int, float)) or secs <= 0 or secs > MAX_SECONDS:
        return False, f"Trajanje mora biti između 1 i {MAX_SECONDS} sekundi."
    return True, ""


def build_download_cmd(url: str, out_dir: str, seconds: int) -> list[str]:
    """yt-dlp, capped to the first `seconds` (a short clip — faster + lighter). Prefers an mp4
    ≤720p so CPU inference stays sane. Output goes to <out_dir>/clip.<ext>."""
    return [
        "yt-dlp", "--no-playlist", "--no-warnings", "--no-progress",
        "-f", "bv*[height<=720]+ba/b[height<=720]/b",
        "--merge-output-format", "mp4",
        "--download-sections", f"*0-{int(seconds)}",
        "--force-keyframes-at-cuts",
        "-o", os.path.join(out_dir, "clip.%(ext)s"),
        url,
    ]


def build_pipeline_cmd(input_path: str, out_dir: str, level: str, device: str,
                       sample_fps: float, imgsz: int) -> list[str]:
    """`python -m footballcv.pipeline …` for the chosen level. v1 needs no calibration."""
    cmd = ["python", "-m", "footballcv.pipeline",
           "--input", input_path, "--device", device,
           "--sample-fps", str(sample_fps), "--imgsz", str(imgsz),
           "--out", out_dir if out_dir.endswith(os.sep) else out_dir + os.sep]
    # v2/v3 flags (--ball/--radar/--stats) intentionally NOT added: they need a calibration.yaml.
    return cmd


def find_clip(out_dir: str) -> str | None:
    """The downloaded clip path (yt-dlp may pick the container) — first clip.* in out_dir."""
    hits = sorted(glob.glob(os.path.join(out_dir, "clip.*")))
    return hits[0] if hits else None


def collect_outputs(out_dir: str) -> dict:
    """Map the pipeline artifacts that actually exist to web paths (served under /out/<id>/)."""
    base = os.path.basename(out_dir.rstrip(os.sep))
    out = {}
    for name in ("annotated.mp4", "radar.mp4", "stats.json", "summary.txt"):
        if os.path.exists(os.path.join(out_dir, name)):
            out[name] = f"/out/{base}/{name}"
    return out


def _log(job: dict, line: str) -> None:
    if not line:
        return
    job["log"].append(line)
    if len(job["log"]) > LOG_CAP:
        del job["log"][: len(job["log"]) - LOG_CAP]


def _fail(job: dict, msg: str) -> dict:
    job["state"] = "error"
    job["stage"] = msg
    job["error"] = msg
    job["pct"] = 100
    return job


def _default_run(cmd: list[str], on_line) -> int:
    """Run a subprocess, streaming combined stdout/stderr line-by-line into the job log."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    assert proc.stdout is not None
    for line in proc.stdout:
        on_line(line.rstrip())
    proc.wait()
    return int(proc.returncode or 0)


def run_job(job: dict, *, run=_default_run, out_root: str = "out") -> dict:
    """Orchestrate: download → pipeline → collect outputs, mutating `job` in place so the
    server can report progress by polling it. `run(cmd, on_line) -> returncode` is injectable."""
    out_dir = os.path.join(out_root, job["id"])
    os.makedirs(out_dir, exist_ok=True)
    on_line = lambda l: _log(job, l)  # noqa: E731
    try:
        job["state"], job["stage"], job["pct"] = "downloading", "Skidanje snimka (yt-dlp)…", 5
        if run(build_download_cmd(job["url"], out_dir, job["seconds"]), on_line) != 0:
            return _fail(job, "Skidanje snimka nije uspelo (yt-dlp). Proveri link / dostupnost.")
        clip = find_clip(out_dir)
        if not clip:
            return _fail(job, "Snimak nije pronađen posle skidanja.")

        job["state"], job["stage"], job["pct"] = "processing", \
            "Obrada: detekcija + praćenje + podela na timove…", 40
        if run(build_pipeline_cmd(clip, out_dir, job["level"], job["device"],
                                  job["sample_fps"], job["imgsz"]), on_line) != 0:
            return _fail(job, "Obrada nije uspela (pipeline). Vidi log ispod.")

        job["outputs"] = collect_outputs(out_dir)
        if not job["outputs"]:
            return _fail(job, "Obrada je prošla ali nije proizvela izlazni snimak.")
        job["state"], job["stage"], job["pct"] = "done", "Gotovo ✓", 100
        return job
    except Exception as exc:  # never leave a job stuck — surface the error honestly
        return _fail(job, f"Greška: {exc}")
