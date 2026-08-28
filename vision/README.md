# footballcv — offline camera/CV match analysis

> ## ⚠️ PRIVACY GATE (ADR-0023 §3 — non-negotiable)
> This tool runs on **PUBLIC adult/professional** football footage ONLY. **No youth/children's
> footage** at any phase. Filming a real youth match is a SEPARATE, later gate (DPIA, consent,
> retention) owned by a future ADR — this project inherits but does NOT discharge it. The pipeline
> makes **no run-time network calls**; weights are SHA-pinned in `models/MANIFEST.json`. `models/`,
> `samples/`, `out/`, and `config/calibration.yaml` are gitignored and never enter version control.

## What it is
Offline, post-match CV analysis on recorded PUBLIC football video. Built in phases:
- **v1** — detect + track players, split into 2 anchored teams, draw an annotated video.
- **v2** — detect the **ball** + a self-grading **homography**, project both teams + ball onto a
  top-down **radar** (`radar.mp4`). **NOT IMPLEMENTED** — see below.
- **v3** — **analytics**: possession %, per-player distance/speed (noise-floored lower bounds),
  possession-changes (heuristic, opt-in), team shape → `stats.json` + a one-screen `summary.txt`.
  The analytics themselves are real and tested; the live loop that would feed them is not.

### What v2 and v3 actually do today
`--ball`, `--radar` and `--stats` **exit non-zero** with a message naming what is missing. They used
to exit **0** having done nothing: the live loops were written as a bare `...`, which is a legal
no-op, and each function then returned a well-formed result dict — so a run looked instantaneous and
successful, and the only symptom was an `out/` directory that never gained a `radar.mp4`. The parts
exist and are unit-tested (`PitchProjector`, `BallDetector`, `postprocess_ball_track`,
`write_radar_video`, `build_stats`); nothing joins them into a loop. Joining them is the Task-8
acceptance integration and needs weights, a calibrated clip and a GPU.
v3's analytics can be run directly over a stream you already have:
`run_v3(..., world_states=[...])`.

See [ADR-0023](../docs/decisions/0023-camera-cv-offline-analysis.md) and the plans:
[v1](../docs/vision/2026-06-19-v1-implementation-plan.md) ·
[v2](../docs/vision/2026-06-19-v2-implementation-plan.md) ·
[v3](../docs/vision/2026-06-20-v3-implementation-plan.md).

## Running — EVERYTHING via Docker (nothing on the host)

All commands run in Docker (`docker-compose.yml`). Do **not** run Python/pytest on the host.
From the `vision/` directory:

```bash
docker compose run --rm test       # the full test suite (CPU image; runs on the Mac too)
docker compose run --rm selftest   # pipeline --selftest (offline guards + no-network)
```

The real pipeline runs on the **RTX 3060 desktop** (needs nvidia-container-toolkit), behind the
`gpu` compose profile — never built or started on a machine without an NVIDIA GPU:

```bash
# Weights come via PUBLIC gdown Drive IDs — NO Roboflow API key needed (fetch_models.py).
docker compose --profile gpu run --rm run python fetch_models.py   # one-time weight fetch (in-container)
docker compose --profile gpu run --rm run                          # the real pipeline
```

**On a Mac (no GPU)** you can smoke-test the *real* pipeline on a short clip via the CPU image
(`cpu-run` service — torch-CPU + ultralytics, slow but correct; no `gpu` profile):

```bash
docker compose run --rm cpu-run python fetch_models.py             # one-time weight fetch (gdown)
docker compose run --rm cpu-run python -m footballcv.pipeline \
    --input samples/<clip>.mp4 --device cpu --sample-fps 2 --out out/clip/
```

Full desktop walkthrough: [v1 acceptance runbook](../docs/vision/v1-acceptance-runbook.md).
The host `.venv` (if present from earlier) is no longer used — Docker is the only path.

