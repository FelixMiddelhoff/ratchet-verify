# ratchet-verify: Python ecosystem module

Tracks issue #15. All 7 phases below are done (v1). This file starts as the phase-1 design
lock (posted as a comment on #15) and now doubles as the module's docs.

## Usage (v1)

```
node --experimental-strip-types python-module/cli.ts \
  --project /path/to/python/project \
  --old-lockfile /path/to/old/uv.lock \
  --new-lockfile /path/to/new/uv.lock \
  [--lockfile-name uv.lock|poetry.lock] [--test pytest -x]
```

Not yet wired: a `bin` entry in `package.json` (so it isn't installed as `ratchet-python` by
npm yet), `--base` git-ref reading (lockfile paths are plain files for now, not read from a
git ref the way the npm core reads `--base`), JSON/SARIF output (`renderPythonText` is the
only renderer), a config file, and a GitHub Action. The npm core grew these over several PRs
after its own CLI first landed (#11/#12/#13), not all at once — same expected path here.

Container mode (isolation stronger than the current temp-dir sandbox) is also a follow-up,
tracked in the phase 5 note below.

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

## Phases

1. **Done** — design lock (comment on #15, this file). PR #62.
2. **Done** — lockfile diff: `uv.lock` + `poetry.lock` parsing and diffing (`lockfile.ts`). PR #63.
3. **Done** — changelog fetch: PyPI JSON API + GitHub `project_urls` follow-through (`changelog.ts`, `version.ts`). PR #64.
4. **Done** — static usage scan: `ast`-based inline driver, subprocess bridge from TypeScript (`usage.ts`). PR #65.
5. **Done** — sandboxed install + test run (`sandbox.ts`, `testrun.ts`). **v1 is temp-dir isolation only**, not container mode: the npm core shipped temp-dir first too, before container mode (#1) followed later as its own PR. Container mode for Python is an open follow-up, not v1. PR #66.
6. **Done** — bisection: PEP 440 version-by-version bisect loop (`bisect.ts`), duplicated from `src/bisect/` rather than imported because the core hard-codes semver comparison. PR #67.
7. **Done** — report/CLI wiring (`report.ts`, `pipeline.ts`, `real.ts`, `render.ts`, `cli.ts`) + this docs update.

## v2 progress

- **Breaking-change matcher (done)**: `match.ts` cross-references changelog text against
  `usage.ts` import sites, wired into `pipeline.ts`. Reuses `classifyLines` from
  `src/match/classify.ts` directly (pure text classification, no npm-specific types); the
  symbol-matching rules are ported from `src/match/index.ts` at reduced scope — `from-import`
  sites match by symbol name the same way JS named imports do, `import pkg` sites (no member
  info tracked) get the same low-confidence "whole module used" treatment as JS's
  `import * as x`. No subpath/default-export masking (JS-specific quirks that don't apply).

## Known v1/v2 gaps (open follow-ups, not started)

- **No container mode**: sandboxing is temp-dir only (env allowlist + redirected home), not
  the stronger per-run container isolation the npm core added later.
- **CLI is minimal**: explicit lockfile file paths, not `--base` git-ref reading; text output
  only, no JSON/SARIF; no config file; no GitHub Action; no `package.json` `bin` entry.
- **`requirements.txt` unsupported**: deferred to v2 per the original scope lock.
- **Single test command assumption**: `installAndTestPython`/`real.ts` default to `pytest`
  with no auto-detection (Python has no `scripts.test` equivalent to read).
