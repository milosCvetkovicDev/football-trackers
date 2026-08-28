# vision/test/test_docs_guard.py
#
# Docs-as-tests for the vision subproject (audit §8 Phase 7: *docs-as-tests guard*, and §6 "Docs":
# a subproject whose README claims things the repo does not do).
#
# THE ARGUMENT FOR TESTING PROSE. Every drift item the audit found in this repo was a sentence that
# was true when it was written: "24-test suite" (there are over a hundred), a CI badge for a workflow
# that did not exist, a privacy banner naming an attestation kind that had been deleted, a vendored
# commit recorded as `<RECORD SHA HERE>`. None of them is a bug; all of them are load-bearing,
# because the README is the only interface most of this subproject has. A claim nothing checks is a
# claim that decays silently, and the decay is invisible precisely because prose never goes red.
#
# So the rule here is narrow and mechanical: a doc may not state a COUNT, a PATH, a VOCABULARY or a
# COMMAND that the repo can contradict. Anything softer than that stays prose and is not tested.

import json
import re
from pathlib import Path

import pytest

V = Path(__file__).resolve().parents[1]
DOCS = [V / "README.md", V / "Dockerfile", V / "docker-compose.yml",
        V / "requirements-test.txt", V / "requirements.txt", V / "requirements.lock"]


def _text(p: Path) -> str:
    return p.read_text(encoding="utf-8")


# ---- vocabulary: the retired youth attestation kind may not reappear, in prose either ---------

