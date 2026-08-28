# vision/test/test_samples_manifest.py
#
# The clip-provenance ledger (audit Q-1: *`samples.manifest.jsonl` is 0 bytes while `samples/` holds
# 3 clips — and the test that guards it passes VACUOUSLY on an empty file, so the control cannot fail
# in the one state where it matters*).
#
# WHAT THE CONTROL IS FOR. ADR-0023 §3 makes clip selection default-deny: a clip may enter `samples/`
# only once its competition is positively identified as adult/senior, and the identification is
# recorded in this committed file — deliberately NOT a note inside the gitignored `samples/`, which
# the §10 prune would delete. It is the subproject's entire answer to "how do you know there are no
# children in your training and test footage?", and the answer has to survive the footage.
#
# WHY THE OLD TEST COULD NOT FAIL. It iterated the file's lines and asserted required fields on each
# one. Zero lines means zero assertions: a green check over an empty ledger next to three
# unattested clips. A ledger guard has to assert COVERAGE — every clip on disk is accounted for —
# not merely that whatever rows exist are well-formed. Content-addressed, because a filename can be
# reused: `samples/clip.mp4` was replaced at least twice over this project's life.

import hashlib
import json
from pathlib import Path

import pytest

V = Path(__file__).resolve().parents[1]
MANIFEST = V / "samples.manifest.jsonl"
SAMPLES = V / "samples"
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".ogv", ".avi", ".360", ".m4v"}
PLACEHOLDER = {"", "tbd", "unknown", "n/a", "todo", "<fill>", "?"}


def _rows():
    return [json.loads(l) for l in MANIFEST.read_text().splitlines() if l.strip()]


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---- the vacuity fix: the file itself has to say something ------------------------------------

def test_the_manifest_is_not_empty():
    """The exact state the previous guard was green in."""
    assert _rows(), (
        "samples.manifest.jsonl is empty. It is the default-deny record required by ADR-0023 §3; "
        "an empty one means either there are no clips or nobody recorded them, and the guard "
        "cannot tell those apart.")


def test_every_row_is_well_formed():
    for row in _rows():
        for k in ("file", "sha256", "kind", "source", "date"):
            assert row.get(k), f"row for {row.get('file')!r} is missing {k}"
        assert row["kind"] in ("public_adult", "synthetic"), row["kind"]
        assert len(row["sha256"]) == 64, row["file"]
        assert str(row["source"]).strip().lower() not in PLACEHOLDER, row["file"]


def test_footage_rows_carry_a_positively_identified_adult_competition():
    for row in _rows():
        if row["kind"] != "public_adult":
            continue
        assert row.get("adult_senior_confirmed") is True, row["file"]
        comp = str(row.get("competition", "")).strip().lower()
        assert comp not in PLACEHOLDER, (
            f"{row['file']} claims adult_senior_confirmed with competition={comp!r} — "
            "'confirmed' with nothing named is the ambiguous-footage case ADR-0023 §3 denies")


def test_synthetic_rows_declare_that_they_contain_no_people():
    """A generated fixture needs no age attestation because it has no humans in it — but that has
    to be an assertion in the row, not an assumption in a reader's head, or `kind: synthetic`
    becomes a way to skip the gate."""
    for row in _rows():
        if row["kind"] == "synthetic":
            assert row.get("contains_people") is False, row["file"]


def test_no_two_rows_describe_the_same_bytes():
    shas = [r["sha256"] for r in _rows()]
    assert len(shas) == len(set(shas)), "duplicate sha256 rows"


# ---- the coverage assertion: what the audit actually asked for ---------------------------------

def test_every_clip_in_samples_is_attested():
    """The control that matters. Content-addressed: a row attests BYTES, not a name."""
    if not SAMPLES.exists():
        pytest.skip("samples/ is gitignored and absent here (CI) — coverage is a local-tree check")
    on_disk = {p: _sha256(p) for p in sorted(SAMPLES.rglob("*"))
               if p.is_file() and p.suffix.lower() in VIDEO_SUFFIXES}
    if not on_disk:
        pytest.skip("no clips in samples/")
    attested = {r["sha256"] for r in _rows()}
    missing = sorted(str(p.relative_to(V)) for p, sha in on_disk.items() if sha not in attested)
    assert not missing, (
        "clips in samples/ with no provenance row:\n  " + "\n  ".join(missing) +
        "\n\nADR-0023 §3 is default-deny: a clip whose competition/age cannot be positively "
        "identified as adult/senior is DISCARDED, not kept unattested. Record it with\n"
        "  python samples_manifest.py add --file samples/<clip> --kind public_adult "
        "--source <url> --competition <league> --date <YYYY-MM-DD>\n"
        "or remove the clip.")


def test_a_row_whose_bytes_are_gone_is_allowed_but_a_clip_with_no_row_is_not():
    """Rows outlive clips on purpose — `samples/` is prunable working scratch (ADR-0023 §10) and the
    ledger is explicitly excluded from that prune, so a row for a clip that has been deleted is the
    audit trail doing its job, not drift."""
    if not SAMPLES.exists():
        pytest.skip("samples/ absent")
    on_disk = {_sha256(p) for p in SAMPLES.rglob("*")
               if p.is_file() and p.suffix.lower() in VIDEO_SUFFIXES}
    orphan_rows = [r["file"] for r in _rows() if r["sha256"] not in on_disk]
    assert isinstance(orphan_rows, list)          # documented, not an error


# ---- the CLI that makes the remedy one command -------------------------------------------------

def test_the_manifest_cli_refuses_an_unidentified_adult_claim(tmp_path, monkeypatch):
    import samples_manifest

    clip = tmp_path / "x.mp4"
    clip.write_bytes(b"not really a video")
    dest = tmp_path / "m.jsonl"
    rc = samples_manifest.main(["add", "--file", str(clip), "--kind", "public_adult",
                                "--source", "https://example/x", "--competition", "unknown",
                                "--date", "2026-08-27", "--manifest", str(dest)])
    assert rc != 0
    assert not dest.exists()


def test_the_manifest_cli_appends_a_content_addressed_row(tmp_path):
    import samples_manifest

    clip = tmp_path / "x.mp4"
    clip.write_bytes(b"not really a video")
    dest = tmp_path / "m.jsonl"
    rc = samples_manifest.main(["add", "--file", str(clip), "--kind", "public_adult",
                                "--source", "https://example/x", "--competition", "Some Senior League",
                                "--date", "2026-08-27", "--manifest", str(dest)])
    assert rc == 0
    row = json.loads(dest.read_text().splitlines()[0])
    assert row["sha256"] == _sha256(clip)
    assert row["adult_senior_confirmed"] is True
    assert row["file"] == "x.mp4"


def test_the_manifest_cli_verify_names_uncovered_clips(tmp_path, capsys):
    import samples_manifest

    samples = tmp_path / "samples"
    samples.mkdir()
    (samples / "a.mp4").write_bytes(b"aaa")
    dest = tmp_path / "m.jsonl"
    dest.write_text("")
    rc = samples_manifest.main(["verify", "--samples", str(samples), "--manifest", str(dest)])
    assert rc != 0
    assert "a.mp4" in capsys.readouterr().out