## Web UI — paste a YouTube link → annotated video
A tiny stdlib server (`webui/`) that runs the pipeline from a browser. Open it on the Mac:
```bash
docker compose up webui            # http://localhost:8077  (CPU; Ctrl-C / `docker compose stop webui` to stop)
docker compose --profile gpu up webui-gpu   # the RTX 3060 (fast)
```
Paste a YouTube link, tick the **privacy attestation**, click *Obradi*. **The gate is enforced
server-side** (`webui/runner.py::validate_job_request`): no job starts without confirming the footage
is **public adult/pro**, which is the only kind accepted — **youth footage is not processed in any
phase** (ADR-0023 §2), with or without a claim of parental consent. The UI used to offer a
youth-with-consent option; it was removed because the value had no downstream effect whatsoever and
captured no consent evidence, controller, lawful basis or retention date, so it could not discharge
GDPR Art. 7(1) — a checkbox that unlocked processing children's faces and wrote a word in a log
(audit §4.3). It returns only through the §14 ADR. Every attestation is logged to
`var/attestations.jsonl` — deliberately OUTSIDE `out/`, because `out/` is now pruned on a TTL and a
tool that deletes its own compliance record is worse than one that keeps none. Only **v1** (players
+ teams + annotated video) runs automatically — v2/v3 need a pitch calibration step. Verified
end-to-end on a public CC adult match (real player boxes, e.g. `#37 T1`); detection on amateur/wide
footage is sparse — the documented "fine-tune for your view" caveat (ADR-0023 §7).

**How the server is bounded** (audit V-1, closed in the production-readiness Phase 7):

| | |
|---|---|
| **Reachability** | loopback only — `127.0.0.1:8077:8077` in compose, `FT_BIND` inside. There is no login, no token and no origin check, so nothing about this server should be on a network. |
| **Concurrency** | one job at a time (`FT_MAX_JOBS`). A second POST while one runs gets **429** and a message, instead of a second yt-dlp and a second inference pass fighting for the same CPU. |
| **Deadlines** | `FT_DOWNLOAD_TIMEOUT_S` (600) and `FT_PIPELINE_TIMEOUT_S` (5400). A hung stage is killed by process GROUP — killing only the child leaves ffmpeg holding the pipe open, and the read never returns. |
| **What is served** | an allow-list: `annotated.mp4`, `radar.mp4`, `stats.json`, `summary.txt`. Notably **not** `clip.<ext>`, the raw downloaded source, which the UI never linked and the handler used to serve to anyone. |
| **Retention** | `out/` job directories are removed after `FT_OUT_TTL_HOURS` (24), swept at start-up and before each job. Three short jobs used to leave 51 MB of footage sitting there indefinitely. |

## Third-party code
`footballcv/vendor/sports/` is **our own code**, not a copy of anything. The plan (ADR §5) was to
vendor Roboflow `sports` (MIT) at a pinned commit and this README described it that way for months —
but what was actually written is ~90 lines implementing the two pieces v2 consumes (`ViewTransformer`,
`SoccerPitchConfiguration`) against that library's public API *shape*. There is therefore no upstream
commit to record, and inventing one to fill the blank would have been the wrong fix. The accurate
claim now lives in `footballcv/vendor/sports/PROVENANCE.json`, which the docs guard reads: set
`copied_code` true there if real upstream source is ever brought in, and the guard will start
requiring the 40-character SHA and a README that names it.

Ultralytics is AGPL-3.0 — fine while this stays private/undistributed (ADR §5/§12-Q3).

## v1 acceptance
The `run_v1` pipeline (decode → detect+track → one-shot team split → annotated video) is **fully
wired and mock-integration-tested in CI** (`test/test_pipeline_run_v1.py` drives the whole
orchestration over a synthetic clip with the model boundary mocked — no torch/weights/network, CPU
image), **and verified end-to-end on the Mac `cpu-run` image (2026-06-20)**: with real weights +
SigLIP fetched, the live Ultralytics `model.track` + BoT-SORT + SigLIP team-split + libx264 encode
all run on CPU and write `out/clip/annotated.mp4`. That smoke surfaced + fixed five real runtime gaps
(SigLIP not pre-fetched, the SigLIP `sentencepiece`/tokenizer trap, hardcoded NVENC, missing `lapx`,
a tracker-yaml-path bug) — all of which would otherwise have hit the 3060 run.

The real-clip **detection-quality** numbers (clip, runtime, observed detection rate, ID-switch
hotspots) remain **to be filled in here** after a run on real public footage (3060 or `cpu-run`) —
see the [v1 acceptance runbook](../docs/vision/v1-acceptance-runbook.md).
