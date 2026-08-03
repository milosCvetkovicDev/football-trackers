# v1 Acceptance Runbook (Task 12) — copy-paste, RTX 3060 desktop

> **Everything runs in Docker — see `vision/docker-compose.yml`. Nothing runs on the host.**

Run the v1 acceptance gate (ADR-0023 §7-v1) end-to-end on **your own Windows/Linux desktop with
an NVIDIA RTX 3060 (12 GB)**. Written for a non-technical owner: every step is a command you can
copy, paste, and run. Do them **in order**. If a command fails, jump to **§7 Troubleshooting**.

> **PRIVACY — non-negotiable (ADR-0023 §3).** Use **PUBLIC adult/professional** football footage
> ONLY. **No youth, age-group, academy, or children's footage — ever, at any step.** If you cannot
> positively confirm a clip is adult/senior, **do not use it** (default-deny).

What you produce: `out/clip/annotated.mp4` — the match clip with a coloured box + a stable number on
each player, two team colours, and the referee in grey. Plus a short note recorded in
`vision/README.md`.

This runbook also fills in **one piece of code the builders left as a stub** (the model download).
Copy that block exactly as shown. The main pipeline loop (`run_v1`) is **already wired and
mock-integration-tested in CI** (Docker, CPU image) — you no longer hand-paste it; only the live
GPU detect+track call runs for the first time on your 3060.

**How the Docker model works (read once).** All of Python, torch+CUDA, ffmpeg, `gdown` and `yt-dlp`
live **inside the images** — you install none of them on the desktop. You only edit source files on
the host with a normal text editor; the `vision/` folder is **bind-mounted** into the container, so
edits take effect immediately with **no rebuild**. Two images/targets (see `vision/Dockerfile`):
- **cpu** — the test suite + `--selftest` (no torch; runs anywhere, even a Mac).
- **gpu** — the real pipeline on the RTX 3060 (torch+CUDA from the pytorch base; `gdown`+`yt-dlp`
  pre-installed). Gated behind the compose `gpu` profile so it never starts on a non-GPU box.

---

## 1. Prerequisites (one-time, check each)

Open a terminal (Windows: "PowerShell" or "Command Prompt"; Linux: your terminal). Run each check.
A line like the example output means it is installed.

**NVIDIA driver** — proves the GPU is visible:
```
nvidia-smi                    # expect: a table showing "NVIDIA GeForce RTX 3060" and a CUDA Version
```
- If "command not found": install the latest **NVIDIA Game Ready / Studio driver** from
  https://www.nvidia.com/Download/index.aspx . You do **not** need the full CUDA Toolkit on the host —
  the GPU image brings its own CUDA. The driver alone is enough.
- The "CUDA Version" shown by `nvidia-smi` is the **max** the driver supports; **12.1 or higher** is fine.
  Note this number — you will confirm the GPU image's CUDA tag matches it in §2 (see §7).

