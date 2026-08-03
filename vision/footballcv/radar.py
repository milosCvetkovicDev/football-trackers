# vision/footballcv/radar.py
from __future__ import annotations
from pathlib import Path
import subprocess
import numpy as np
import cv2

TEAM_COLORS = {0: (0, 122, 255), 1: (255, 64, 64), None: (180, 180, 180)}  # BGR; matches report.py
BALL_COLOR = (255, 255, 255)
PITCH_LEN_CM, PITCH_WID_CM = 12000, 7000     # SoccerPitchConfiguration (§5)


def pitch_to_canvas(pitch_xy: tuple, canvas_wh: tuple) -> tuple:
    """cm on the 12000x7000 pitch -> integer px on the radar canvas (x along length)."""
    w, h = canvas_wh
    x = int(round(pitch_xy[0] / PITCH_LEN_CM * w))
    y = int(round(pitch_xy[1] / PITCH_WID_CM * h))
    return (x, y)


def draw_pitch(*, width_px: int = 1050, height_px: int = 680) -> np.ndarray:
    """Empty green board with halfway line, centre circle, and a border — OpenCV, not
    matplotlib (§10). Uses SoccerPitchConfiguration proportions; the .vertices set from the
    vendored config can replace these primitives for full markings."""
    canvas = np.full((height_px, width_px, 3), (40, 110, 40), np.uint8)
    cv2.rectangle(canvas, (1, 1), (width_px - 2, height_px - 2), (255, 255, 255), 2)
    cv2.line(canvas, (width_px // 2, 0), (width_px // 2, height_px), (255, 255, 255), 2)
    r = int(round(915 / PITCH_WID_CM * height_px))     # centre-circle radius 915 cm
    cv2.circle(canvas, (width_px // 2, height_px // 2), r, (255, 255, 255), 2)
    return canvas


class EmaSmoother:
    """Per-track exponential moving average over pitch_xy to kill single-frame jitter."""
    def __init__(self, alpha: float = 0.4):
        self.alpha = alpha
        self._state: dict = {}

    def smooth(self, key, xy: tuple) -> tuple:
        prev = self._state.get(key)
        out = xy if prev is None else (self.alpha * xy[0] + (1 - self.alpha) * prev[0],
                                       self.alpha * xy[1] + (1 - self.alpha) * prev[1])
        self._state[key] = out
        return out


def render_radar_frame(ws, *, team_colors=TEAM_COLORS, smoother: "EmaSmoother | None" = None,
                       canvas=None) -> np.ndarray:
    board = draw_pitch() if canvas is None else canvas.copy()
    h, w = board.shape[:2]
    for p in ws.players:
        if p.pitch_xy is None:
            continue
        xy = smoother.smooth(("p", p.track_id), p.pitch_xy) if smoother else p.pitch_xy
        cx, cy = pitch_to_canvas(xy, (w, h))
        cx, cy = min(max(cx, 0), w - 1), min(max(cy, 0), h - 1)
        cv2.circle(board, (cx, cy), 6, team_colors.get(p.team, team_colors[None]), -1)
    if ws.ball.pitch_xy is not None:
        bx, by = pitch_to_canvas(ws.ball.pitch_xy, (w, h))
        cv2.circle(board, (min(max(bx, 0), w - 1), min(max(by, 0), h - 1)), 4, BALL_COLOR, -1)
    return board


def write_radar_video(states, out_dir: str, fps: float, *, encoder: str = "libx264") -> str:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / "radar.mp4"
    smoother = EmaSmoother()
    proc, board = None, draw_pitch()
    for ws in states:
        frame = render_radar_frame(ws, smoother=smoother, canvas=board)
        if proc is None:
            h, w = frame.shape[:2]
            proc = _open_nvenc_writer(str(path), w, h, fps, encoder=encoder)   # SECOND encode pass (§10)
        proc.stdin.write(frame.tobytes())
    if proc:
        proc.stdin.close()
        proc.wait()
    return str(path)


def _open_nvenc_writer(path, w, h, fps, encoder: str = "libx264"):
    # "hevc_nvenc" on the 3060, "libx264" on the Mac/CPU (no NVENC without an NVIDIA GPU); the
    # caller picks it from `device`. Default = the always-available software encoder.
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-c:v", encoder, "-pix_fmt", "yuv420p", "-vf", "scale=1920:1080", path]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def frac_dots_in_left_third(ws, team: int) -> float:
    """Fraction of `team`'s projected players whose pitch_x is in the left third of the pitch
    (< PITCH_LEN_CM/3). The §7-v2 numeric anchoring gate; reused by v3 possession-by-zone."""
    pts = [p.pitch_xy for p in ws.players if p.team == team and p.pitch_xy is not None]
    if not pts:
        return 0.0
    left = sum(1 for x, _y in pts if x < PITCH_LEN_CM / 3)
    return left / len(pts)
