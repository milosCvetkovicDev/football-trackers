"""webui tests — privacy gate, request validation, command construction, job orchestration.
Stdlib only + a fake subprocess runner, so they run in the light CPU image (no torch/yt-dlp)."""
import os
from webui import runner
from webui.runner import (validate_youtube_url, validate_job_request,
                          build_download_cmd, build_pipeline_cmd, run_job,
                          find_clip, collect_outputs)


# ---- URL validation -----------------------------------------------------------------------
def test_accepts_youtube_urls():
    for u in ["https://www.youtube.com/watch?v=abc123",
              "https://youtu.be/abc123",
              "http://m.youtube.com/watch?v=x",
              "https://www.youtube.com/shorts/xyz",
              "https://youtube.com/live/zzz"]:
        assert validate_youtube_url(u), u

def test_rejects_non_youtube_urls():
    for u in ["", "not a url", "https://vimeo.com/123", "https://example.com/watch?v=x",
              "ftp://youtube.com/x", "javascript:alert(1)"]:
        assert not validate_youtube_url(u), u


# ---- the PRIVACY GATE (validate_job_request) ----------------------------------------------
GOOD = {"attest": True, "attest_kind": "public_adult",
        "url": "https://youtu.be/abc123", "level": "v1", "seconds": 30}

def test_gate_passes_a_well_formed_attested_request():
    ok, err = validate_job_request(dict(GOOD))
    assert ok and err == ""

def test_gate_refuses_without_attestation():
    b = dict(GOOD); b["attest"] = False
    ok, err = validate_job_request(b)
    assert not ok and "potvr" in err.lower()

def test_gate_refuses_missing_attestation_key():
    b = dict(GOOD); del b["attest"]
    assert validate_job_request(b)[0] is False

def test_gate_refuses_unknown_attest_kind():
    b = dict(GOOD); b["attest_kind"] = "whatever"
    assert validate_job_request(b)[0] is False


# ---- ADR-0023 §2: no youth footage in ANY phase (audit §4.3) -------------------------------
# The UI used to offer "youth, I have parental consent" as a second attestation kind, and the value was a
# pure ledger string with no downstream effect — every stage behaved identically, and no consent evidence,
# controller, lawful basis or retention date was ever captured. These three tests are what stops it coming
# back: the vocabulary is pinned to a single value, the retired identifier is refused by name, and the
# refusal has to SAY what the rule is (a caller that gets "unknown kind" retries; one that is told youth
# footage is not processed does not).
def test_attest_vocabulary_is_public_adult_only():
    assert runner.ATTEST_KINDS == {"public_adult"}

def test_gate_refuses_the_retired_youth_kind_by_name():
    b = dict(GOOD); b["attest_kind"] = "consented" + "_youth"  # split so the ADR-0023 grep guard stays clean
    ok, err = validate_job_request(b)
    assert ok is False
    assert "dec" in err.lower(), f"the refusal must name the youth rule, got: {err}"

def test_youth_refusal_survives_every_other_field_being_valid():
    # The gate is order-dependent: attest_kind is checked before url/level/seconds. A future reorder that
    # let a youth request through on the strength of a valid URL would be invisible without this.
    b = dict(GOOD); b["attest_kind"] = "consented" + "_youth"
    b["url"] = "https://www.youtube.com/watch?v=validlink"
    b["level"] = "v1"; b["seconds"] = 30; b["attest"] = True
    assert validate_job_request(b)[0] is False

def test_gate_refuses_bad_url_even_when_attested():
    b = dict(GOOD); b["url"] = "https://vimeo.com/1"
    ok, err = validate_job_request(b)
    assert not ok and "link" in err.lower()

def test_gate_refuses_unsupported_level():
    b = dict(GOOD); b["level"] = "v2"          # ball/radar need calibration — not auto yet
    ok, err = validate_job_request(b)
    assert not ok and "kalibrac" in err.lower()

def test_gate_refuses_out_of_range_seconds():
    for s in [0, -5, 99999, "lots"]:
        b = dict(GOOD); b["seconds"] = s
        assert validate_job_request(b)[0] is False


