#!/usr/bin/env python3
"""The clip-provenance ledger — record and verify what is in `samples/` (ADR-0023 §3, audit Q-1).

    python samples_manifest.py verify
    python samples_manifest.py add --file samples/clip.mp4 --kind public_adult \
        --source https://www.youtube.com/watch?v=... --competition "<adult/senior league>" \
        --date 2026-08-27

WHY A CLI AND NOT "EDIT THE FILE BY HAND". The runbook told the operator to hand-append a JSON line,
and the file stayed 0 bytes through three clips — which is the ordinary outcome of a manual step at
the end of a long task. More importantly, a hand-written row cannot carry the one field that makes
the record durable: the sha256. `samples/clip.mp4` was replaced at least twice over this project's
life, so a row keyed on a NAME attests whatever happens to be sitting at that path today. Rows here
attest BYTES.

DEFAULT-DENY IS ENFORCED, NOT SUGGESTED. ADR-0023 §3's rule is that a clip whose competition/age
cannot be positively identified as adult/senior is discarded — the dangerous case is not obvious
youth footage, it is ambiguous semi-pro/academy footage that looks adult. So `add` refuses a
`public_adult` row whose competition is blank, "unknown", "tbd" or similar: if you cannot name the
competition, you have not identified it, and the correct action is to delete the clip.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "samples.manifest.jsonl"
DEFAULT_SAMPLES = HERE / "samples"
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".ogv", ".avi", ".360", ".m4v"}
PLACEHOLDER = {"", "tbd", "unknown", "n/a", "na", "todo", "?", "-"}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_rows(manifest: Path) -> list[dict]:
    if not manifest.exists():
        return []
    return [json.loads(l) for l in manifest.read_text(encoding="utf-8").splitlines() if l.strip()]


def clips_in(samples: Path) -> list[Path]:
    if not samples.is_dir():
        return []
    return sorted(p for p in samples.rglob("*")
                  if p.is_file() and p.suffix.lower() in VIDEO_SUFFIXES)


def uncovered(samples: Path, manifest: Path) -> list[tuple[Path, str]]:
    attested = {r.get("sha256") for r in read_rows(manifest)}
    return [(p, s) for p in clips_in(samples) if (s := sha256_of(p)) not in attested]


def cmd_verify(args) -> int:
    samples, manifest = Path(args.samples), Path(args.manifest)
    rows = read_rows(manifest)
    missing = uncovered(samples, manifest)
    print(f"{len(rows)} provenance row(s) in {manifest}")
    print(f"{len(clips_in(samples))} clip(s) in {samples}")
    if not missing:
        print("OK — every clip is attested")
        return 0
    print("\nUNATTESTED clips (ADR-0023 §3 is default-deny — attest or delete):")
    for p, sha in missing:
        print(f"  {p}  sha256={sha[:16]}…")
    print("\n  python samples_manifest.py add --file <clip> --kind public_adult \\\n"
          "      --source <url> --competition '<adult/senior league>' --date <YYYY-MM-DD>")
    return 1


def cmd_add(args) -> int:
    clip, manifest = Path(args.file), Path(args.manifest)
    if not clip.is_file():
        print(f"no such file: {clip}", file=sys.stderr)
        return 2
    if args.kind == "public_adult" and str(args.competition or "").strip().lower() in PLACEHOLDER:
        print("refusing: --competition must NAME the adult/senior competition. ADR-0023 §3 is "
              "default-deny — a clip you cannot positively identify is discarded, not recorded as "
              "'unknown'.", file=sys.stderr)
        return 2
    if str(args.source or "").strip().lower() in PLACEHOLDER:
        print("refusing: --source must say where the clip came from.", file=sys.stderr)
        return 2

    sha = sha256_of(clip)
    if sha in {r.get("sha256") for r in read_rows(manifest)}:
        print(f"already attested: {clip.name} ({sha[:16]}…)")
        return 0

    row = {"file": clip.name, "sha256": sha, "bytes": clip.stat().st_size,
           "kind": args.kind, "source": args.source.strip(), "date": args.date}
    if args.kind == "public_adult":
        row["competition"] = args.competition.strip()
        row["adult_senior_confirmed"] = True
    else:
        row["contains_people"] = False
    if args.channel:
        row["channel"] = args.channel.strip()
    if args.note:
        row["note"] = args.note.strip()

    manifest.parent.mkdir(parents=True, exist_ok=True)
    with manifest.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"recorded {clip.name} ({sha[:16]}…) as {args.kind}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser("samples_manifest")
    sub = ap.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("verify", help="every clip in samples/ has a provenance row")
    v.add_argument("--samples", default=str(DEFAULT_SAMPLES))
    v.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    v.set_defaults(fn=cmd_verify)

    a = sub.add_parser("add", help="append one content-addressed provenance row")
    a.add_argument("--file", required=True)
    a.add_argument("--kind", required=True, choices=["public_adult", "synthetic"])
    a.add_argument("--source", required=True)
    a.add_argument("--competition", default="")
    a.add_argument("--channel", default="")
    a.add_argument("--date", required=True)
    a.add_argument("--note", default="")
    a.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    a.set_defaults(fn=cmd_add)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
