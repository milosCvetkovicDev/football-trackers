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

from webui import retention
from webui.runner import (run_job, validate_job_request, DEFAULT_SECONDS)

HERE = Path(__file__).resolve().parent
OUT_ROOT = Path(os.environ.get("FT_OUT_ROOT", "out"))

# The attestation ledger lives OUTSIDE out/. It used to be `out/_attestations.jsonl`, i.e. inside
# the directory retention.prune_out now empties — the tool would have deleted the only record of
# what it had processed. ADR-0023 §3 keeps the sample manifest out of the pruned tree for the same
# reason; this is the same kind of artifact and gets the same treatment. (audit §6 "Vision".)
LEDGER = Path(os.environ.get("FT_LEDGER_PATH", "var/attestations.jsonl"))

# Loopback by DEFAULT. This server has no authentication of any kind — no login, no token, no
# origin check — and it holds downloaded footage plus every artifact derived from it. `0.0.0.0`
# put all of that on whatever network the machine was attached to, for anyone who could guess a
# 12-hex job id (or simply read the UI). The same argument the audit made about the telemetry
# server's port (§4.1) applies here with fewer excuses, because there is not even an anonymous
# read model to appeal to. An operator who genuinely wants it exposed sets FT_BIND and owns that.
BIND = os.environ.get("FT_BIND", "127.0.0.1")
PORT = int(os.environ.get("FT_WEBUI_PORT", "8077"))
DEVICE = os.environ.get("FT_DEVICE", "cpu")   # set per compose service (cpu / cuda)

# On CPU keep it cheap (a smoke-grade run); on a real GPU go fuller.
SAMPLE_FPS = float(os.environ.get("FT_SAMPLE_FPS", "5" if DEVICE == "cuda" else "2"))
IMGSZ = int(os.environ.get("FT_IMGSZ", "1280" if DEVICE == "cuda" else "640"))

# One job at a time. A thread per POST meant N browser tabs — or one impatient double-click — ran N
# yt-dlp downloads and N inference passes on the same CPU, each slowing the others until none
# finished; there was no queue, no cap and no way for a caller to learn it was queued behind
# anything. A hard refusal is more honest than an unbounded queue here: the caller is a person
# watching a progress bar, and "busy, try again" is actionable where a silent 20-minute wait is not.
MAX_JOBS = int(os.environ.get("FT_MAX_JOBS", "1"))

# Artifacts the UI links, and the ONLY files reachable under /out/<id>/. The previous handler served
# any name in the job directory, which includes `clip.<ext>` — the raw downloaded source. That file
# is the input, not a product: it is the largest thing in the directory, the UI never links it, and
# handing it back turns a local analysis tool into an unauthenticated re-hosting proxy for whatever
# was downloaded. Intermediates and logs are covered by the same allow-list. (audit V-1.)
SERVABLE = ("annotated.mp4", "radar.mp4", "stats.json", "summary.txt")

_JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()
_ACTIVE = 0                                    # jobs running right now, guarded by _LOCK
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
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
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
        if fname not in SERVABLE:
            # Allow-list, not a deny-list: the file that most needed blocking (`clip.<ext>`, the raw
            # downloaded source) has an extension yt-dlp chooses, so there was no name to deny.
            return self._send(403, b"not a served artifact", "text/plain")
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

        # Claim the slot BEFORE the attestation is written. The ledger records what was PROCESSED;
        # a refused request processes nothing, so a row for it would overstate what the tool did
        # with that link — and an attestation log that over-reports is as useless as one that
        # under-reports.
        global _ACTIVE
        with _LOCK:
            if _ACTIVE >= MAX_JOBS:
                return self._json(429, {"error": "Obrada je već u toku — sačekaj da se završi pa "
                                                 "probaj ponovo (jedan snimak u isto vreme)."})
            _ACTIVE += 1

        job = _new_job(body)
        _record_attestation(job)                                 # log the attestation BEFORE work
        with _LOCK:
            _JOBS[job["id"]] = job
        threading.Thread(target=self._run_and_release, args=(job,), daemon=True).start()
        self._json(202, {"id": job["id"]})

    @staticmethod
    def _run_and_release(job: dict) -> None:
        """Run one job and ALWAYS give the slot back.

        The finally is the whole point: a job that raises — and `run_job` calls into subprocess,
        the filesystem and a timeout path — must not leave the counter incremented, or the web UI
        answers 429 forever and the only fix is a restart.
        """
        global _ACTIVE
        try:
            retention.prune_out(OUT_ROOT, ledger=LEDGER)
            run_job(job, out_root=str(OUT_ROOT))
        except Exception as exc:                                 # noqa: BLE001 — never lose the slot
            job["state"], job["error"] = "error", f"Greška: {exc}"
            job["stage"], job["pct"] = job["error"], 100
        finally:
            with _LOCK:
                _ACTIVE -= 1


def make_httpd() -> ThreadingHTTPServer:
    """The listener, separated so a test can assert what it binds without starting a job."""
    return ThreadingHTTPServer((BIND, PORT), Handler)


def main():
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    swept = retention.prune_out(OUT_ROOT, ledger=LEDGER)
    httpd = make_httpd()
    print(f"footballcv web UI on http://{BIND}:{PORT}  (device={DEVICE}, "
          f"sample_fps={SAMPLE_FPS}, imgsz={IMGSZ}, max_jobs={MAX_JOBS})")
    # The banner is the first thing an operator reads, and for months it announced that the tool
    # accepts public-adult footage OR youth footage with parental consent — months after that second
    # kind had been deleted from the gate itself (audit §4.3's grep looked for the underscore
    # spelling and this said it with a hyphen). It is now derived from the vocabulary, not retyped,
    # so it cannot drift again.
    from webui.runner import ATTEST_KINDS
    print(f"PRIVACY: every job requires an attestation ({', '.join(sorted(ATTEST_KINDS))} — "
          f"youth footage is not processed in any phase, ADR-0023 §2); logged to {LEDGER}")
    print(f"RETENTION: out/ is pruned after {retention.DEFAULT_TTL_HOURS} h "
          f"({len(swept)} expired job(s) removed at start)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
