# vision/test/test_report_encode.py
#
# ffmpeg's exit status must be checked (audit §6 "Vision": *ffmpeg exit status unchecked*).
#
# WHAT AN UNCHECKED ENCODE LOOKS LIKE FROM THE OUTSIDE. Both writers did
# `proc.stdin.close(); proc.wait()` and then returned the path they INTENDED to write. If ffmpeg
# exits non-zero — a codec the build lacks (hevc_nvenc on a machine with no NVIDIA GPU is exactly
# this project's history), a full disk, an unwritable mount — the function still returns
# "out/<job>/annotated.mp4" and run_v1 still returns a success dict with that path in it. The web UI
# then reports "obrada je prošla ali nije proizvela izlazni snimak", blaming the pipeline for a
# failure ffmpeg already announced and the code discarded.
#
# The other half is the broken pipe: when ffmpeg dies at frame 1, every later `stdin.write` raises
# BrokenPipeError, which is an unhandled crash with a traceback about a pipe rather than a message
# about an encoder. Both paths have to end at the same honest error.

import numpy as np
import pytest

from footballcv import report
from footballcv.report import EncodeError
from footballcv.types import BallObs, PlayerObs, WorldState


def _ws(i):
    return WorldState(i, i / 5.0, "raw",
                      [PlayerObs(1, "player", 0, (5, 5, 20, 40), None, 0.9)],
                      BallObs(None, None, 0.0, False))


def _frames(n=3):
    for i in range(n):
        yield np.zeros((48, 64, 3), np.uint8), _ws(i)


class _FakeStdin:
    def __init__(self, broken=False):
        self.broken, self.writes = broken, 0

    def write(self, _b):
        self.writes += 1
        if self.broken and self.writes > 1:
            raise BrokenPipeError(32, "Broken pipe")

    def close(self):
        pass


class _FakeProc:
    def __init__(self, rc, broken=False):
        self.stdin, self._rc = _FakeStdin(broken), rc
        self.returncode = None

    def wait(self, timeout=None):
        self.returncode = self._rc
        return self._rc

    def kill(self):
        self.returncode = -9

    def poll(self):
        return self.returncode


def test_a_failed_encode_raises_instead_of_returning_a_path(tmp_path, monkeypatch):
    monkeypatch.setattr(report, "_open_nvenc_writer", lambda *a, **k: _FakeProc(1))
    with pytest.raises(EncodeError) as ei:
        report.write_annotated_video(_frames(), str(tmp_path), 5.0)
    assert "ffmpeg" in str(ei.value).lower()
    assert "1" in str(ei.value), "the encoder's exit status belongs in the message"


def test_a_successful_encode_still_returns_the_path(tmp_path, monkeypatch):
    monkeypatch.setattr(report, "_open_nvenc_writer", lambda *a, **k: _FakeProc(0))
    out = report.write_annotated_video(_frames(), str(tmp_path), 5.0)
    assert out.endswith("annotated.mp4")


def test_a_broken_pipe_becomes_the_same_honest_error(tmp_path, monkeypatch):
    """ffmpeg dying at frame 1 must surface as 'the encoder failed', not as a BrokenPipeError
    traceback about a file descriptor."""
    monkeypatch.setattr(report, "_open_nvenc_writer", lambda *a, **k: _FakeProc(1, broken=True))
    with pytest.raises(EncodeError):
        report.write_annotated_video(_frames(10), str(tmp_path), 5.0)


def test_the_smooth_writer_checks_the_encoder_too(tmp_path, monkeypatch, synthetic_clip):
    """`write_smooth_annotated_video` is the one run_v1 actually uses in production — the audit's
    concern is not the writer the tests happen to reach."""
    monkeypatch.setattr(report, "_open_nvenc_writer", lambda *a, **k: _FakeProc(1))
    with pytest.raises(EncodeError):
        report.write_smooth_annotated_video(synthetic_clip["path"], [_ws(i) for i in range(5)],
                                            str(tmp_path))


def test_the_smooth_writer_returns_the_path_on_success(tmp_path, monkeypatch, synthetic_clip):
    monkeypatch.setattr(report, "_open_nvenc_writer", lambda *a, **k: _FakeProc(0))
    out = report.write_smooth_annotated_video(synthetic_clip["path"],
                                              [_ws(i) for i in range(5)], str(tmp_path))
    assert out.endswith("annotated.mp4")
