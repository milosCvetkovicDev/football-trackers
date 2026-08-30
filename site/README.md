# site/ — the documentation site

The project's docs, rendered as a website:
<https://miloscvetkovicdev.github.io/football-trackers/>

Built by [`../.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push
that touches published content. It does not change how the repository reads on GitHub —
the site is a second surface over the same files.

## Nothing moves

mkdocs wants one `docs_dir` containing every page. This repo cannot offer one: the
subprojects that have a README own it next to the code it describes, and
[`server/test/docs-guard.ts`](../server/test/docs-guard.ts) asserts the links between them.
Rearranging files to suit a site generator would break the guard and the GitHub reading
experience at once.

So [`build.py`](build.py) **stages** the docs into a scratch directory and rewrites the
links that would dangle there:

| Link in the repo | On the site |
| ---------------- | ----------- |
| `server/src/ingest.ts` | an absolute `github.com` URL — source files are not site pages |
| `server/README.md` | `components/server.md` |
| `SECURITY.md` | `security.md` |
| a directory link | that directory's `README.md`, or GitHub if it has none |

Links from a doc to the file that implements it are the point, so they are redirected
rather than dropped — the reader stays one click from the real source either way.

`build.py --check` fails if any link still dangles inside the staged site, and the workflow
runs it in that mode. **It earned its place immediately:** the first run surfaced two links
that were broken *in the repository* — a wrong relative depth in a vision plan and a stale
ADR filename in the production README — neither of which `docs-guard` covers, because that
guard sweeps the entry-point READMEs rather than `docs/**` and `deploy/production/`.

## The diagram library is pinned and self-hosted

mkdocs-material's mermaid integration fetches the library from unpkg at a **floating** major
version and runs it in every reader's browser. This repo pins its supply chain everywhere
else — checksum-pinned model weights in [`vision/fetch_models.py`](../vision/fetch_models.py),
SHA-pinned actions in every workflow — so the site does the same: `build.py` vendors an exact
build and verifies it by SHA-256, and a mismatch is fatal.

Material claims the CSS class `mermaid` and does **not** defer to an already-loaded
instance — it empties the element and renders with its own fetched copy, so a blocked fetch
leaves a blank box rather than falling back. The fences therefore carry the class `diagram`,
which Material ignores, and [`mermaid-init.js`](mermaid-init.js) renders them.

## Running it locally

```bash
pip install mkdocs-material==9.7.7
python3 site/build.py --check
cd site && mkdocs serve
```

`site/_build/` and `site/_vendor/` are generated and git-ignored.
