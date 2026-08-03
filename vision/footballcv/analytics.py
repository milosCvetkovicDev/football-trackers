# vision/footballcv/analytics.py
#
# v3 analytics — pure, deterministic, numpy + cv2 + stdlib only. Consumes a list[WorldState]
# (pitch-space filled by v2's PitchProjector) and emits stats.json (§7.4) + summary.txt.
# Makes NO network calls; NO player name ever enters stats.json (numeric track_id + team only).
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import cv2
from footballcv.types import WorldState, PlayerObs, BallObs

LOW_BALL_KNOWN_FRACTION = 0.7        # below this, possession split is "low" confidence (§7.3)

def _is_real_ball(ball: BallObs) -> bool:
    return ball.pitch_xy is not None and not ball.interpolated

def ball_known_fraction(states) -> float:
    if not states:
        return 0.0
    known = sum(1 for s in states if _is_real_ball(s.ball))
    return known / len(states)

def nearest_team(ball_xy, players, *, assign_radius_cm: float) -> int | None:
    """Nearest NON-GK player (team 0/1) within assign_radius_cm of the ball, in pitch cm.
    GKs (cls=='goalkeeper') and referees (team is None) are excluded (§7.3)."""
    if ball_xy is None:
        return None
    best_team, best_d = None, assign_radius_cm
    for p in players:
        if p.cls == "goalkeeper" or p.team not in (0, 1) or p.pitch_xy is None:
            continue
        d = float(np.hypot(p.pitch_xy[0] - ball_xy[0], p.pitch_xy[1] - ball_xy[1]))
        if d <= best_d:
            best_team, best_d = p.team, d
    return best_team

def in_near_zone(ball_xy, near_zone) -> bool:
    """near_zone = (y_min_cm, y_max_cm) on the WIDTH axis (pitch_xy[1]); None => whole pitch.
    The width band where reprojection error stays <= ~1.5 m (§7.2/§7.3) — the caller sets it
    from the calibration; far-side frames are reported 'not computed', never a biased number."""
    if near_zone is None or ball_xy is None:
        return True
    return near_zone[0] <= ball_xy[1] <= near_zone[1]

def possession(states, *, assign_radius_cm: float = 300.0, near_zone=None) -> dict:
    counts = {0: 0, 1: 0}
    assigned = far_not_computed = 0
    for s in states:
        if not _is_real_ball(s.ball):
            continue                                  # interpolated/missing => undefined (§7.3)
        if not in_near_zone(s.ball.pitch_xy, near_zone):
            far_not_computed += 1
            continue                                  # far side => not computed (structured bias)
        t = nearest_team(s.ball.pitch_xy, s.players, assign_radius_cm=assign_radius_cm)
        if t is not None:
            counts[t] += 1
            assigned += 1
    total = counts[0] + counts[1]
    t0 = 100.0 * counts[0] / total if total else 0.0
    t1 = 100.0 * counts[1] / total if total else 0.0
    bkf = ball_known_fraction(states)
    return {
        "team0_pct": t0, "team1_pct": t1,
        "confidence": "low" if bkf < LOW_BALL_KNOWN_FRACTION else "ok",
        "ball_known_fraction": bkf,
        "zone": "all" if near_zone is None else "near_centre_only",
        "far_side": "computed" if near_zone is None else "not_computed",
        "assign_radius_m": assign_radius_cm / 100.0,
        "assigned_frames": assigned, "far_not_computed_frames": far_not_computed,
    }


# --- Task 2: distance & speed (per raw track_id, with the three §7.3 guards) ---

def moving_average(xy_seq, *, window: int):
    """Edge-clamped centred moving average over a (N,2) sequence. window<=1 => identity."""
    pts = np.asarray(xy_seq, float)
    if window <= 1 or len(pts) < 2:
        return [tuple(p) for p in pts]
    half = window // 2
    out = []
    for i in range(len(pts)):
        lo, hi = max(0, i - half), min(len(pts), i + half + 1)
        out.append(tuple(pts[lo:hi].mean(axis=0)))
    return out

def sustained_peak_speed_ms(positions_cm, ts, *, min_window_s: float = 0.3) -> float:
    """Max average speed (m/s) over any window spanning >= min_window_s (§7.3: never a single
    inter-frame delta). Distance in cm -> m via /100; time in s."""
    pts = np.asarray(positions_cm, float)
    t = np.asarray(ts, float)
    n = len(pts)
    if n < 2:
        return 0.0
    # cumulative path length (cm) so any window's covered distance is a difference
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    best = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            dt = t[j] - t[i]
            if dt >= min_window_s:
                speed = (cum[j] - cum[i]) / 100.0 / dt
                best = max(best, speed)
                break                  # smallest window >= min_window_s from i; longer only dilutes
    return best

