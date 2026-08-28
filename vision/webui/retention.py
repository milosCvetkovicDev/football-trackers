"""Bounded storage for `out/` — the same rule the rest of this project applies to children's data,
applied to footage (ADR-0023 §10; audit §6 "Vision": *no retention/TTL (`out/` = 51 MB after 3 jobs)*).

WHAT ACCUMULATES. Every job directory holds the DOWNLOADED SOURCE CLIP (`clip.<ext>`, tens of MB for
a minute of 720p) plus a re-encoded derivative of it, and nothing ever removed either. Three short
jobs measured 51 MB. The tool's stated posture is "everything stays local and nothing leaves"; that
is a statement about egress, and it says nothing at all about how long the footage sits on the disk.
Retention is what turns "local" into "local and not forever".

WHY THE LEDGER MOVED FIRST. The attestation ledger — the only record of which link was processed
under which attestation — lived at `out/_attestations.jsonl`, INSIDE the directory this module
deletes. Adding retention without moving it would have made the tool delete its own compliance
record, which is the one thing an attestation exists to preserve; ADR-0023 §3 already says the
manifest is kept out of the pruned directory for exactly this reason, and the ledger is the same
kind of artifact. `server.LEDGER` now defaults outside `out/`, and `prune_out` refuses to delete
whatever `ledger` names even if someone points it back inside.
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

# 24 h is enough to come back the next morning and re-watch a run, and short enough that footage is
# not quietly retained for weeks. `FT_OUT_TTL_HOURS=0` disables pruning entirely.
DEFAULT_TTL_HOURS = float(os.environ.get("FT_OUT_TTL_HOURS", "24"))


def prune_out(out_root: Path | str, *, ttl_hours: float = DEFAULT_TTL_HOURS,
              ledger: Path | str | None = None, now: float | None = None) -> list[Path]:
    """Delete job DIRECTORIES under `out_root` last modified more than `ttl_hours` ago.

    Returns the directories actually removed. Deliberate boundaries:

    - `ttl_hours <= 0` means OFF, not "everything is expired". An operator who wants to keep
      everything sets 0, and the naive `age > ttl` reading of that would erase the lot.
    - Only directories are considered. A loose file sitting in `out/` is something a person put
      there; removing it is not this function's business.
    - `ledger` is never removed, wherever it is.
    - One undeletable entry does not abort the sweep. This runs on every job start, so a directory
      held open by another process would otherwise strand every later expired job on disk forever.
    """
    out_root = Path(out_root)
    removed: list[Path] = []
    if ttl_hours <= 0 or not out_root.is_dir():
        return removed
    ledger_path = Path(ledger).resolve() if ledger is not None else None
    cutoff = (time.time() if now is None else now) - ttl_hours * 3600

    for entry in sorted(out_root.iterdir()):
        if not entry.is_dir():
            continue
        if ledger_path is not None and (entry.resolve() == ledger_path
                                        or entry.resolve() in ledger_path.parents):
            continue                              # never prune the directory holding the ledger
        try:
            if entry.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        try:
            shutil.rmtree(entry)
        except OSError:
            continue                              # named in the caller's log, not fatal here
        removed.append(entry)
    return removed