def test_no_document_mentions_the_retired_youth_attestation_kind():
    """audit §4.3's verify step was `! grep -rn 'consented_youth' vision/webui/ vision/README.md`.
    It passed while `docker-compose.yml` and `webui/server.py`'s own startup BANNER still told the
    operator the tool accepts 'public-adult OR consented-youth' — the hyphen spelling slipped
    through a grep for the underscore one. The banner is the first thing anyone running the UI
    reads, so it was the single most visible place the retired kind survived."""
    needle = re.compile(r"consented[_-]youth", re.I)
    offenders = []
    for p in sorted(V.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts or ".pytest_cache" in p.parts:
            continue
        if p.suffix not in (".py", ".md", ".yml", ".yaml", ".html", ".txt", ".json", ""):
            continue
        if p.name == "test_docs_guard.py":
            continue                       # this file names the string in order to forbid it
        try:
            body = _text(p)
        except (UnicodeDecodeError, OSError):
            continue
        if needle.search(body):
            offenders.append(str(p.relative_to(V)))
    assert not offenders, f"the retired youth attestation kind is still named in: {offenders}"


def test_the_readme_states_the_single_accepted_attestation_kind():
    from webui.runner import ATTEST_KINDS
    assert ATTEST_KINDS == {"public_adult"}
    head = _text(V / "README.md").lower()
    assert "no youth" in head or "youth" in head[:1200]


# ---- counts: a number in a comment is drift by construction ----------------------------------

def test_no_document_hardcodes_a_test_count():
    """`docker-compose.yml`, `Dockerfile` and `requirements-test.txt` all said "the 24-test suite".
    The suite passed 104 at the time of writing. A count in prose cannot be maintained — it is not
    that anyone was careless, it is that nothing connects the sentence to the collection. The rule
    is therefore that documents do not carry one at all."""
    pattern = re.compile(r"\b\d+[- ]test(s)?\b|\b\d+\s+tests?\s+(suite|pass)", re.I)
    offenders = []
    for p in DOCS:
        for i, line in enumerate(_text(p).splitlines(), 1):
            if pattern.search(line):
                offenders.append(f"{p.name}:{i}: {line.strip()}")
    assert not offenders, "hardcoded test counts (say 'the test suite' instead):\n" + "\n".join(offenders)


# ---- placeholders: a `<FILL THIS IN>` that shipped is a claim nobody kept ---------------------

def test_no_document_ships_an_unfilled_placeholder():
    pattern = re.compile(r"<RECORD [A-Z ]+HERE>|<FILL[^>]*>|\bTBD\b|\bXXX\b|<v>")
    offenders = []
    for p in DOCS:
        for i, line in enumerate(_text(p).splitlines(), 1):
            if pattern.search(line):
                offenders.append(f"{p.name}:{i}: {line.strip()}")
    assert not offenders, "unfilled placeholders:\n" + "\n".join(offenders)


def test_the_third_party_surface_records_what_it_actually_is():
    """The README said: *Roboflow `sports` (MIT) is vendored under `footballcv/vendor/sports/` at
    commit `<RECORD SHA HERE>`*. That is not an unfilled blank — it is a false description. Nothing
    was ever copied: the module's own comment says these are "NOT a verbatim copy … they are
    independent minimal equivalents written against its public API shape", about ninety lines of
    original code. So there is no commit to record, and demanding one would have forced somebody to
    invent a plausible SHA for code that was never taken.

    An attribution claim is not decoration — it is what a licence review reads. `copied_code` is the
    field that decides which claim applies, and the commit requirement hangs off it."""
    prov = V / "footballcv" / "vendor" / "sports" / "PROVENANCE.json"
    assert prov.exists(), f"{prov} is missing — say what this third-party-shaped code actually is"
    meta = json.loads(_text(prov))
    for k in ("upstream", "upstream_license", "copied_code", "recorded_at"):
        assert k in meta and meta[k] not in (None, ""), f"PROVENANCE.json is missing {k}"
    assert isinstance(meta["copied_code"], bool)
    readme = _text(V / "README.md")
    if meta["copied_code"]:
        assert re.fullmatch(r"[0-9a-f]{40}", meta.get("upstream_commit", "")), \
            "copied code must record the full 40-char upstream commit"
        assert meta["upstream_commit"] in readme, "the README must name the pinned commit"
    else:
        assert "is vendored" not in readme, (
            "nothing is copied from upstream, so the README must not say the code is vendored")


# ---- paths: a documented path that does not exist sends a person to the wrong place -----------

def test_the_documented_ledger_path_is_the_one_the_server_uses():
    from webui import server as srv
    documented = _text(V / "README.md") + _text(V / "webui" / "index.html")
    ledger_name = str(srv.LEDGER).split("/")[-1]
    assert ledger_name in documented, (
        f"the attestation ledger is at {srv.LEDGER} but no document names it — the UI footer and "
        "the README both told people to look in out/, which retention now empties")
    assert "out/_attestations.jsonl" not in documented, "the ledger moved out of the pruned directory"


@pytest.mark.parametrize("service", ["test", "selftest", "cpu-run", "webui"])
def test_every_compose_service_the_readme_tells_you_to_run_exists(service):
    compose = _text(V / "docker-compose.yml")
    assert re.search(rf"^  {re.escape(service)}:$", compose, re.M), f"no such compose service: {service}"


def test_the_readme_only_documents_commands_that_exist():
    """Every `docker compose run --rm <svc>` / `docker compose up <svc>` in the README must name a
    real service. A copy-paste block that errors is worse than no block."""
    compose = _text(V / "docker-compose.yml")
    services = set(re.findall(r"^  ([a-z][a-z0-9-]*):$", compose, re.M))
    used = set(re.findall(r"docker compose (?:--profile \w+ )?(?:run --rm|up) ([a-z][a-z0-9-]*)",
                          _text(V / "README.md")))
    assert used <= services, f"README runs services that do not exist: {sorted(used - services)}"


# ---- posture: the web UI must not be republished on every interface by a compose edit ---------

def test_compose_publishes_the_web_ui_on_loopback_only():
    """The UI has no authentication and holds footage. `ports: - "8077:8077"` publishes it to the
    whole subnet; the container-side bind being loopback would then make it unreachable, so the two
    have to agree — and they have to agree on loopback."""
    compose = _text(V / "docker-compose.yml")
    published = re.findall(r'^\s*-\s*"([^"]*:?8077[^"]*)"', compose, re.M)
    assert published, "no service publishes the web UI port"
    for entry in published:
        assert entry.startswith("127.0.0.1:"), (
            f'ports entry "{entry}" publishes the unauthenticated web UI on every interface')


# ---- the lockfile has to be CONSUMED by something, or it is a wish list -----------------------

LOCK_PLACEHOLDERS = re.compile(r"placeholder|once resolved|pin exact versions below|confirm the exact", re.I)


def test_the_lockfile_carries_no_placeholder_text():
    """`requirements.lock` opened with '--- pin exact versions below once resolved ---' and closed
    with 'the +cu121 torch pins are placeholders'. Nothing installed from it, so nothing ever
    noticed. A lockfile that is documentation of an intention to lock is not a lockfile."""
    offenders = [l for l in _text(V / "requirements.lock").splitlines() if LOCK_PLACEHOLDERS.search(l)]
    assert not offenders, "placeholder text in requirements.lock:\n" + "\n".join(offenders)


def _requirement_names(text: str) -> set:
    names = set()
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        names.add(re.split(r"[<>=!~\[]", line, 1)[0].strip().lower())
    return names


def _pinned_versions(text: str) -> dict:
    pins = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        m = re.match(r"^([A-Za-z0-9_.\-]+)\s*==\s*(\S+)$", line)
        if m:
            pins[m.group(1).lower()] = m.group(2)
    return pins


def test_every_runtime_requirement_is_pinned_in_the_lockfile():
    """The drift this catches immediately: `lapx` was added to requirements.txt during the Mac
    cpu-run smoke (the missing linear-assignment backend for BoT-SORT) and never reached the lock,
    so a rebuild from the lock would have reproduced the exact bug the smoke had just found."""
    wanted = _requirement_names(_text(V / "requirements.txt"))
    pinned = set(_pinned_versions(_text(V / "requirements.lock")))
    # torch/torchvision are pinned with a +cu121 local version; they are in `pinned` too.
    missing = sorted(wanted - pinned)
    assert not missing, f"in requirements.txt but not pinned in requirements.lock: {missing}"


def test_the_lockfile_pins_exact_versions_only():
    lock = _text(V / "requirements.lock")
    loose = [l.strip() for l in lock.splitlines()
             if (s := l.split("#", 1)[0].strip()) and not s.startswith("-") and "==" not in s]
    assert not loose, f"unpinned lines in requirements.lock: {loose}"


def test_the_lockfile_still_pins_the_cuda_index():
    assert "download.pytorch.org/whl/cu12" in _text(V / "requirements.lock")


def test_the_cpu_test_image_installs_from_a_lockfile():
    """The CPU image is the one this project's CI actually builds, so it is the one whose lock can
    be verified rather than asserted. It must install from the pinned file, not the range file.

    The assertion is pinned to the `pip install` LINE, not to the stage. Mutation-testing caught the
    weaker version: flipping the install back to requirements-test.txt left the check green, because
    the `COPY requirements-test.txt requirements-test.lock ./` line above it still contains the
    string it was searching the whole stage for."""
    df = _text(V / "Dockerfile")
    cpu_stage = df.split("AS cpu\n", 1)[1].split("FROM ", 1)[0]
    installs = re.findall(r"^RUN pip install[^\n]*", cpu_stage, re.M)
    assert installs, "the cpu target installs nothing"
    assert any("requirements-test.lock" in line for line in installs), (
        "the cpu target must `pip install -r requirements-test.lock` so the gate is reproducible; "
        f"found: {installs}")
    assert not any(re.search(r"-r\s+requirements-test\.txt", line) for line in installs), (
        "the cpu target installs from the RANGE file — the lock is then decorative")


def test_the_cpu_lockfile_covers_every_declared_test_dependency():
    wanted = _requirement_names(_text(V / "requirements-test.txt"))
    pinned = set(_pinned_versions(_text(V / "requirements-test.lock")))
    missing = sorted(wanted - pinned)
    assert not missing, f"in requirements-test.txt but not pinned in requirements-test.lock: {missing}"