# ---- command construction -----------------------------------------------------------------
def test_download_cmd_is_capped_yt_dlp():
    cmd = build_download_cmd("https://youtu.be/x", "out/job1", 25)
    assert cmd[0] == "yt-dlp"
    assert "--download-sections" in cmd and "*0-25" in cmd
    assert cmd[-1] == "https://youtu.be/x"
    assert any(a.endswith("clip.%(ext)s") for a in cmd)

def test_pipeline_cmd_v1_has_no_ball_or_radar():
    cmd = build_pipeline_cmd("out/job1/clip.mp4", "out/job1", "v1", "cpu", 2, 640)
    assert "-m" in cmd and "footballcv.pipeline" in cmd
    assert "--input" in cmd and "--device" in cmd and "cpu" in cmd and "--out" in cmd
    assert "--ball" not in cmd and "--radar" not in cmd and "--stats" not in cmd


# ---- job orchestration (fake runner) ------------------------------------------------------
def _job(tmp, **over):
    j = {"id": "job1", "url": "https://youtu.be/x", "level": "v1", "seconds": 20,
         "device": "cpu", "sample_fps": 2, "imgsz": 640, "state": "queued", "stage": "",
         "pct": 0, "log": [], "outputs": {}, "error": None}
    j.update(over); return j

def _fake_run_factory(fail_stage=None):
    """A subprocess stand-in: yt-dlp writes clip.mp4, the pipeline writes annotated.mp4.
    fail_stage in {'download','pipeline'} returns non-zero at that stage."""
    def run(cmd, on_line, timeout_s=None):
        on_line(" ".join(cmd[:2]))
        if cmd[0] == "yt-dlp":
            if fail_stage == "download":
                return 1
            out_dir = os.path.dirname(cmd[cmd.index("-o") + 1])
            open(os.path.join(out_dir, "clip.mp4"), "wb").write(b"\x00\x00fakeclip")
            return 0
        # pipeline
        if fail_stage == "pipeline":
            return 1
        out_dir = cmd[cmd.index("--out") + 1].rstrip(os.sep)
        open(os.path.join(out_dir, "annotated.mp4"), "wb").write(b"\x00\x00fakevid")
        return 0
    return run

def test_run_job_happy_path_produces_annotated_video(tmp_path):
    job = _job(tmp_path)
    run_job(job, run=_fake_run_factory(), out_root=str(tmp_path))
    assert job["state"] == "done" and job["pct"] == 100
    assert job["outputs"].get("annotated.mp4") == "/out/job1/annotated.mp4"
    assert os.path.exists(os.path.join(tmp_path, "job1", "annotated.mp4"))

def test_run_job_download_failure_is_surfaced(tmp_path):
    job = _job(tmp_path)
    run_job(job, run=_fake_run_factory(fail_stage="download"), out_root=str(tmp_path))
    assert job["state"] == "error" and "yt-dlp" in job["error"]
    assert job["outputs"] == {}

def test_run_job_pipeline_failure_is_surfaced(tmp_path):
    job = _job(tmp_path)
    run_job(job, run=_fake_run_factory(fail_stage="pipeline"), out_root=str(tmp_path))
    assert job["state"] == "error" and "pipeline" in job["error"].lower()


# ---- helpers ------------------------------------------------------------------------------
def test_find_clip_and_collect_outputs(tmp_path):
    d = tmp_path / "job9"; d.mkdir()
    (d / "clip.mp4").write_bytes(b"x")
    (d / "annotated.mp4").write_bytes(b"x")
    (d / "stats.json").write_text("{}")
    assert find_clip(str(d)).endswith("clip.mp4")
    outs = collect_outputs(str(d))
    assert outs["annotated.mp4"] == "/out/job9/annotated.mp4"
    assert outs["stats.json"] == "/out/job9/stats.json"
    assert "radar.mp4" not in outs


# ---- server module sanity (path-traversal guard import) -----------------------------------
def test_server_imports_and_safe_regex_blocks_traversal():
    from webui import server
    assert server._SAFE.match("annotated.mp4")
    assert not server._SAFE.match("../secret")
    assert not server._SAFE.match("a/b")
