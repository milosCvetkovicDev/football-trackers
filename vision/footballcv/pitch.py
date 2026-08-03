# vision/footballcv/pitch.py
from __future__ import annotations
from dataclasses import replace
from pathlib import Path
import numpy as np
import yaml


def feet_point(image_bbox: tuple) -> tuple:
    """Bottom-centre of the bbox = where the player meets the ground plane.
    CAVEAT (§7-v2): this assumes the feet are VISIBLE and on the ground. A clipped or
    occluded far-side bbox bottom, or a jumping player, projects WRONG even with a perfect
    H — a distinct pitch_xy error source from the homography itself (documented, not fixed)."""
    x1, y1, x2, y2 = image_bbox
    return ((x1 + x2) / 2.0, float(y2))


class PitchProjector:
    """Constant-H projector for a fixed-cam clip. Wraps the vendored `sports` ViewTransformer
    (which builds H via cv2.findHomography and projects via cv2.perspectiveTransform)."""
    def __init__(self, image_points, pitch_points):
        from footballcv.vendor.sports import ViewTransformer   # vendored, pinned SHA (§5)
        self._vt = ViewTransformer(source=np.asarray(image_points, np.float32),
                                   target=np.asarray(pitch_points, np.float32))

    @classmethod
    def from_calibration_file(cls, path: str | Path) -> "PitchProjector":
        data = yaml.safe_load(Path(path).read_text())
        return cls(image_points=data["image_points"], pitch_points=data["pitch_points"])

    def project(self, points_xy: np.ndarray) -> np.ndarray:
        pts = np.asarray(points_xy, np.float32).reshape(-1, 2)
        return self._vt.transform_points(pts)

    def project_worldstate(self, ws):
        players = []
        for p in ws.players:
            xy = self.project(np.array([feet_point(p.image_bbox)]))[0]
            players.append(replace(p, pitch_xy=(float(xy[0]), float(xy[1]))))
        ball = ws.ball
        if ball.image_xy is not None:
            bxy = self.project(np.array([ball.image_xy]))[0]
            ball = replace(ball, pitch_xy=(float(bxy[0]), float(bxy[1])))
        return replace(ws, players=players, ball=ball)
