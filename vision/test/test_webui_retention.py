# vision/test/test_webui_retention.py
#
# Retention for `out/` and the location of the attestation ledger (audit §6 "Vision": *no
# retention/TTL (`out/` = 51 MB after 3 jobs) · attestation ledger lives INSIDE the prunable
# directory*).
#
# TWO RULES, AND THE SECOND IS WHY THE FIRST IS DANGEROUS ON ITS OWN.
#
# (1) Every job directory holds a downloaded source clip plus a re-encoded derivative of it. Nothing
#     ever removed them; `out/` measured 51 MB after three short jobs, and the tool's whole privacy
#     posture is "footage stays local and does not accumulate". Retention is the mechanism that makes
#     that true rather than aspirational — the same argument ADR-0010 makes for the telemetry store.
#
# (2) The ledger — the ONLY record of which link was processed under which attestation — lived at
#     `out/_attestations.jsonl`, i.e. inside the directory retention is about to start deleting. A
#     prune that also erases the compliance record would leave the tool provably unable to answer
#     "what did you process?", which is precisely what an attestation exists to answer. So the ledger
#     moves OUT of `out/` first, and a test pins it there.

import json
import time
from pathlib import Path

from webui import retention
from webui import server as srv


def _job_dir(root: Path, name: str, age_hours: float) -> Path:
    d = root / name
    d.mkdir(parents=True)
    (d / "clip.mp4").write_bytes(b"source footage")
    (d / "annotated.mp4").write_bytes(b"derived")
    old = time.time() - age_hours * 3600
    for p in list(d.iterdir()) + [d]:
        import os
        os.utime(p, (old, old))
    return d


# ---- (2) the ledger is not inside the prunable directory ------------------------------------

def test_the_ledger_lives_outside_the_pruned_directory():
    ledger, out_root = srv.LEDGER.resolve(), srv.OUT_ROOT.resolve()
    assert out_root not in ledger.parents, (
        f"the attestation ledger {ledger} is inside {out_root}, which retention deletes")


def test_prune_never_touches_the_ledger_even_if_it_is_pointed_inside(tmp_path):
    """Defence in depth: if someone re-points FT_LEDGER_PATH back into out/, the prune must still
    refuse to delete it rather than silently erasing the compliance record."""
    out = tmp_path / "out"
    out.mkdir()
    ledger = out / "_attestations.jsonl"
    ledger.write_text(json.dumps({"job": "old"}) + "\n")
    import os
    old = time.time() - 999 * 3600
    os.utime(ledger, (old, old))
    _job_dir(out, "stale", age_hours=999)

    retention.prune_out(out, ttl_hours=24, ledger=ledger)

    assert ledger.exists(), "retention deleted the attestation ledger"
    assert not (out / "stale").exists()


# ---- (1) TTL prune --------------------------------------------------------------------------

def test_prune_removes_expired_job_directories_and_keeps_fresh_ones(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    _job_dir(out, "stale", age_hours=48)
    _job_dir(out, "fresh", age_hours=1)

    removed = retention.prune_out(out, ttl_hours=24, ledger=tmp_path / "var" / "led.jsonl")

    assert [p.name for p in removed] == ["stale"]
    assert not (out / "stale").exists()
    assert (out / "fresh" / "annotated.mp4").exists()


def test_prune_removes_the_source_clip_too_not_just_the_derivative(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    d = _job_dir(out, "stale", age_hours=48)
    retention.prune_out(out, ttl_hours=24, ledger=tmp_path / "led.jsonl")
    assert not (d / "clip.mp4").exists() and not d.exists()


def test_prune_is_a_no_op_on_a_missing_or_empty_directory(tmp_path):
    assert retention.prune_out(tmp_path / "absent", ttl_hours=24, ledger=tmp_path / "l") == []
    (tmp_path / "empty").mkdir()
    assert retention.prune_out(tmp_path / "empty", ttl_hours=24, ledger=tmp_path / "l") == []


def test_prune_ignores_loose_files_at_the_root_of_out(tmp_path):
    """Only job DIRECTORIES are job data. A file sitting directly in out/ is something a person
    put there; deleting it is not this function's business."""
    out = tmp_path / "out"
    out.mkdir()
    loose = out / "notes.md"
    loose.write_text("mine")
    import os
    old = time.time() - 999 * 3600
    os.utime(loose, (old, old))
    assert retention.prune_out(out, ttl_hours=24, ledger=tmp_path / "l") == []
    assert loose.exists()


def test_ttl_of_zero_or_less_disables_pruning(tmp_path):
    """An operator who wants to keep everything sets FT_OUT_TTL_HOURS=0; that must mean 'off',
    not 'delete everything immediately', which is the failure mode of a naive `age > ttl`."""
    out = tmp_path / "out"
    out.mkdir()
    _job_dir(out, "stale", age_hours=9999)
    assert retention.prune_out(out, ttl_hours=0, ledger=tmp_path / "l") == []
    assert (out / "stale").exists()


def test_prune_survives_an_undeletable_entry_and_still_removes_the_rest(tmp_path, monkeypatch):
    """A prune runs on every job start. One directory it cannot remove — a stale NFS handle, a file
    another process still holds open, a permission the container lost — must not abort the sweep and
    leave every later expired job on disk forever."""
    import shutil

    out = tmp_path / "out"
    out.mkdir()
    _job_dir(out, "stale-a", age_hours=48)
    _job_dir(out, "stale-b", age_hours=48)

    real_rmtree = shutil.rmtree

    def flaky(path, *a, **kw):
        if Path(path).name == "stale-a":
            raise PermissionError("held open")
        return real_rmtree(path, *a, **kw)

    monkeypatch.setattr(retention.shutil, "rmtree", flaky)
    removed = retention.prune_out(out, ttl_hours=24, ledger=tmp_path / "l")

    assert [p.name for p in removed] == ["stale-b"]
    assert (out / "stale-a").exists()
