"""Placeholder for vendored Roboflow `sports` modules (MIT), to be copied at a pinned
upstream commit SHA at build time (ADR §5): ViewTransformer, SoccerPitchConfiguration,
TeamClassifier, radar annotators, resolve_goalkeepers_team_id. v1 does not import these
at runtime; v2 (radar/pitch) and the teams embedder reuse their patterns. Record the
upstream SHA in vision/README.md when vendored.
"""

# ---------------------------------------------------------------------------
# v2: minimal, API-compatible reimplementations of the `sports` surface that
# pitch.py (Task 2) and radar.py (Task 5) actually consume. These are NOT a
# verbatim copy of the upstream Roboflow `sports` package; they are independent
# minimal equivalents written against its public API shape (MIT-spirit). Only
# the methods/attributes v2 needs are provided.
# ---------------------------------------------------------------------------
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import cv2


class ViewTransformer:
    """Planar homography between a source point set and a target point set.

    API-compatible with Roboflow `sports.common.view.ViewTransformer`:
    ``ViewTransformer(source, target)`` fits ``H`` via ``cv2.findHomography`` and
    ``transform_points(points: (N,2)) -> (N,2)`` maps source-space points into
    target space with ``cv2.perspectiveTransform``.
    """

    def __init__(self, source, target):
        source = np.asarray(source, np.float32)
        target = np.asarray(target, np.float32)
        if source.shape != target.shape:
            raise ValueError("source and target must have the same shape")
        if source.shape[1] != 2:
            raise ValueError("source and target points must be 2D")
        # method 0 = least-squares over all correspondences (RANSAC also valid).
        self.m, _ = cv2.findHomography(source, target, 0)
        if self.m is None:
            raise ValueError("homography could not be computed (degenerate points)")

    def transform_points(self, points: np.ndarray) -> np.ndarray:
        points = np.asarray(points, np.float32)
        if points.size == 0:
            return points.reshape(-1, 2)
        if points.shape[1] != 2:
            raise ValueError("points must be 2D")
        reshaped = points.reshape(-1, 1, 2)
        transformed = cv2.perspectiveTransform(reshaped, self.m)
        return transformed.reshape(-1, 2).astype(np.float32)


@dataclass
class SoccerPitchConfiguration:
    """Minimal API-compatible stand-in for `sports.configs.soccer.SoccerPitchConfiguration`.

    Carries the pitch dimensions in centimetres (``length`` along the long axis,
    ``width`` across) and exposes a ``.vertices`` list of ``(x_cm, y_cm)`` landmark
    keypoints. v2's tests only need ``length``/``width``; ``vertices`` is provided
    for completeness (corners, goal-line midpoints, halfway-line endpoints, centre,
    and the two penalty spots).
    """

    length: int = 12000   # cm, along the long (touchline-to-touchline length) axis
    width: int = 7000     # cm, across the short axis

    @property
    def vertices(self) -> list[tuple[int, int]]:
        l, w = self.length, self.width
        penalty_spot = 1100   # cm from the goal line
        return [
            (0, 0), (0, w // 2), (0, w),                 # left goal line: corners + mid
            (l // 2, 0), (l // 2, w // 2), (l // 2, w),  # halfway line: ends + centre
            (l, 0), (l, w // 2), (l, w),                 # right goal line: corners + mid
            (penalty_spot, w // 2),                      # left penalty spot
            (l - penalty_spot, w // 2),                  # right penalty spot
        ]
