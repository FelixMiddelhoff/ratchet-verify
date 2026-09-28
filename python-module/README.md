# ratchet-verify: Python ecosystem module (design, phase 1)

Tracks issue #15. This is a design lock, not code yet — posted as a comment on #15 before
any implementation starts.

## Why a separate module

Same "prove the bump still works" pipeline as the npm core (lockfile diff -> changelog ->
static usage scan -> sandboxed install/test -> bisection), but Python's tooling, lockfile
formats and package index are different enough that bolting it onto `src/` would tangle two
unrelated ecosystems in one codebase. Kept as a sibling directory, still orchestrated by the
existing Node CLI and reusing `src/report/` and `src/bisect/` shapes where the concepts line up.

## Scope v1 (locked)

- **Lockfiles**: `uv.lock` and `poetry.lock` only. Both are TOML, both pin exact versions and
  hashes, both are straightforward to diff. `requirements.txt` (+ hashes) is explicitly
  deferred to v2 — it's a looser, less structured format (no single canonical dependency
  graph) and would slow down v1 for comparatively little benefit right now.
- **Static usage scan**: shell out to Python's own `ast` module (`python3 -c "import ast; ..."`)
  from a short driver script, instead of adding a JS-side Python parser dependency. Zero new
  npm deps, and the scan runs in the same sandbox that already has a Python interpreter
  available for install/test anyway.
- **Orchestration**: stays Node/TypeScript. This module is a set of adapters (lockfile diff,
  changelog fetch, usage scan, sandbox runner) that plug into the existing `src/report/` and
  `src/bisect/` pipelines — not a separate PyPI-published tool with its own release process.
- **Changelog source**: PyPI JSON API (`https://pypi.org/pypi/<pkg>/json`) for the release
  list and metadata, following `project_urls` to GitHub when present for changelog/release
  notes text — mirrors how the npm core already fetches changelogs.
- **Bisection**: `pip install pkg==<version>` (or `uv pip install`) per candidate version,
  same bisect-loop shape as the npm core, different install command.

## Phases (own issue + PR each, do not start without explicit go-ahead)

1. This design lock (comment on #15, this file).
2. Lockfile diff: `uv.lock` + `poetry.lock` parsing and diffing.
3. Changelog fetch: PyPI JSON API + GitHub `project_urls` follow-through.
4. Static usage scan: `ast`-based driver script, subprocess bridge from TypeScript.
5. Sandboxed install + test run: Python container image, reusing `src/sandbox/`.
6. Bisection: `pip`/`uv` version-by-version bisect loop.
7. Report/CLI wiring + docs.

Effort estimate: ~6-10 sessions total (matches the size estimate given on #15), the biggest
open unknown being real-world lockfile edge cases (private indexes, extras, markers) found
once phase 2 starts.
