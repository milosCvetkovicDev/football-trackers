from pathlib import Path
import subprocess
import numpy as np
import supervision as sv
import cv2

TEAM_COLORS = {0: (0, 122, 255), 1: (255, 64, 64), None: (180, 180, 180)}  # BGR; None = referee


class EncodeError(RuntimeError):
    """ffmpeg did not produce the video these writers claim to have written.

    Both writers used to do `proc.stdin.close(); proc.wait()` and return the path they INTENDED to
    write, discarding the exit status. When ffmpeg fails — a codec the build lacks (hevc_nvenc on a
    machine with no NVIDIA GPU is this project's own history), a full disk, an unwritable mount —
    run_v1 still returned a success dict naming a file that is absent or truncated. The web UI then
    reported "obrada je prošla ali nije proizvela izlazni snimak", blaming the pipeline for a
    failure the encoder had already announced on stderr. (audit §6 "Vision".)
    """


def _finish_encode(proc, path: str, encoder: str) -> str:
    """Close the pipe, wait, and REFUSE to claim success on a non-zero exit."""
    try:
        proc.stdin.close()
    except (BrokenPipeError, OSError):
        pass                                    # ffmpeg already gone; the wait() below is the truth
    rc = proc.wait()
    if rc != 0:
        raise EncodeError(
            f"ffmpeg ({encoder}) exited {rc} — {path} was not written. Its stderr is on this "
            "process's stderr; the usual causes are a missing encoder (hevc_nvenc needs an NVIDIA "
            "GPU), an unwritable out directory, or a full disk.")
    return path

def _detections_and_labels(ws):
    if not ws.players:
        return sv.Detections.empty(), []
    xyxy = np.array([p.image_bbox for p in ws.players], float)
    class_id = np.array([0 if p.team is None else p.team for p in ws.players])
    det = sv.Detections(xyxy=xyxy, class_id=class_id,
                        tracker_id=np.array([p.track_id for p in ws.players]))
    labels = [f"#{p.track_id} {'REF' if p.team is None else 'T'+str(p.team)}" for p in ws.players]
    return det, labels

def _draw_ball(frame, ball):
    """Draw the ball marker. Solid yellow for a real detection; orange ring + a `~`
    glyph for an interpolated position so the honesty flag (interpolated=True) is
    visible on the annotated video (§8). No-op when the ball is absent this frame."""
    if ball.image_xy is None:
        return frame
    x, y = int(round(ball.image_xy[0])), int(round(ball.image_xy[1]))
    color = (0, 255, 255) if not ball.interpolated else (0, 165, 255)  # BGR; solid vs interpolated
    cv2.circle(frame, (x, y), 6, color, 2)
    if ball.interpolated:
        cv2.putText(frame, "~", (x + 7, y - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
    return frame

def annotate_frame(frame: np.ndarray, ws, team_colors: dict) -> np.ndarray:
    det, labels = _detections_and_labels(ws)
    if len(det) > 0:
        palette = sv.ColorPalette([sv.Color(*team_colors[0][::-1]), sv.Color(*team_colors[1][::-1])])
        box = sv.BoxAnnotator(color=palette)        # verify annotator API vs supervision 0.29
        lab = sv.LabelAnnotator(color=palette)
        frame = box.annotate(frame, det)
        frame = lab.annotate(frame, det, labels=labels)
    # draw the ball LAST so it renders even when there are no players this frame
    frame = _draw_ball(frame, ws.ball)
    return frame

def write_annotated_video(frames_and_states, out_dir: str, fps: float, *,
                          encoder: str = "libx264") -> str:
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    path = out / "annotated.mp4"
    proc, w, h = None, None, None
    for frame, ws in frames_and_states:
        if proc is None:
            h, w = frame.shape[:2]
            proc = _open_nvenc_writer(str(path), w, h, fps, encoder=encoder)
        try:
            proc.stdin.write(annotate_frame(frame, ws, TEAM_COLORS).tobytes())
        except BrokenPipeError:
            # ffmpeg died mid-stream. Stop feeding a closed pipe and let _finish_encode report the
            # exit status — a BrokenPipeError traceback names a file descriptor, not the encoder.
            break
    if proc is None:
        raise EncodeError(f"no frames to encode — {path} was not written")
    return _finish_encode(proc, str(path), encoder)

def _open_nvenc_writer(path, w, h, fps, encoder: str = "libx264"):
    # encoder: "hevc_nvenc" on the RTX 3060 (GPU path), "libx264" on the Mac/CPU (cpu-run) — there
    # is no NVENC without an NVIDIA GPU. run_v1/run_v2 pick it from `device`. Default is the
    # always-available software encoder so the Mac path works out of the box.
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-c:v", encoder, "-pix_fmt", "yuv420p", path]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def _carry_forward_index(ts_list, ts, si):
    """Advance index `si` to the latest state whose ts <= the frame ts (carry-forward)."""
    while si + 1 < len(ts_list) and ts_list[si + 1] <= ts:
        si += 1
    return si


def write_smooth_annotated_video(input_path, states, out_dir: str, *, encoder: str = "libx264",
                                 team_colors=TEAM_COLORS) -> str:
    """Encode a SMOOTH annotated video at the source's NATIVE fps. Detection/tracking ran at the
    (low) sample rate, but here EVERY source frame is written with the most-recent WorldState's
    boxes carried forward — so the footage plays smoothly instead of stuttering at sample_fps.
    The boxes update at the sample rate (they lag slightly between samples); the video does not."""
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    path = out / "annotated.mp4"
    states = sorted(states, key=lambda s: s.frame_ts)
    ts_list = [s.frame_ts for s in states]
    cap = cv2.VideoCapture(str(input_path))
    native_fps = cap.get(cv2.CAP_PROP_FPS)
    if not native_fps or native_fps <= 1 or native_fps > 120:   # guard bogus container metadata
        native_fps = 25.0
    proc, si, idx = None, 0, 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            ts = idx / native_fps
            if ts_list and ts >= ts_list[0]:
                si = _carry_forward_index(ts_list, ts, si)
                ws = states[si]
            else:
                ws = None                                       # before the first detection
            if proc is None:
                h, w = frame.shape[:2]
                proc = _open_nvenc_writer(str(path), w, h, native_fps, encoder=encoder)
            out_frame = annotate_frame(frame, ws, team_colors) if ws is not None else frame
            try:
                proc.stdin.write(out_frame.tobytes())
            except BrokenPipeError:
                break                       # see write_annotated_video: the exit status is the truth
            idx += 1
    finally:
        cap.release()
    if proc is None:
        raise EncodeError(f"decoded no frames from {input_path} — {path} was not written")
    return _finish_encode(proc, str(path), encoder)