**Docker Engine** — runs everything:
```
docker --version              # expect: Docker version 2x.x.x
docker compose version        # expect: Docker Compose version v2.x.x
```
- If missing: Windows — install **Docker Desktop** (https://www.docker.com/products/docker-desktop/)
  and make sure WSL2 + GPU support is enabled. Linux — install **Docker Engine** + the Compose plugin
  per https://docs.docker.com/engine/install/ .

**NVIDIA Container Toolkit** — lets containers see the GPU (this is what makes `--gpus` / the compose
`gpu` profile work):
```
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
```
- Expect the **same** `nvidia-smi` table as above, but printed **from inside a container**. That single
  line proves Docker can reach the 3060.
- If it errors (`could not select device driver ... gpu`): install the **NVIDIA Container Toolkit**.
  Linux — follow https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
  then `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
  Windows — it ships with Docker Desktop's WSL2 GPU support; update Docker Desktop and your driver.
  See **§7** for the common failure modes.

**No Roboflow account or API key needed.** `fetch_models.py` downloads the weights from Roboflow's
own **public** Google-Drive links via `gdown` (free, no key, no paid plan). (Earlier versions of this
runbook had you create a key and hand-edit the downloader — that is **no longer required**; the code
does it. If you set a key for unrelated reasons, never paste it into any file that goes into git.)

There is **no** host Python, ffmpeg, or yt-dlp to install — they live in the images.

---

## 2. One-time setup (copy the project, build the GPU image)

**Copy the `vision/` folder to your desktop.** If you have the repo, copy the whole `vision/`
directory. Everything below runs **from inside `vision/`**. Open a terminal there:
```
cd path\to\football-trackers\vision      # Windows
cd path/to/football-trackers/vision      # Linux/Mac
```

> **Privacy is already handled:** `vision/.gitignore` is committed and in force. It keeps `models/`,
> `samples/`, `out/`, and any `*.mp4`/`*.pt` out of version control automatically. You do not need to
> do anything for this — just never copy footage or weights into git yourself.

**Build the GPU image once** (this is the big one — it pulls the pytorch/CUDA base + installs
ultralytics, gdown, yt-dlp; ~several GB; let it finish):
```
docker compose --profile gpu build run
```
- The **CPU** image (tests/selftest) builds itself automatically the first time you run
  `docker compose run --rm test` below — you do not build it by hand.
- The host `.venv` from earlier versions of this runbook is **no longer used**. Delete it if present;
  nothing on the host runs Python anymore.

> **Confirm the image's CUDA tag matches your driver.** `vision/Dockerfile`'s GPU target pins
> `pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime`. That CUDA **12.1** must be **≤** the "CUDA Version"
> `nvidia-smi` reported in §1. If your driver is older than 12.1, the build/run will still build but the
> container will fail to use the GPU — see **§7 (CUDA tag mismatch)** to pick a matching tag.

**Confirm the GPU is visible from inside the image** (the single most important check):
```
docker compose --profile gpu run --rm run python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NO GPU')"
```
- Expect something like `2.5.1+cu121 True NVIDIA GeForce RTX 3060`. If it prints `False` / `NO GPU`,
  stop and see **§7 (GPU not visible in container)** — nothing GPU will work until this says `True`.

**No API key to set.** `fetch_models.py` uses public gdown links (§3); there is nothing to export.
(A Mac with no GPU can skip the GPU steps above and smoke-test the real pipeline on a short clip via
the CPU image: `docker compose run --rm cpu-run python fetch_models.py`, then
`docker compose run --rm cpu-run python -m footballcv.pipeline --input samples/<clip>.mp4 --device cpu --sample-fps 2 --out out/clip/` — slow but correct.)

> **Edit on the host, run in the container.** Every code edit below (§5, and the README note in §6)
> is made with your normal text editor in the `vision/` folder on the desktop. Because `vision/` is
> bind-mounted into the container, the change is live on the next `docker compose ... run` — **no
> rebuild needed.** When several steps in a row need the container, open one interactive shell with
> `docker compose --profile gpu run --rm run bash` and run them there.

---

## 3. Fetch the weights (no editing, no API key)

`fetch_models.py` already downloads the three weights from Roboflow's **public** Google-Drive links
via `gdown` — the exact `.pt` files the official `roboflow/sports` soccer recipe uses
(`football-players-detection-3zvbc` + ball + field). **No API key, no paid plan, and nothing to
edit** — the Drive ids live in `fetch_models.py`. *(Verified against `roboflow/sports`
examples/soccer/setup.sh, June 2026; `gdown` is installed in the GPU and `cpu-run` images.)*

> **Why not the Roboflow SDK `model.download()`?** That downloads a raw `.pt` only on **paid**
> Roboflow plans — it fails on a free account. The free path the `sports` recipe itself uses is the
> public gdown links above, which is what `fetch_models.py` does by default (a Roboflow-SDK fallback
> only kicks in if you set `ROBOFLOW_API_KEY` AND a Drive id is missing).

> **If gdown is rate-limited by Google Drive** ("too many users have viewed/downloaded"), wait a few
> minutes and re-run, or open `https://drive.google.com/uc?id=<id>` (the ids are in `fetch_models.py`)
> in a browser, download the `.pt` by hand into `vision/models/` (bind-mounted), then re-run.

**Now fetch the weights and run the self-test (both in-container):**
```
docker compose --profile gpu run --rm run python fetch_models.py
docker compose run --rm selftest
```
- `fetch_models.py` expects: `wrote .../models/MANIFEST.json with 3 weights`, the three `.pt` files in
  `vision/models/`, and a final line `pre-fetched team-classifier 'google/siglip-base-patch16-224'`.
  **That SigLIP pre-fetch matters:** the team split uses a HuggingFace model, and the pipeline runs
  with `HF_HUB_OFFLINE=1` (privacy) — so SigLIP must be cached at setup or the run fails. It is cached
  under `models/hf` (`HF_HOME`, bind-mounted, so it persists). `fetch_models.py` therefore needs the
  network once (gdown + HuggingFace); the actual pipeline run is fully offline.
- `selftest` expects a green line ending `offline_guards=set`. This proves the pipeline imports,
  the offline guards are on, and team-anchoring is deterministic — with **no network access**.
  (`selftest` uses the CPU image, so it builds that image on first run.)

> **Verified end-to-end on the Mac CPU image (2026-06-20):** with the weights + SigLIP fetched, the
> real pipeline (`docker compose run --rm cpu-run python -m footballcv.pipeline --input samples/clip.mp4
> --device cpu --sample-fps 2 --imgsz 640 --out out/clip/`) runs the full decode → YOLO + BoT-SORT
> track → SigLIP team split → annotated-video path and writes `out/clip/annotated.mp4`. The runtime
> deps the smoke surfaced are now in the image: `lapx` (BoT-SORT linear-assignment) and a `libx264`
> encoder fallback (there is no NVENC without an NVIDIA GPU; the 3060 path still uses `hevc_nvenc`).

---

## 4. Pick and fetch ONE public clip (default-deny privacy)

**Choosing a clip — read this first.** You want the clip that best matches the eventual fixed GoPro
mount, in priority order:
1. **Best:** a **fixed, elevated, wide tactical / "all-22" camera** view of a senior/adult match
   (the whole pitch in one steady shot — like a coach's tactical-cam upload).
2. **Acceptable (lower bound):** a normal **broadcast** clip of an adult/pro match. Broadcast cuts and
   zooms make IDs worse, so treat any broadcast result as a **floor**, not the real score.

**MUST be adult/senior and public.** Confirm from the video title/description/channel that it is a
senior or professional competition. **If you cannot confirm adult/senior, pick a different clip.**
**Never** download anything labelled youth, U-anything, academy, school, or age-group — even if public.

**Pick a calm ~1-3 minute stretch** (open play, not the highlight-reel goal montage). Copy its
start/end times, e.g. from `05:00` to `06:30`.

**Download just that segment into `samples/`** (replace the URL and the times). `yt-dlp` is already in
the GPU image; run it **in-container** and it writes into the bind-mounted `samples/`:
```
docker compose --profile gpu run --rm run yt-dlp -f "bestvideo+bestaudio" --merge-output-format mp4 \
  --download-sections "*05:00-06:30" --force-keyframes-at-cuts \
  -o "samples/clip.mp4" "https://www.youtube.com/watch?v=YOUR_VIDEO_ID"
```
- Put it all on one line, or use `\` at line ends (Linux/Mac shell, as above). On Windows PowerShell use
  a backtick `` ` `` at line ends, or just paste it as a single line.
- `--download-sections "*START-END"` grabs only your range; `*` means "these are timestamps".
  *(Verified against current yt-dlp, June 2026.)*
- Expect `samples/clip.mp4` to exist on the host (via the bind mount) and be a few tens of MB. Play it
  once to confirm it is the right footage and is the steady wide/broadcast view you intended.

**Record provenance — REQUIRED.** Add one line to the committed `vision/samples.manifest.jsonl`
(it is currently empty). Edit it **on the host**. This file is your audit trail that the clip is
adult/senior. Append exactly one JSON line, filled in for your clip:
```
{"source": "https://www.youtube.com/watch?v=YOUR_VIDEO_ID", "channel": "<uploader/channel name>", "competition": "<the adult/senior league or tournament>", "adult_senior_confirmed": true, "date": "2026-06-19"}
```
- `adult_senior_confirmed` must be `true` (you confirmed it above). The clip itself stays in the
  gitignored `samples/`; only this one provenance line is committed.

---

## 5. (No code to paste) — `run_v1` is already wired

**You do not edit `run_v1` anymore.** The detect + track + one-shot team-split + annotate loop is
fully implemented in `vision/footballcv/pipeline.py` and is exercised end-to-end in CI by
`test/test_pipeline_run_v1.py`, which drives the real orchestration over a synthetic clip with the
model boundary mocked (no torch, no weights, no network — it runs in the CPU image). The pipeline
exposes a small injectable seam so CI can do this:

```python
run_v1(input, out_dir, *, device, sample_fps, imgsz, models_dir,
       track_provider=None, embedder=None, writer=None)
```
When the three injectables are `None` (the default, i.e. your 3060 run), `run_v1` builds the real
ones with lazy imports made **after** the offline guards: the production `track_provider` wraps
Ultralytics `model.track(persist=True, tracker=config/botsort_football.yaml)`, `embedder` is the
SigLIP team embedder, and `writer` is the NVENC annotated-video encoder. It loads the player model
once (12 GB budget — one model resident at a time), runs detect+track per sampled frame, fits teams
**once** over a per-track sample crop, caches team per `track_id`, and writes the annotated video.

**The only part that runs for the first time on your desktop is that live Ultralytics
`model.track(...)` call** — it needs the GPU + the real weights and so cannot be exercised in CI by
design. Everything around it (decode, the two-pass WorldState build, team anchoring, annotation,
provenance) is already tested. You therefore just run the pipeline (next step); there is no block to
copy here.

**One NVENC fallback edit (only if NVENC is unavailable inside the container).** NVENC needs the GPU's
hardware encoder passed through to the container, which does not always work. If the run errors about
`hevc_nvenc`, open `vision/footballcv/report.py` **on the host**, find `_open_nvenc_writer`, and change
the encoder line:
```python
           "-c:v", "hevc_nvenc", "-pix_fmt", "yuv420p", path]   # original
```
to:
```python
           "-c:v", "libx264", "-pix_fmt", "yuv420p", path]      # CPU fallback, no NVENC needed
```
*(This runbook does not wire a `--encoder` CLI flag; the one-line edit is the simplest reliable fix.
`libx264` is in the image's ffmpeg and always works. If NVENC-in-container works for you, leave it.)*

---

## 6. Run it, then verify the §7-v1 success criteria

**Run the pipeline.** The compose `run` service already encodes the gate command —
`--input samples/clip.mp4 --device cuda --sample-fps 5 --imgsz 1280 --out out/clip/` — so the bare
invocation just works (from `vision/`):
```
docker compose --profile gpu run --rm run
```
- Output lands at **`vision/out/clip/annotated.mp4`** on the host (via the bind mount). A 1-3 min clip
  at 5 fps / 1280 should finish in a few minutes on the 3060. If it is very slow, see §7 (slow run).
- Open `out/clip/annotated.mp4` in any video player.

> **Overriding `--input` / other flags.** To run a different clip or change a flag, append your own
> command after the service name — it **replaces** the compose default, so repeat the flags you want:
> ```
> docker compose --profile gpu run --rm run \
>   python -m footballcv.pipeline --input samples/other.mp4 --device cuda --sample-fps 5 --imgsz 1280 --out out/clip/
> ```

**Check the five criteria (this IS the gate — ADR-0023 §7-v1):**

1. **Detection ≥ 90%.** Watch the video. For players/GKs/referee that are **clearly and unoccludedly
   visible**, are they boxed in at least 90% of frames? Judge against the **actual number of players
   visible in this clip** (a wide/broadcast shot rarely shows all 22 — do not expect 22).
2. **Team colour stable per ID, no flicker.** Pick a few players. Does each keep **one** team colour
   for its whole on-screen life (not flickering blue/red frame to frame)? Referee should stay grey.
3. **Same team mapping across two runs.** Run the exact same command a second time into a different
   folder and confirm team-0 vs team-1 is the **same side both times** (override the default command to
   change `--out`):
   ```
   docker compose --profile gpu run --rm run \
     python -m footballcv.pipeline --input samples/clip.mp4 --device cuda --sample-fps 5 --imgsz 1280 --out out/clip_run2/
   ```
   Compare a clear frame from each: the team that was "team 0 / blue" should be the **same** physical
   team in both runs. (This is the determinism + anchoring check.)
4. **ID-switch hotspots noted.** Players should hold one number while spaced out. IDs **will** swap at
   scrums, throw-ins, and crossings — that is the known v1 limitation. Just **note where** it happens
   (you do not need to fix it; the v3 stitch spike is the candidate fix).
5. **Privacy / self-tests green.** Confirm (both in-container):
   ```
   docker compose run --rm selftest
   docker compose run --rm test
   ```
   Both should pass. `selftest` proves no network at run time; the `test` suite includes the
   no-network fail-on-connect and gitignore tests. (Both use the CPU image and run anywhere.)

**Record the result** in `vision/README.md` (edit it **on the host**). There is already a
`## v1 acceptance` heading at the bottom — replace the placeholder paragraph with a short note, e.g.:
```markdown
## v1 acceptance
Passed 2026-06-19 on RTX 3060. Clip: <competition>, ~90 s broadcast (lower bound), 5 fps / imgsz 1280,
runtime ~X min. Detection of clearly-visible players ~NN%. Team colours stable per id; team-0/1 mapping
identical across two runs. ID-switch hotspots: throw-ins near the left touchline, one goalmouth scrum.
selftest + pytest green.
```
v1 is **done** when all five criteria above hold and this note is written.

---

## 7. Troubleshooting

**`docker run --gpus all ...` errors with `could not select device driver "" with capabilities: [[gpu]]`
(or the §1 toolkit check / the `run` service fails to see the GPU).** The **NVIDIA Container Toolkit**
is not installed or Docker is not configured to use it.
- Linux: install the toolkit, then `sudo nvidia-ctk runtime configure --runtime=docker` and
  `sudo systemctl restart docker`. Re-run the §1 `docker run --rm --gpus all nvidia/cuda:...` check.
- Windows: the toolkit comes with Docker Desktop's WSL2 GPU support — update Docker Desktop **and** the
  NVIDIA driver (§1), reboot, and confirm GPU support is enabled in Docker Desktop settings.
- Until `docker run --rm --gpus all ... nvidia-smi` prints the 3060 table, the `gpu` profile cannot use
  the GPU.

**`torch.cuda.is_available()` is `False` / "NO GPU" inside the container** (the §2 check).
- The container can't reach the GPU: fix the toolkit first (above) and confirm `nvidia-smi` works on the
  host and shows the 3060. If the driver is old, update it (§1) and reboot.
- It may also be a **CUDA tag mismatch** (next item).
- You can test logic without a GPU using the CPU image (`docker compose run --rm test` / `selftest`),
  but the real pipeline needs `--device cuda` working.

**CUDA tag mismatch — the GPU base image's CUDA is newer than your driver supports.** `vision/Dockerfile`
pins `pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime`. The image's CUDA (here **12.1**) must be **≤** the
"CUDA Version" `nvidia-smi` shows in §1.
- If your driver is older (e.g. it reports CUDA 11.8), edit the GPU `FROM` line in `vision/Dockerfile` to
  a matching published tag, e.g. `pytorch/pytorch:2.x.x-cuda11.8-cudnn8-runtime`. Pick a real, existing
  tag — verify it first with `docker pull pytorch/pytorch:<tag>` (browse tags at
  https://hub.docker.com/r/pytorch/pytorch/tags). Then `docker compose --profile gpu build run` again.
- *(Honest caveat: the exact best tag depends on your desktop's driver/CUDA, which can't be confirmed
  from here — pick the highest `cuda*` tag that is `≤` your `nvidia-smi` CUDA version.)*

**NVENC unavailable inside the container / ffmpeg error about `hevc_nvenc`.** Hardware NVENC encoding is
not always exposed through the container even when the GPU is. Apply the one-line `libx264` edit in §5
(end of section), then re-run. `libx264` is a CPU encoder present in the image's ffmpeg; slower but
always works.

**No video file / ffmpeg "broken pipe" inside the container.** The annotated writer pipes raw frames
into the container's `ffmpeg`. If the `samples/clip.mp4` download was empty, the writer gets zero
frames — re-download in §4 and confirm the file has a real size on the host. (ffmpeg itself is always
present in the image, so a missing-ffmpeg failure should not happen.)

**Bind-mount / path / permission issues (edits "don't take", or files written in the container are
unwritable on the host).**
- "My edit didn't take effect": confirm you ran the command **from inside `vision/`** (the compose file
  mounts `.` → `/app`). Edit the file under `vision/` on the host; it is the same file the container
  sees. No rebuild is needed for source edits — only for dependency changes.
- Windows + Docker Desktop: make sure the drive holding `football-trackers` is **shared** with Docker
  (Docker Desktop → Settings → Resources → File sharing), or the bind mount will be empty.
- Linux file ownership: the image runs as a non-root user; if `models/`, `samples/`, or `out/` end up
  owned by a different uid and you can't open them, `sudo chown -R "$USER" vision/{models,samples,out}`.

**`fetch_models.py` / weight download fails.** It uses **public gdown** links — **no API key needed**
(the old "set `ROBOFLOW_API_KEY`" / "edit the downloader" steps are gone; the code does it). If `gdown`
fails with a Google Drive quota message ("too many users have viewed/downloaded"), wait and retry, or
download the three `.pt` files manually into the bind-mounted `vision/models/` (Drive ids are in
`fetch_models.py`), then re-run.

**SHA256 mismatch / "weight file absent" when running the pipeline.** The weights in `models/` do not
match `models/MANIFEST.json` (corrupted or partial download). Delete `vision/models/` on the host and
re-run `docker compose --profile gpu run --rm run python fetch_models.py` to re-download and re-hash.

**Run is very slow (minutes per few seconds of clip).** Levers, in order:
- Confirm it is actually on the GPU (`--device cuda` + the §2 `torch.cuda.is_available()` True inside the
  container). CPU is 10-50× slower.
- Lower the work with frame sampling: override the command with `--sample-fps 3` (fewer frames). Do
  **not** go below ~3 fps for v1 — bigger gaps between frames cause more ID switches.
- Drop resolution for a quick smoke test: `--imgsz 960` (faster, but small far-side players may be
  missed — use 1280 for the real gate).
- A 1-3 min clip at 5 fps / 1280 finishing in a few minutes is normal. A full 1-hour match is a much
  longer (30-60 min) run — out of scope for this acceptance.

**Mac dev box (no NVIDIA).** You can only run the CPU image there — `docker compose run --rm test` and
`docker compose run --rm selftest` work on Apple Silicon. The `gpu` profile (and the real pipeline) will
not run without an NVIDIA GPU + the Container Toolkit; the 3060 desktop is the box the gate is judged on.
