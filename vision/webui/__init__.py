"""footballcv web UI — a tiny, stdlib-only "drop a YouTube link → process" tool.

Runs INSIDE the cpu-run / gpu Docker image (which ship yt-dlp + the footballcv stack),
never on the host. It shells out (yt-dlp, then `python -m footballcv.pipeline`) — it does
NOT import torch/ultralytics itself, so it stays importable in the light CPU test image.

PRIVACY GATE (ADR-0023 §3/§14): processing is refused unless the caller attests the footage
is PUBLIC adult/pro — OR youth footage with parental consent. The attestation is enforced
server-side (not just in the browser) and written to a local ledger.
"""
