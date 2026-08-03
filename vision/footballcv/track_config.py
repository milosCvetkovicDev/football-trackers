from pathlib import Path
import yaml

# ~3 s horizon expressed in frames, pinned to the tracker's actual fps (ADR §5).
TARGET_BUFFER_SECONDS = 3.0
OVERRIDES = {"with_reid": False, "gmc_method": "none",
             "match_thresh": 0.75, "new_track_thresh": 0.4}

def build_botsort_config(installed_yaml: dict, tracker_fps: float) -> dict:
    cfg = dict(installed_yaml)               # start from installed defaults
    cfg.update(OVERRIDES)
    cfg["track_buffer"] = round(TARGET_BUFFER_SECONDS * tracker_fps)
    return cfg

def write_botsort_config(out_path: Path, installed_yaml_path: Path | None,
                         tracker_fps: float) -> dict:
    if installed_yaml_path is None:
        from ultralytics.utils import ROOT          # verify path vs installed ultralytics
        installed_yaml_path = ROOT / "cfg/trackers/botsort.yaml"
    installed = yaml.safe_load(Path(installed_yaml_path).read_text())
    cfg = build_botsort_config(installed, tracker_fps)
    Path(out_path).write_text(yaml.safe_dump(cfg, sort_keys=False))
    return cfg
