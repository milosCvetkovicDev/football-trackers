"""Stdlib HTTP server for the footballcv web UI. Zero web-framework deps (matches the repo's
zero-dep ethos). Routes:

    GET  /                      -> index.html (the single-page UI)
    POST /api/jobs              -> validate (PRIVACY GATE) + start a background job; returns {id}
    GET  /api/jobs/<id>         -> job status JSON (polled by the UI)
    GET  /out/<id>/<file>       -> a produced artifact (annotated.mp4, stats.json, …)

Run (in Docker, never on the host):
    docker compose run --rm --service-ports webui      # Mac/CPU (port 8077)
    FT_DEVICE=cuda … on the 3060 (gpu profile)
"""
from __future__ import annotations
import json
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from webui.runner import (run_job, validate_job_request, DEFAULT_SECONDS)

HERE = Path(__file__).resolve().parent
OUT_ROOT = Path(os.environ.get("FT_OUT_ROOT", "out"))
LEDGER = OUT_ROOT / "_attestations.jsonl"     # append-only privacy attestation log (gitignored out/)
PORT = int(os.environ.get("FT_WEBUI_PORT", "8077"))
DEVICE = os.environ.get("FT_DEVICE", "cpu")   # set per compose service (cpu / cuda)

# On CPU keep it cheap (a smoke-grade run); on a real GPU go fuller.
SAMPLE_FPS = float(os.environ.get("FT_SAMPLE_FPS", "5" if DEVICE == "cuda" else "2"))
IMGSZ = int(os.environ.get("FT_IMGSZ", "1280" if DEVICE == "cuda" else "640"))

_JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()
_SAFE = re.compile(r"^[A-Za-z0-9._-]+$")       # path-traversal guard for /out/<id>/<file>


def _new_job(body: dict) -> dict:
    return {
        "id": uuid.uuid4().hex[:12],
        "url": (body.get("url") or "").strip(),
        "level": body.get("level", "v1"),
        "seconds": int(body.get("seconds", DEFAULT_SECONDS)),
        "device": DEVICE, "sample_fps": SAMPLE_FPS, "imgsz": IMGSZ,
        "attest_kind": body.get("attest_kind"),
        "state": "queued", "stage": "U redu…", "pct": 0,
        "log": [], "outputs": {}, "error": None, "created": time.time(),
    }


def _record_attestation(job: dict) -> None:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "job": job["id"],
           "url": job["url"], "attest_kind": job["attest_kind"], "level": job["level"]}
    with LEDGER.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _public_view(job: dict) -> dict:
    """Job state for the UI (drop nothing sensitive; the log is already public-safe text)."""
    return {k: job[k] for k in
            ("id", "state", "stage", "pct", "outputs", "error", "url", "level")} | {
            "log": job["log"][-40:]}


class Handler(BaseHTTPRequestHandler):
    server_version = "footballcv-webui"

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def log_message(self, *_args):       # quiet default logging
        pass

    # ---- GET ----
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            try:
                self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, b"index.html missing", "text/plain")
            return
        m = re.match(r"^/api/jobs/([A-Za-z0-9]+)$", path)
        if m:
            with _LOCK:
                job = _JOBS.get(m.group(1))
            return self._json(200, _public_view(job)) if job else self._json(404, {"error": "no such job"})
        m = re.match(r"^/out/([^/]+)/([^/]+)$", path)
        if m:
            return self._serve_out(m.group(1), m.group(2))
        self._send(404, b"not found", "text/plain")

    def _serve_out(self, job_id: str, fname: str):
        if not (_SAFE.match(job_id) and _SAFE.match(fname)):     # block path traversal
            return self._send(403, b"bad path", "text/plain")
        fp = (OUT_ROOT / job_id / fname).resolve()
        try:
            fp.relative_to(OUT_ROOT.resolve())                   # must stay under out/
        except ValueError:
            return self._send(403, b"bad path", "text/plain")
        if not fp.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = {".mp4": "video/mp4", ".json": "application/json",
                 ".txt": "text/plain; charset=utf-8"}.get(fp.suffix, "application/octet-stream")
        self._send(200, fp.read_bytes(), ctype)

    # ---- POST ----
    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/jobs":
            return self._send(404, b"not found", "text/plain")
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "neispravan zahtev"})

        ok, err = validate_job_request(body)                     # THE PRIVACY GATE (server-side)
        if not ok:
            return self._json(400, {"error": err})

        job = _new_job(body)
        _record_attestation(job)                                 # log the attestation BEFORE work
        with _LOCK:
            _JOBS[job["id"]] = job
        threading.Thread(target=run_job, args=(job,),
                         kwargs={"out_root": str(OUT_ROOT)}, daemon=True).start()
        self._json(202, {"id": job["id"]})


def main():
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"footballcv web UI on http://localhost:{PORT}  (device={DEVICE}, "
          f"sample_fps={SAMPLE_FPS}, imgsz={IMGSZ})")
    print("PRIVACY: every job requires an attestation (public-adult OR consented-youth); "
          f"logged to {LEDGER}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
