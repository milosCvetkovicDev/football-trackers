#!/usr/bin/env python3
"""Stage the docs into a mkdocs docs_dir, without moving anything in the repo.

THE CONSTRAINT. mkdocs wants one `docs_dir` containing every page. This repository cannot
provide one: the subprojects that have a README own it next to the code it describes
(`server/`, `firmware/`, `vision/`, `deploy/`), and the docs guard
(`server/test/docs-guard.ts`) asserts links between them. Moving files to satisfy a site
generator would break both the guard and the reading experience on GitHub.

So nothing moves. This script COPIES the published pages into a build directory, rewrites
the links that would dangle there, and mkdocs builds from that.

Links into code (`server/src/ingest.ts`, `firmware/src/main.cpp`) are rewritten to absolute
github.com URLs. Those links are the point — the docs constantly cite the file that
implements the thing being described — so they are redirected, never dropped.

Run:
    python3 site/build.py            # stage into site/_build/docs
    python3 site/build.py --check    # stage, then report any link that still dangles
"""

import os
import re
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(REPO, "site", "_build")
DOCS = os.path.join(BUILD, "docs")

GH = "https://github.com/milosCvetkovicDev/football-trackers/blob/main/"

# Trees published as site pages.
STAGED = {
    "docs": "docs",
}

# Repo-root and subproject files that become site pages.
ROOT_PAGES = {
    "README.md": "index.md",
    "SECURITY.md": "security.md",
    "server/README.md": "components/server.md",
    # NOTE: client/ has no README — the coach view is documented by the root README and
    # the phase contracts under docs/frontend/. Do not add a components/client.md entry
    # here without creating that file first; mkdocs --strict fails on a nav entry whose
    # page does not exist.
    "firmware/README.md": "components/firmware.md",
    "vision/README.md": "components/vision.md",
    "deploy/README.md": "components/deploy.md",
    "deploy/production/README.md": "components/production.md",
}

LINK_RE = re.compile(r"(\[(?:!\[[^\]]*\]\([^)\s]+\)|[^\]]*)\]\()([^)\s]+)(\))")

# Pinned by version AND checksum. The repo's own supply-chain rule is to pin floating
# links; mkdocs-material's default is to fetch mermaid from unpkg at a floating major.
MERMAID_VERSION = "11.17.2"
MERMAID_SHA256 = "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8"
MERMAID_URL = f"https://cdn.jsdelivr.net/npm/mermaid@{MERMAID_VERSION}/dist/mermaid.min.js"


def rel_to_repo(page_rel, href):
    base = os.path.dirname(page_rel)
    return os.path.normpath(os.path.join(base, href)).replace(os.sep, "/")


def repo_to_site(repo_path):
    """Map a repo-relative path to its site path, or None if it is not published."""
    if repo_path in ROOT_PAGES:
        return ROOT_PAGES[repo_path]
    for src_dir, dst_dir in sorted(STAGED.items(), key=lambda kv: -len(kv[0])):
        if repo_path == src_dir:
            return dst_dir
        if repo_path.startswith(src_dir + "/"):
            return dst_dir + repo_path[len(src_dir):]
    return None


def rewrite_links(text, page_rel, page_site_rel):
    page_site_dir = os.path.dirname(page_site_rel)

    def sub(m):
        prefix, href, suffix = m.groups()
        if href.startswith(("http://", "https://", "mailto:", "#")):
            return m.group(0)

        target, _, anchor = href.partition("#")
        if not target:
            return m.group(0)

        resolved = rel_to_repo(page_rel, target)
        frag = ("#" + anchor) if anchor else ""

        site_target = repo_to_site(resolved)
        if site_target is None:
            # Source files, configs, workflows — not site pages. Send the reader to the
            # real file on GitHub; a doc that cites its implementation should still reach it.
            return f"{prefix}{GH}{resolved}{frag}{suffix}"

        if os.path.isdir(os.path.join(REPO, resolved)):
            if os.path.isfile(os.path.join(REPO, resolved, "README.md")):
                site_target = site_target.rstrip("/") + "/README.md"
            else:
                return f"{prefix}{GH}{resolved}{frag}{suffix}"

        new_href = os.path.relpath(site_target, page_site_dir or ".").replace(os.sep, "/")
        return f"{prefix}{new_href}{frag}{suffix}"

    return LINK_RE.sub(sub, text)


