import json
from pathlib import Path

V = Path(__file__).resolve().parents[1]


def test_readme_opens_with_privacy_gate():
    head = (V / "README.md").read_text().lower()[:800]
    assert "privacy" in head and ("public" in head and "youth" in head)


# The two other checks that used to live here have moved, because neither could fail where it
# mattered:
#   * the samples-manifest check iterated the file's lines and asserted fields on each one, so it
#     passed on the EMPTY file it was guarding (audit Q-1) -> test_samples_manifest.py, which
#     asserts coverage of what is actually on disk;
#   * the lockfile check asserted only that the cu12x index string appears, which stayed true while
#     the file described its own pins as placeholders and nothing installed from it
#     -> test_docs_guard.py, which requires exact pins, no placeholder text, and a consumer.
