# vision/test/test_pipeline_stubs.py
#
# v2/v3 must FAIL LOUDLY rather than report success (audit §6 "Vision": `run_v2`/`run_v3` are `...`
# stubs returning success).
#
# WHY THIS IS WORTH ITS OWN FILE. A bare `...` in a function body is not a no-op with a warning —
# it is a no-op that returns a well-formed result dict and exit code 0. `--ball` therefore printed
# nothing, wrote nothing, and looked exactly like a fast successful run; the caller's only clue was
# an `out/` directory that never gained a radar.mp4. The web UI's own `collect_outputs` would have
# reported "obrada je prošla ali nije proizvela izlazni snimak" — blaming the encode for a stage that
# was never written. An unimplemented feature must be indistinguishable from a broken one at the
# EXIT CODE, which is the only thing a script, a cron or a CI step reads.
#
# The stub refusal must also come BEFORE any model resolution, so it is deterministic on a machine
# with no weights (CI has none — models/ is gitignored) AND on one with them. Passing a models_dir
# that does not exist is how each test below discriminates "refused as unimplemented" from
# "happened to fail at the manifest".

import pytest

from footballcv.pipeline import NotImplementedStage, main, run_v2, run_v3
from footballcv.types import BallObs, PlayerObs, WorldState


def test_run_v2_refuses_instead_of_returning_a_hollow_success(tmp_path):
    with pytest.raises(NotImplementedStage) as ei:
        run_v2("clip.mp4", str(tmp_path), device="cpu", models_dir=str(tmp_path / "nope"))
    msg = str(ei.value)
    assert "v2" in msg
    assert "radar" in msg.lower() or "ball" in msg.lower()


def test_run_v2_refuses_before_touching_the_models_dir(tmp_path):
    """A nonexistent models_dir would raise IntegrityError if the manifest were read first.
    Getting NotImplementedStage instead proves the refusal is the FIRST thing that happens."""
    from footballcv.models_io import IntegrityError

    with pytest.raises(NotImplementedStage) as ei:
        run_v2("clip.mp4", str(tmp_path), models_dir=str(tmp_path / "definitely-absent"))
    assert not isinstance(ei.value, IntegrityError)


def test_run_v3_refuses_when_it_would_have_to_build_the_stream(tmp_path):
    with pytest.raises(NotImplementedStage):
        run_v3("clip.mp4", str(tmp_path), models_dir=str(tmp_path / "definitely-absent"))


def test_run_v3_still_works_on_injected_world_states(tmp_path):
    """The v3 ANALYTICS half is real and tested (test_pipeline_v3.py). Only the live
    detect/track/project loop is missing, so the injected-states path must keep working —
    this is the guard against 'fix' the stub by refusing everything."""
    states = [
        WorldState(i, i / 5.0, "raw",
                   [PlayerObs(7, "player", 0, (0, 0, 1, 1), (3000.0 + 50 * i, 3500.0), 0.9),
                    PlayerObs(8, "player", 1, (0, 0, 1, 1), (9000.0, 3500.0), 0.9)],
                   BallObs((0, 0), (3010.0 + 50 * i, 3500.0), 0.8, False))
        for i in range(10)
    ]
    out = run_v3("ignored.mp4", str(tmp_path), world_states=states, device="cpu", sample_fps=5.0)
    assert (tmp_path / "stats.json").exists()
    assert out["stats_frames"] == 10


# ---- the CLI contract: the exit code is what a script actually reads ------------------------

@pytest.mark.parametrize("flag", ["--ball", "--radar", "--stats"])
def test_unimplemented_flags_exit_non_zero(flag, tmp_path, capsys):
    rc = main(["--input", "clip.mp4", "--out", str(tmp_path), "--device", "cpu",
               "--models-dir", str(tmp_path / "definitely-absent"), flag])
    assert rc != 0, f"{flag} reported success while doing nothing"
    err = capsys.readouterr().err
    assert "not implemented" in err.lower(), f"the refusal must say why, got: {err!r}"


def test_unimplemented_flags_write_nothing(tmp_path):
    out = tmp_path / "out"
    main(["--input", "clip.mp4", "--out", str(out), "--device", "cpu",
          "--models-dir", str(tmp_path / "definitely-absent"), "--ball"])
    # A refused run must not leave a half-built artifact directory behind for `collect_outputs`
    # (or a person) to interpret as a completed job.
    assert not out.exists() or not any(out.iterdir())


def test_selftest_still_exits_zero(capsys):
    assert main(["--selftest"]) == 0
    assert "selftest OK" in capsys.readouterr().out