def stage_file(src_abs, page_rel, page_site_rel, dst_abs):
    os.makedirs(os.path.dirname(dst_abs), exist_ok=True)
    if src_abs.endswith(".md"):
        with open(src_abs, encoding="utf-8") as fh:
            text = fh.read()
        text = rewrite_links(text, page_rel, page_site_rel)
        with open(dst_abs, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        shutil.copy2(src_abs, dst_abs)


def vendor_mermaid():
    """Fetch the pinned mermaid build into the site assets, verifying its checksum.

    A mismatch is fatal: an unverified 3.5 MB script running in every reader's browser is
    the supply-chain shape this repo already refuses elsewhere (see the pinned weights in
    vision/fetch_models.py and the SHA-pinned actions in .github/workflows/)."""
    import hashlib
    import urllib.request

    cache_dir = os.path.join(REPO, "site", "_vendor")
    os.makedirs(cache_dir, exist_ok=True)
    cached = os.path.join(cache_dir, f"mermaid-{MERMAID_VERSION}.min.js")

    if not os.path.isfile(cached):
        with urllib.request.urlopen(MERMAID_URL, timeout=60) as resp:
            data = resp.read()
        digest = hashlib.sha256(data).hexdigest()
        if digest != MERMAID_SHA256:
            raise SystemExit(
                f"mermaid checksum mismatch\n  expected {MERMAID_SHA256}\n"
                f"  got      {digest}\n  url      {MERMAID_URL}"
            )
        with open(cached, "wb") as fh:
            fh.write(data)

    digest = hashlib.sha256(open(cached, "rb").read()).hexdigest()
    if digest != MERMAID_SHA256:
        raise SystemExit(f"cached mermaid failed verification: {cached}")

    shutil.copy2(cached, os.path.join(DOCS, "assets", "mermaid.min.js"))
    return 1


def build():
    if os.path.isdir(BUILD):
        shutil.rmtree(BUILD)
    os.makedirs(DOCS, exist_ok=True)
    staged = 0

    for src_dir, dst_dir in STAGED.items():
        src_root = os.path.join(REPO, src_dir)
        for root, _dirs, files in os.walk(src_root):
            for f in files:
                if not f.endswith((".md", ".png", ".jpg", ".svg")):
                    continue
                src_abs = os.path.join(root, f)
                page_rel = os.path.relpath(src_abs, REPO).replace(os.sep, "/")
                sub = os.path.relpath(src_abs, src_root)
                site_rel = os.path.join(dst_dir, sub).replace(os.sep, "/")
                stage_file(src_abs, page_rel, site_rel, os.path.join(DOCS, site_rel))
                staged += 1

    for src_name, dst_name in ROOT_PAGES.items():
        src_abs = os.path.join(REPO, src_name)
        if os.path.isfile(src_abs):
            stage_file(src_abs, src_name, dst_name, os.path.join(DOCS, dst_name))
            staged += 1

    os.makedirs(os.path.join(DOCS, "assets"), exist_ok=True)
    for name in ("extra.css", "mermaid-init.js"):
        src = os.path.join(REPO, "site", name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(DOCS, "assets", name))
            staged += 1
    staged += vendor_mermaid()

    print(f"staged {staged} files into {os.path.relpath(DOCS, REPO)}")
    return staged


def check():
    broken = []
    for root, _dirs, files in os.walk(DOCS):
        for f in files:
            if not f.endswith(".md"):
                continue
            path = os.path.join(root, f)
            rel = os.path.relpath(path, DOCS)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            for m in LINK_RE.finditer(text):
                href = m.group(2)
                if href.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                target = href.split("#")[0]
                if not target:
                    continue
                resolved = os.path.normpath(os.path.join(os.path.dirname(path), target))
                if not os.path.exists(resolved):
                    line = text[: m.start()].count("\n") + 1
                    broken.append((rel, line, href))

    for rel, line, href in broken:
        print(f"::error::staged site link dangles: {rel}:{line} -> {href}")
    if broken:
        print(f"\n❌ {len(broken)} dangling link(s) in the staged site.")
        return 1
    print("✅ every relative link in the staged site resolves.")
    return 0


if __name__ == "__main__":
    build()
    sys.exit(check() if "--check" in sys.argv else 0)
