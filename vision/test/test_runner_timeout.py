# vision/test/test_runner_timeout.py
#
# Subprocess timeouts (audit §6 "Vision": *no subprocess timeouts*).
#
# BOTH STAGES CAN HANG WITHOUT EXITING. yt-dlp against a stalled CDN, or one that hits an
# interactive prompt, blocks on read forever; CPU inference on a longer clip than the operator meant
# to give it runs for hours. `_default_run` iterated `proc.stdout` and then called `proc.wait()`,
# neither of which has a deadline, so the job thread parked permanently in "Skidanje snimka…" — and
# with the concurrency slot this phase adds, a permanently-parked job would also mean the web UI
# never accepts another one. A hang has to become a failure with a reason.
#
# The kill has to reach the whole process GROUP: yt-dlp shells out to ffmpeg, and killing only the
# parent leaves the encode running and the pipe open, so the reader would keep blocking on a
# process that has already been "killed".

import os
import sys
import time

from webui.runner import _default_run, run_job


def _job(**over):
    j = {"id": "job1", "url": "https://youtu.be/x", "level": "v1", "seconds": 20,
         "device": "cpu", "sample_fps": 2, "imgsz": 640, "state": "queued", "stage": "",
         "pct": 0, "log": [], "outputs": {}, "error": None}
    j.update(over)
    return j


def test_a_hung_command_is_killed_and_reported_as_a_failure():
    lines = []
    t0 = time.monotonic()
    rc = _default_run([sys.executable, "-c", "import time; time.sleep(120)"],
                      lines.append, timeout_s=1.0)
    elapsed = time.monotonic() - t0

    assert rc != 0, "a timed-out command reported success"
    assert elapsed < 20, f"the timeout did not fire (took {elapsed:.1f}s)"
    assert any("timeout" in l.lower() for l in lines), (
        f"the job log must say it was a timeout, got: {lines!r}")


def test_the_whole_process_group_is_killed_not_just_the_parent(tmp_path):
    """The parent spawns a child that outlives it and writes to a file. After the timeout, the
    child must be gone — otherwise a killed yt-dlp leaves its ffmpeg running and the pipe open."""
    marker = tmp_path / "child-still-running"
    child = (f"import subprocess,sys,time;"
             f"subprocess.Popen([sys.executable,'-c',"
             f"\"import time,pathlib;time.sleep(6);pathlib.Path(r'{marker}').write_text('alive')\"]);"
             f"time.sleep(120)")
    rc = _default_run([sys.executable, "-c", child], lambda _l: None, timeout_s=1.0)
    assert rc != 0
    time.sleep(8)
    assert not marker.exists(), "a grandchild process survived the timeout kill"


def test_a_command_that_finishes_in_time_is_unaffected():
    lines = []
    rc = _default_run([sys.executable, "-c", "print('hello')"], lines.append, timeout_s=30)
    assert rc == 0
    assert any("hello" in l for l in lines)


def test_run_job_surfaces_a_download_timeout_to_the_user(tmp_path, monkeypatch):
    def hanging(cmd, on_line, timeout_s=None):
        on_line("timeout: the command exceeded 1s and was killed")
        return 124                                   # the conventional timeout status
    job = _job()
    run_job(job, run=hanging, out_root=str(tmp_path))
    assert job["state"] == "error"
    assert job["error"], "a timed-out job must carry an error the UI can show"


def test_timeouts_are_configurable_and_have_a_bounded_default():
    from webui import runner
    assert runner.DOWNLOAD_TIMEOUT_S > 0
    assert runner.PIPELINE_TIMEOUT_S > 0
    # A "timeout" longer than a working day is not a timeout.
    assert runner.DOWNLOAD_TIMEOUT_S <= 3600
    assert runner.PIPELINE_TIMEOUT_S <= 6 * 3600


def test_run_job_passes_a_timeout_to_every_stage(tmp_path):
    seen = []

    def recording(cmd, on_line, timeout_s=None):
        seen.append((cmd[0], timeout_s))
        if cmd[0] == "yt-dlp":
            out_dir = os.path.dirname(cmd[cmd.index("-o") + 1])
            (open(os.path.join(out_dir, "clip.mp4"), "wb")).write(b"x")
        else:
            out_dir = cmd[cmd.index("--out") + 1].rstrip(os.sep)
            (open(os.path.join(out_dir, "annotated.mp4"), "wb")).write(b"x")
        return 0

    job = _job()
    run_job(job, run=recording, out_root=str(tmp_path))
    assert job["state"] == "done"
    assert [s[0] for s in seen] == ["yt-dlp", "python"]
    assert all(t is not None and t > 0 for _c, t in seen), f"a stage ran with no deadline: {seen}"
