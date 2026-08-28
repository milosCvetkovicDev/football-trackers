# vision/test/test_fetch_pinning.py
#
# The weight fetch must be CHECKSUM-PINNED (audit §6 "Vision": *model fetch is trust-on-first-use —
# the fetcher overwrites the manifest with what it just downloaded*).
#
# WHY TOFU IS NOT PINNING. `models_io.resolve_weight` verifies each weight against
# `models/MANIFEST.json` before every run, which reads like integrity — and is, against local
# corruption. But the manifest was WRITTEN BY THE FETCHER from the bytes it had just received, so
# whatever arrived became the definition of correct. A different file at the same Google-Drive id —
# the ids belong to a third party and Drive lets an owner replace a file's contents in place —
# would be hashed, recorded, and then "verified" against its own hash forever, on every subsequent
# run, with a green check. The integrity check can only ever confirm that the file has not changed
# SINCE THE FETCH.
#
# So the digests move into the source, where they are reviewable and diffable, and the fetch becomes
# a comparison rather than a recording. The pins below are this repo's own 2026-06-20 download —
# the exact bytes behind the verified `cpu-run` acceptance (real player boxes on public adult
# footage) — re-verified byte-for-byte on 2026-08-27. They are NOT an upstream-published digest;
# Roboflow's `sports` setup.sh publishes none. That is a weaker provenance claim than a signed
# release and the README says so, but it is the difference between "these are the weights we
# validated" and "these are whatever the link served today".

import json

import pytest

import fetch_models
from footballcv.models_io import IntegrityError, sha256_of


def test_every_weight_carries_a_pinned_sha256_in_source():
    for name, meta in fetch_models.WEIGHTS.items():
        pin = meta.get("sha256")
        assert isinstance(pin, str) and len(pin) == 64, f"{name} has no pinned sha256"
        assert set(pin) <= set("0123456789abcdef"), f"{name}'s pin is not lowercase hex"


def test_the_pins_match_the_manifest_this_repo_ships():
    """models/MANIFEST.json is committed (the weights themselves are gitignored). If the pins and
    the shipped manifest ever disagree, one of them is wrong and a run would fail confusingly at
    resolve_weight rather than here."""
    mf = json.loads((fetch_models.MODELS / "MANIFEST.json").read_text())
    for name, meta in fetch_models.WEIGHTS.items():
        assert mf["weights"][name]["sha256"] == meta["sha256"], name


def _downloader_writing(blobs):
    def dl(file_id, dest):
        name = next(n for n, m in fetch_models.WEIGHTS.items() if m["drive_id"] == file_id)
        dest.write_bytes(blobs[name])
        return f"fake://drive/{file_id}"
    return dl


def test_a_weight_whose_bytes_do_not_match_the_pin_is_refused(tmp_path, monkeypatch):
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    blobs = {n: b"substituted-content" for n in fetch_models.WEIGHTS}
    with pytest.raises(IntegrityError) as ei:
        fetch_models.fetch_all(models_dir=tmp_path / "models",
                               downloader=_downloader_writing(blobs))
    assert "sha256" in str(ei.value).lower()


def test_a_mismatched_download_is_deleted_not_left_on_disk(tmp_path, monkeypatch):
    """A rejected weight left in models/ is a loaded gun: the next run's resolve_weight compares it
    against the manifest, and if the manifest write also went through, it would pass."""
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    models = tmp_path / "models"
    blobs = {n: b"substituted-content" for n in fetch_models.WEIGHTS}
    with pytest.raises(IntegrityError):
        fetch_models.fetch_all(models_dir=models, downloader=_downloader_writing(blobs))
    assert not list(models.glob("*.pt")), "a rejected weight was left on disk"
    assert not (models / "MANIFEST.json").exists(), "a manifest was written for a rejected fetch"


def test_the_manifest_records_the_pin_not_whatever_arrived(tmp_path, monkeypatch):
    """The distinguishing property. With the pin temporarily set to the fake blob's digest, the
    fetch succeeds — and the manifest's sha256 must equal the PIN (they coincide here, which is the
    point: the manifest may never be a transcript of the download)."""
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    models = tmp_path / "models"
    blobs = {n: f"fake-{n}-weights".encode() for n in fetch_models.WEIGHTS}
    pinned = {n: dict(m, sha256=sha256_of_bytes(blobs[n]))
              for n, m in fetch_models.WEIGHTS.items()}
    monkeypatch.setattr(fetch_models, "WEIGHTS", pinned)

    manifest = fetch_models.fetch_all(models_dir=models, downloader=_downloader_writing(blobs))

    for name in pinned:
        assert manifest["weights"][name]["sha256"] == pinned[name]["sha256"]
        assert manifest["weights"][name]["sha256"] == sha256_of(models / f"{name}.pt")


def test_a_weight_with_no_pin_is_refused_rather_than_recorded(tmp_path, monkeypatch):
    """The regression this file exists to prevent: adding a fourth model and letting the fetcher
    'learn' its digest would silently restore trust-on-first-use for that model.

    The assertion is that the DOWNLOADER IS NEVER CALLED, not that the message contains a word.
    Mutation-testing this file caught the weaker version: with the no-pin guard deleted, `pin` is
    None, the later comparison raises "sha256 mismatch … expected the pinned None", and a check for
    the substring "pin" passed on the wrong code path entirely. Refusing before the download is also
    the behaviour that matters — these weights are ~137 MB each."""
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    unpinned = {"players": {k: v for k, v in fetch_models.WEIGHTS["players"].items()
                            if k != "sha256"}}
    monkeypatch.setattr(fetch_models, "WEIGHTS", unpinned)

    calls = []

    def never(file_id, dest):
        calls.append(file_id)
        dest.write_bytes(b"anything")
        return "fake://drive/x"

    with pytest.raises(IntegrityError) as ei:
        fetch_models.fetch_all(models_dir=tmp_path / "models", downloader=never)
    assert calls == [], "an unpinned weight was DOWNLOADED before being refused"
    assert "no pinned sha256" in str(ei.value).lower()


def sha256_of_bytes(b: bytes) -> str:
    import hashlib
    return hashlib.sha256(b).hexdigest()


def test_the_existing_manifest_consumer_still_accepts_a_pinned_fetch(tmp_path, monkeypatch):
    from footballcv.models_io import load_manifest, resolve_weight
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    models = tmp_path / "models"
    blobs = {n: f"fake-{n}-weights".encode() for n in fetch_models.WEIGHTS}
    pinned = {n: dict(m, sha256=sha256_of_bytes(blobs[n]))
              for n, m in fetch_models.WEIGHTS.items()}
    monkeypatch.setattr(fetch_models, "WEIGHTS", pinned)
    fetch_models.fetch_all(models_dir=models, downloader=_downloader_writing(blobs))
    manifest = load_manifest(models)
    for name in pinned:
        assert resolve_weight(name, models, manifest).name == f"{name}.pt"