def player_distance_speed(track, *, move_floor_cm: float = 150.0, smooth_window: int = 3,
                          max_speed_ceiling_ms: float = 10.0) -> dict:
    """track = time-ordered [(frame_ts, (x_cm,y_cm))] for ONE id. Three §7.3 guards:
    smoothing before differencing, a per-step noise floor, and a max-speed clamp (outliers
    dropped from the distance sum AND counted). Distance is a noise-floored LOWER BOUND."""
    if len(track) < 2:
        return {"distance_m": 0.0, "distance_is_lower_bound": True,
                "max_speed_ms": 0.0, "clamped_outlier_segments": 0}
    ts = [t for t, _ in track]
    sm = moving_average([xy for _, xy in track], window=smooth_window)
    dist_cm, clamped = 0.0, 0
    kept_pts, kept_ts = [sm[0]], [ts[0]]
    for i in range(1, len(sm)):
        step = float(np.hypot(sm[i][0] - sm[i-1][0], sm[i][1] - sm[i-1][1]))
        dt = ts[i] - ts[i-1]
        speed = (step / 100.0) / dt if dt > 0 else 0.0
        if speed > max_speed_ceiling_ms:
            clamped += 1                          # tracking error: drop it, don't fabricate (lower bound)
            continue
        if step < move_floor_cm:
            kept_pts.append(sm[i]); kept_ts.append(ts[i])
            continue                              # below noise floor: no distance, but keep position
        dist_cm += step
        kept_pts.append(sm[i]); kept_ts.append(ts[i])
    peak = sustained_peak_speed_ms(kept_pts, kept_ts, min_window_s=0.3)
    return {"distance_m": dist_cm / 100.0, "distance_is_lower_bound": True,
            "max_speed_ms": peak, "clamped_outlier_segments": clamped}

def per_player_metrics(states, *, move_floor_cm: float = 150.0, smooth_window: int = 3,
                       max_speed_ceiling_ms: float = 10.0) -> dict:
    tracks: dict = {}
    teams: dict = {}
    for s in states:
        for p in s.players:
            if p.pitch_xy is None or p.cls == "goalkeeper":
                continue                          # GKs excluded from outfield distance too (consistency)
            tracks.setdefault(p.track_id, []).append((s.frame_ts, p.pitch_xy))
            teams.setdefault(p.track_id, p.team)
    out = {}
    for tid, tr in tracks.items():
        tr.sort(key=lambda r: r[0])
        m = player_distance_speed(tr, move_floor_cm=move_floor_cm, smooth_window=smooth_window,
                                  max_speed_ceiling_ms=max_speed_ceiling_ms)
        m["team"] = teams[tid]
        out[tid] = m
    return out


# --- Task 3: possession changes — heuristic, opt-in (renamed from "passes", §7.3) ---

def possession_changes(states, *, assign_radius_cm: float = 300.0, min_travel_cm: float = 500.0,
                       near_zone=None) -> dict:
    """Heuristic 'possession changes' (renamed from passes, §7.3). Single-camera cannot see an
    opponent touch, so this counts same-team possessor changes with ball travel >= min_travel_cm
    between two ASSIGNED frames. The weakest metric; opt-in at the report layer."""
    last = None   # (track_id, team, ball_xy)
    count = 0
    for s in states:
        if not _is_real_ball(s.ball) or not in_near_zone(s.ball.pitch_xy, near_zone):
            continue
        team = nearest_team(s.ball.pitch_xy, s.players, assign_radius_cm=assign_radius_cm)
        if team is None:
            continue
        # which non-GK player of that team is nearest = the possessor id
        pid = min(((float(np.hypot(p.pitch_xy[0]-s.ball.pitch_xy[0], p.pitch_xy[1]-s.ball.pitch_xy[1])), p.track_id)
                   for p in s.players if p.team == team and p.cls != "goalkeeper" and p.pitch_xy is not None),
                  default=(None, None))[1]
        if last is not None and pid is not None and pid != last[0] and team == last[1]:
            travel = float(np.hypot(s.ball.pitch_xy[0]-last[2][0], s.ball.pitch_xy[1]-last[2][1]))
            if travel >= min_travel_cm:
                count += 1
        if pid is not None:
            last = (pid, team, s.ball.pitch_xy)
    return {"count": count, "min_travel_m": min_travel_cm / 100.0, "heuristic": True,
            "note": "renamed from 'passes'; single-camera, no opponent-touch detection; weakest metric"}


# --- Task 4: team shape per time bucket (centroid / hull-area / spread; GKs excluded) ---

def convex_hull_area_m2(points_cm) -> float:
    pts = np.asarray(points_cm, np.float32)
    if len(pts) < 3:
        return 0.0
    hull = cv2.convexHull(pts)
    return float(cv2.contourArea(hull)) / 10000.0      # cm^2 -> m^2

def _spread_m(points_cm) -> float:
    pts = np.asarray(points_cm, float)
    if len(pts) < 2:
        return 0.0
    c = pts.mean(axis=0)
    return float(np.linalg.norm(pts - c, axis=1).mean()) / 100.0   # mean radial dist, cm -> m

