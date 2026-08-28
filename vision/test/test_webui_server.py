# vision/test/test_webui_server.py
#
# HTTP-level tests for the web UI's SERVER half (audit V-1). The existing test_webui.py covers the
# privacy gate and the job model as pure functions; nothing covered the listener itself, which is
# where all three V-1 defects lived:
#
#   1. bound on 0.0.0.0 with no authentication of any kind, on a box whose whole point is that it
#      holds footage;
#   2. a thread per POST with no bound — N browser tabs (or one impatient double-click) = N
#      concurrent yt-dlp downloads and N concurrent inference runs on one CPU, each slowing the
#      others until none finish;
#   3. `/out/<id>/<file>` handing back ANY file in the job directory — including `clip.<ext>`, the
#      raw downloaded source, which the UI never links and the ledger never accounted for.
#
# These drive the real handler over a real socket (ephemeral port, temp out-root, a fake job runner),
# so they test the wiring rather than a re-implementation of it.

import json
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from webui import server as srv

GOOD = {"attest": True, "attest_kind": "public_adult",
        "url": "https://youtu.be/abc123", "level": "v1", "seconds": 30}


class _Stack:
    def __init__(self, httpd, gate):
        self.httpd, self.gate = httpd, gate
        self.base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def post(self, body):
        req = urllib.request.Request(f"{self.base}/api/jobs", method="POST",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def get(self, path):
        try:
            with urllib.request.urlopen(f"{self.base}{path}", timeout=5) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()


@pytest.fixture
def stack(tmp_path, monkeypatch):
    """A live server on an ephemeral port whose jobs block until the test releases them."""
    monkeypatch.setattr(srv, "OUT_ROOT", tmp_path / "out")
    monkeypatch.setattr(srv, "LEDGER", tmp_path / "var" / "attestations.jsonl")
    monkeypatch.setattr(srv, "MAX_JOBS", 1)
    (tmp_path / "out").mkdir()

    gate = threading.Event()
    started = threading.Semaphore(0)

    def fake_run_job(job, **_kw):
        started.release()
        gate.wait(timeout=10)
        job["state"], job["pct"] = "done", 100
        return job

    monkeypatch.setattr(srv, "run_job", fake_run_job)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    s = _Stack(httpd, gate)
    s.started = started
    try:
        yield s
    finally:
        gate.set()
        httpd.shutdown()
        httpd.server_close()


# ---- 2. one job at a time ------------------------------------------------------------------

def test_second_concurrent_post_is_refused_with_429(stack):
    code, body = stack.post(dict(GOOD))
    assert code == 202 and "id" in body
    assert stack.started.acquire(timeout=5), "the first job never started"

    code2, body2 = stack.post(dict(GOOD))
    assert code2 == 429, f"a second concurrent job was accepted ({code2})"
    assert body2.get("error"), "a 429 must say why, in the UI's language"
    assert "id" not in body2


def test_the_slot_is_released_when_the_job_finishes(stack):
    assert stack.post(dict(GOOD))[0] == 202
    assert stack.started.acquire(timeout=5)
    assert stack.post(dict(GOOD))[0] == 429

    stack.gate.set()                       # let the first job complete
    deadline = time.time() + 5
    while time.time() < deadline:
        code, _ = stack.post(dict(GOOD))
        if code == 202:
            break
        time.sleep(0.05)
    else:
        pytest.fail("the concurrency slot was never released")


def test_a_refused_job_is_not_written_to_the_attestation_ledger(stack):
    """The ledger is the record of what was PROCESSED. A 429 processes nothing, so a row for it
    would overstate what the tool did with that link."""
    assert stack.post(dict(GOOD))[0] == 202
    assert stack.started.acquire(timeout=5)
    assert stack.post(dict(GOOD))[0] == 429
    rows = [l for l in srv.LEDGER.read_text().splitlines() if l.strip()]
    assert len(rows) == 1


# ---- 3. artifact allow-list ----------------------------------------------------------------

def test_the_raw_source_clip_is_never_served(stack):
    job = (srv.OUT_ROOT / "job1")
    job.mkdir(parents=True)
    (job / "clip.mp4").write_bytes(b"raw source footage")
    (job / "annotated.mp4").write_bytes(b"derived artifact")

    code, _ = stack.get("/out/job1/annotated.mp4")
    assert code == 200, "the produced artifact must still be served"

    for name in ("clip.mp4", "clip.webm", "clip.mkv"):
        (job / name).write_bytes(b"raw source footage")
        code, _ = stack.get(f"/out/job1/{name}")
        assert code == 403, f"{name} (the raw downloaded source) was served with {code}"


def test_only_the_named_artifacts_are_reachable(stack):
    job = (srv.OUT_ROOT / "job2")
    job.mkdir(parents=True)
    for name in ("annotated.mp4", "radar.mp4", "stats.json", "summary.txt"):
        (job / name).write_bytes(b"x")
    for name in ("annotated.mp4", "radar.mp4", "stats.json", "summary.txt"):
        assert stack.get(f"/out/job2/{name}")[0] == 200, name
    # anything else in the same directory — logs, intermediates, a stray copy — stays private
    for name in ("debug.log", "frames.npy", "notes.txt", "clip.mp4"):
        (job / name).write_bytes(b"x")
        assert stack.get(f"/out/job2/{name}")[0] == 403, name


def test_path_traversal_is_still_blocked(stack):
    assert stack.get("/out/job2/..%2F..%2Fetc%2Fpasswd")[0] in (403, 404)


# ---- 1. the listener is loopback-only ------------------------------------------------------

def test_default_bind_is_loopback():
    assert srv.BIND == "127.0.0.1", (
        "the web UI has no authentication of any kind and holds footage — it must not listen on "
        "every interface by default")


def test_make_httpd_binds_the_configured_address(monkeypatch):
    monkeypatch.setattr(srv, "PORT", 0)
    httpd = srv.make_httpd()
    try:
        assert httpd.server_address[0] == "127.0.0.1"
    finally:
        httpd.server_close()
