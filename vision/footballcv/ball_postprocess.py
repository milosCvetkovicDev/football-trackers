# vision/footballcv/ball_postprocess.py
from __future__ import annotations
import numpy as np
from footballcv.types import BallObs


def gate_candidates(stream, *, conf_floor: float, max_jump_px: float) -> list[BallObs | None]:
    """Keep the per-frame candidate only if it clears the confidence floor AND is within
    max_jump_px of the last accepted position (single-candidate-near-centroid, §8). Rejected
    or absent frames -> None. `stream` items are (frame_ts, xy_or_None, conf)."""
    out: list[BallObs | None] = []
    last_xy = None
    for _ts, xy, conf in stream:
        if xy is None or conf < conf_floor:
            out.append(None)
            continue
        if last_xy is not None and float(np.hypot(xy[0] - last_xy[0], xy[1] - last_xy[1])) > max_jump_px:
            out.append(None)
            continue       # max-jump gate: reject the teleport, keep last
        out.append(BallObs(image_xy=(float(xy[0]), float(xy[1])), pitch_xy=None,
                           confidence=float(conf), interpolated=False))
        last_xy = (float(xy[0]), float(xy[1]))
    return out


def interpolate_gaps(observed: list[BallObs | None], frame_ts: list[float], *,
                     max_gap_s: float) -> list[BallObs]:
    """Linear-interpolate each None run bounded by two real detections IFF the time spanned
    is <= max_gap_s (the <=0.5 s honesty cap, §8). Filled frames are flagged interpolated=True.
    Over-cap gaps (and leading/trailing Nones) stay empty — NO fabrication."""
    n = len(observed)
    out: list[BallObs] = [b if b is not None
                          else BallObs(None, None, 0.0, False) for b in observed]
    i = 0
    while i < n:
        if observed[i] is not None:
            i += 1
            continue
        j = i
        while j < n and observed[j] is None:
            j += 1
        left, right = i - 1, j               # bracketing real detections
        if left >= 0 and right < n and (frame_ts[right] - frame_ts[left]) <= max_gap_s:
            a, b = observed[left], observed[right]
            span = frame_ts[right] - frame_ts[left]
            for k in range(i, j):
                t = (frame_ts[k] - frame_ts[left]) / span if span > 0 else 0.0
                x = a.image_xy[0] + t * (b.image_xy[0] - a.image_xy[0])
                y = a.image_xy[1] + t * (b.image_xy[1] - a.image_xy[1])
                out[k] = BallObs(image_xy=(x, y), pitch_xy=None, confidence=0.0, interpolated=True)
        # else: over-cap or unbounded -> leave the BallObs(None, ...) placeholders
        i = j
    return out


def ball_known_fraction(balls: list[BallObs]) -> float:
    """1 - (interpolated + missing) / frames — the honesty gate (§7.3). Only REAL detections
    count as known."""
    if not balls:
        return 0.0
    known = sum(1 for b in balls if b.image_xy is not None and not b.interpolated)
    return known / len(balls)


def postprocess_ball_track(stream, *, conf_floor: float, max_jump_px: float,
                           max_gap_s: float = 0.5) -> tuple[list[BallObs], float]:
    frame_ts = [ts for ts, _xy, _c in stream]
    gated = gate_candidates(stream, conf_floor=conf_floor, max_jump_px=max_jump_px)
    filled = interpolate_gaps(gated, frame_ts, max_gap_s=max_gap_s)
    return filled, ball_known_fraction(filled)
