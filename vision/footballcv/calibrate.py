# vision/footballcv/calibrate.py
from dataclasses import dataclass
from pathlib import Path
import numpy as np
import cv2
import yaml

GOOD_PX_THRESHOLD = 5.0     # held-out reprojection error ceiling near the named region (§7.2, seed)


@dataclass
class Grade:
    held_out_px_error: float   # mean reprojection error on the HELD-OUT points (px)
    verdict: str               # "GOOD" | "RE-PICK"
    ill_conditioned: bool      # near-collinear / small-hull point set
    reason: str


def _convex_hull_area(pts: np.ndarray) -> float:
    hull = cv2.convexHull(pts.astype(np.float32))
    return float(cv2.contourArea(hull))


MIN_HULL_AREA_PX = 2000.0   # absolute convex-hull floor (px^2); see (c) below


def point_set_is_degenerate(image_points: np.ndarray, *, min_hull_frac: float = 0.02,
                            min_collinearity: float = 0.15) -> tuple[bool, str]:
    """Reject sets that make H ill-conditioned (§7.2): (a) near-collinear (the points'
    spread is essentially 1-D), (b) a small convex hull relative to their bounding box, or
    (c) an absolutely tiny convex hull (centre-clustered -> confidently-wrong far side)."""
    pts = np.asarray(image_points, np.float32)
    if len(pts) < 4:
        return True, "need >= 4 points"
    # (a) collinearity: ratio of the smaller to larger PCA singular value of the centred set
    centred = pts - pts.mean(axis=0)
    sv = np.linalg.svd(centred, compute_uv=False)
    spread_ratio = float(sv[1] / sv[0]) if sv[0] > 0 else 0.0
    if spread_ratio < min_collinearity:
        return True, f"near-collinear (spread ratio {spread_ratio:.3f} < {min_collinearity})"
    hull_area = _convex_hull_area(pts)
    # (b) small convex hull vs bounding box (relative)
    bbox = (pts[:, 0].max() - pts[:, 0].min()) * (pts[:, 1].max() - pts[:, 1].min())
    hull_frac = hull_area / bbox if bbox > 0 else 0.0
    if hull_frac < min_hull_frac:
        return True, f"small convex hull (hull frac {hull_frac:.3f} < {min_hull_frac})"
    # (c) absolutely tiny convex hull = centre-clustered blob. The relative (b) check alone
    # passes a tight blob whose hull still fills its own tiny bbox; an absolute floor catches
    # it (deviation from the plan: (b) was insufficient for the centre-cluster fixture).
    if hull_area < MIN_HULL_AREA_PX:
        return True, f"small convex hull (hull area {hull_area:.0f} px^2 < {MIN_HULL_AREA_PX:.0f})"
    return False, "ok"


def grade_calibration(image_points: np.ndarray, pitch_points: np.ndarray, *,
                      n_fit: int = 4) -> Grade:
    """Fit H on the first n_fit correspondences, measure reprojection error on the REST
    (held-out, §7.2). Reprojecting the fit points is ~0 by construction and proves nothing."""
    img = np.asarray(image_points, np.float32)
    pit = np.asarray(pitch_points, np.float32)
    degenerate, reason = point_set_is_degenerate(img)
    if degenerate:
        return Grade(held_out_px_error=float("inf"), verdict="RE-PICK",
                     ill_conditioned=True, reason=reason)
    if len(img) <= n_fit:
        raise ValueError(f"need > {n_fit} points so some are held out for validation")
    H, _ = cv2.findHomography(img[:n_fit], pit[:n_fit], cv2.RANSAC)
    if H is None:
        return Grade(float("inf"), "RE-PICK", True, "findHomography failed (degenerate fit)")
    held_img, held_pit = img[n_fit:], pit[n_fit:]
    # Error reported in PIXELS at the held-out points: map the KNOWN held-out pitch coords
    # back to image via H^-1 and compare to the ACTUAL held-out image points. (Deviation from
    # the plan: the plan's round-trip `H` then `H^-1` of the same image point is identity by
    # construction and always reports ~0 — it never sees a corrupted held-out correspondence.)
    Hinv = np.linalg.inv(H)
    pred_img = cv2.perspectiveTransform(held_pit.reshape(-1, 1, 2), Hinv).reshape(-1, 2)
    px_err = float(np.linalg.norm(pred_img - held_img, axis=1).mean())
    verdict = "GOOD" if px_err <= GOOD_PX_THRESHOLD else "RE-PICK"
    return Grade(held_out_px_error=px_err, verdict=verdict,
                 ill_conditioned=False, reason="ok" if verdict == "GOOD" else "held-out error high")


def write_calibration(out_path: Path, image_points, pitch_points) -> dict:
    data = {"image_points": np.asarray(image_points, float).tolist(),
            "pitch_points": np.asarray(pitch_points, float).tolist()}
    Path(out_path).write_text(yaml.safe_dump(data, sort_keys=False))
    return data


def _pick_points_interactive(frame, at):
    """OpenCV-window click picker (not unit-tested; exercised at the acceptance run).
    Click >= 6 well-separated pitch landmarks; type the matching pitch (cm) coords at the
    prompt. Returns (image_points, pitch_points). Verify cv2.setMouseCallback usage on-box."""
    raise NotImplementedError("interactive picker — run via `python -m footballcv.calibrate`")


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser("footballcv.calibrate")
    ap.add_argument("--frame", required=True)
    ap.add_argument("--at", default="00:00:30")
    ap.add_argument("--out", default="config/calibration.yaml")
    args = ap.parse_args(argv)
    cap = cv2.VideoCapture(args.frame)
    # seek to --at, grab one frame, pick points (interactive)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        print("could not read a frame")
        return 2
    image_points, pitch_points = _pick_points_interactive(frame, args.at)
    g = grade_calibration(np.array(image_points), np.array(pitch_points))
    print(f"held-out reprojection error = {g.held_out_px_error:.2f} px -> {g.verdict}"
          f"{'' if not g.ill_conditioned else ' (ILL-CONDITIONED: ' + g.reason + ')'}")
    if g.verdict != "GOOD":
        print("RE-PICK: choose more spread-out, non-collinear landmarks (§7.2).")
        return 1
    write_calibration(Path(args.out), image_points, pitch_points)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
