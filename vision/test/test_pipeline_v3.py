# vision/test/test_pipeline_v3.py
import ast, json, os
from pathlib import Path
from footballcv.types import PlayerObs, BallObs, WorldState

PIPE = Path(__file__).resolve().parents[1] / "footballcv" / "pipeline.py"

def test_pipeline_v3_does_not_import_fetch_models():
    tree = ast.parse(PIPE.read_text())
    mods = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import): mods |= {a.name for a in n.names}
        if isinstance(n, ast.ImportFrom): mods.add(n.module or "")
    assert not any("fetch_models" in m for m in mods)

def test_run_v3_writes_stats_from_injected_world_states(tmp_path):
    from footballcv.pipeline import run_v3
    states = []
    for i in range(10):
        states.append(WorldState(i, i / 5.0, "raw",
            [PlayerObs(7, "player", 0, (0,0,1,1), (3000.0 + 50*i, 3500.0), 0.9),
             PlayerObs(8, "player", 1, (0,0,1,1), (9000.0, 3500.0), 0.9)],
            BallObs((0,0), (3010.0 + 50*i, 3500.0), 0.8, False)))
    out = run_v3("ignored.mp4", str(tmp_path), world_states=states,
                 device="cpu", sample_fps=5.0, passes=True)
    sj = os.path.join(str(tmp_path), "stats.json")
    assert os.path.exists(sj)
    stats = json.loads(open(sj).read())
    assert stats["schema_version"] == 1 and stats["provenance"]["ids"] == "raw"
    assert "possession_changes" in stats                       # passes=True
    assert out["out"] == str(tmp_path)
