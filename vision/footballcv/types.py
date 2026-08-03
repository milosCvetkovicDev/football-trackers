from dataclasses import dataclass

@dataclass
class PlayerObs:
    track_id: int            # stable id from track (raw) / stitch (v3)
    cls: str                 # "player" | "goalkeeper" | "referee"
    team: int | None         # 0|1 for players/GK; None for referee. ANCHORED + stable per clip (§7.1)
    image_bbox: tuple        # (x1, y1, x2, y2) in source pixels
    pitch_xy: tuple | None   # (x_cm, y_cm); None pre-homography (always None in v1)
    confidence: float

@dataclass
class BallObs:
    image_xy: tuple | None
    pitch_xy: tuple | None
    confidence: float
    interpolated: bool

@dataclass
class WorldState:
    frame_idx: int
    frame_ts: float          # seconds from clip start
    track_id_space: str      # 'raw' | 'stitched' — analytics asserts its precondition
    players: list[PlayerObs]
    ball: BallObs