def team_shape_series(states, team: int, *, bucket_s: float = 5.0) -> list:
    """Per time bucket: centroid (cm) / convex-hull area (m^2) / spread (m) over the team's
    non-GK players. Within a bucket each track_id contributes its MEAN position (so a stationary
    player counts once, not once per sampled frame) -> n is the unique-player count (§7.3)."""
    if not states:
        return []
    t0 = states[0].frame_ts
    buckets: dict = {}                       # bucket -> {track_id -> [pitch_xy, ...]}
    for s in states:
        b = int((s.frame_ts - t0) // bucket_s)
        for p in s.players:
            if p.team != team or p.cls == "goalkeeper" or p.pitch_xy is None:
                continue
            buckets.setdefault(b, {}).setdefault(p.track_id, []).append(p.pitch_xy)
    series = []
    for b in sorted(buckets):
        pts = np.asarray([np.mean(samples, axis=0) for samples in buckets[b].values()], float)
        series.append({"t_s": t0 + b * bucket_s,
                       "centroid_cm": [float(pts[:, 0].mean()), float(pts[:, 1].mean())],
                       "hull_area_m2": convex_hull_area_m2(pts),
                       "spread_m": _spread_m(pts), "n": int(len(pts))})
    return series


# --- Task 5: assemble stats.json (§7.4 schema) ---

def build_stats(states, *, clip_meta: dict, provenance: dict, assign_radius_cm: float = 300.0,
                near_zone=None, move_floor_cm: float = 150.0, smooth_window: int = 3,
                max_speed_ceiling_ms: float = 10.0, bucket_s: float = 5.0, passes: bool = False) -> dict:
    poss = possession(states, assign_radius_cm=assign_radius_cm, near_zone=near_zone)
    pm = per_player_metrics(states, move_floor_cm=move_floor_cm, smooth_window=smooth_window,
                            max_speed_ceiling_ms=max_speed_ceiling_ms)
    stats = {
        "schema_version": 1,
        "clip": clip_meta,
        "provenance": {**provenance, "ids": provenance.get("ids", "raw"),
                       "heuristic": provenance.get("heuristic", True)},
        "possession": {
            "team0_pct": round(poss["team0_pct"], 1), "team1_pct": round(poss["team1_pct"], 1),
            "confidence": poss["confidence"], "ball_known_fraction": round(poss["ball_known_fraction"], 3),
            "zone": "near_centre_only" if near_zone is not None else "all",
            "far_side": poss["far_side"], "assign_radius_m": poss["assign_radius_m"]},
        "teams": {str(t): {"label": ("left-at-kickoff" if t == 0 else "right-at-kickoff"),
                           "shape": team_shape_series(states, t, bucket_s=bucket_s)} for t in (0, 1)},
        "players": [{"id": tid, "team": m["team"], "distance_m": round(m["distance_m"], 1),
                     "distance_is_lower_bound": True, "max_speed_ms": round(m["max_speed_ms"], 1),
                     "clamped_outlier_segments": m["clamped_outlier_segments"]}
                    for tid, m in sorted(pm.items())],
    }
    if passes:
        ch = possession_changes(states, assign_radius_cm=assign_radius_cm, near_zone=near_zone)
        stats["possession_changes"] = {**ch, "opt_in": True}
    return stats


# --- Task 6: summary.txt + write_stats ---

def write_summary(stats: dict) -> str:
    p = stats["possession"]
    lines = [
        f"Clip: {stats['clip'].get('source','?')}  "
        f"({stats['clip'].get('frames_analysed','?')} frames @ {stats['clip'].get('sample_fps','?')} fps)",
        f"Possession (near-centre only): T0 {p['team0_pct']}%  T1 {p['team1_pct']}%   "
        f"[confidence={p['confidence']}, ball_known={p['ball_known_fraction']}, far_side={p['far_side']}]",
        "",
        "Per-player (distances are NOISE-FLOORED LOWER BOUNDS, not true totals):",
    ]
    for pl in stats["players"]:
        lines.append(f"  #{pl['id']} T{pl['team']}: dist~{pl['distance_m']} m (lower bound), "
                     f"peak {pl['max_speed_ms']} m/s, clamped {pl['clamped_outlier_segments']}")
    if "possession_changes" in stats:
        c = stats["possession_changes"]
        lines += ["", f"Possession changes (HEURISTIC, single-camera): {c['count']}  "
                      f"(min travel {c['min_travel_m']} m) — weakest metric, not 'passes'"]
    lines += ["", "All metrics are movement-derived, UNVALIDATED heuristics (no ground truth). "
                  "Metrics key on RAW track ids: a player re-appearing after occlusion gets a new id."]
    return "\n".join(lines)

def write_stats(stats: dict, out_dir: str) -> tuple:
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    sj, st = out / "stats.json", out / "summary.txt"
    sj.write_text(json.dumps(stats, indent=2))
    st.write_text(write_summary(stats))
    return str(sj), str(st)
