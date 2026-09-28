# ratchet-verify: Python ecosystem module

Tracks issue #15. All 7 phases below are done (v1). This file starts as the phase-1 design
lock (posted as a comment on #15) and now doubles as the module's docs.

## Usage (v1)

```
node --experimental-strip-types python-module/cli.ts \
  --project /path/to/python/project \
  (--old-lockfile /path/to/old/uv.lock | --base main) \
  [--new-lockfile /path/to/new/uv.lock] \
  [--lockfile-name uv.lock|poetry.lock|requirements.txt] [--container <image>] [--format text|json] [--test pytest -x]
```

`--base <ref>` reads the old lockfile from that git ref instead of a plain file path, reusing
`readFileAtRef` from `src/cli/git.ts` directly (reading a file at a git ref is a git concept,
not an npm one). Exactly one of `--old-lockfile`/`--base` is required. `--new-lockfile` is
optional and defaults to `<project>/<lockfile-name>` (the working tree's current lockfile) —
the common case is "does the working tree's bump still work against the base branch".

`--format json` renders the full `PythonReport` as JSON (`renderPythonJson`) instead of text.

`--container <image>` runs installs and tests inside a docker/podman container instead of a
temp-dir sandbox (stronger isolation: the container only sees the sandbox mount, nothing else
of the host). The image must ship `uv`/`poetry`/`pip` (whichever the lockfile needs; `pip`
is assumed present on any Python image and is not probed for) — a stock `python:3.x-slim`
ships pip but not uv or poetry, and the CLI fails early with that message via
`ensurePythonManagerInImage` rather than failing per-candidate later. Without `--container`,
temp-dir isolation is used (env allowlist + redirected home, no filesystem confinement).

Not yet wired: a `bin` entry in `package.json` (this module isn't part of `dist`/`files` yet —
adding a bin entry needs its own build step, not just a package.json edit, so it stayed out of
this CLI-polish pass), SARIF output, a config file, and a GitHub Action.

## Why a separate module

Same "prove the bump still works" pipeline as the npm core (lockfile diff -> changelog ->
static usage scan -> sandboxed install/test -> bisection), but Python's tooling, lockfile
formats and package index are different enough that bolting it onto `src/` would tangle two
unrelated ecosystems in one codebase. Kept as a sibling directory, still orchestrated by the
existing Node CLI and reusing `src/report/` and `src/bisect/` shapes where the concepts line up.

## Scope v1 (locked)

- **Lockfiles**: `uv.lock` and `poetry.lock` for v1. `requirements.txt` support landed in v2
  (see below), scoped to hash-pinned `pip-compile` output only — a loose unpinned
  `requirements.txt` has no single canonical dependency graph and stays unsupported.
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
5. **Done** — sandboxed install + test run (`sandbox.ts`, `testrun.ts`). PR #66.
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
- **Container mode (done)**: `container.ts` adds docker/podman isolation, reusing the npm
  core's engine detection directly (`detectEngine`/`detectRuntime`/`ensureImage`/`hostUser`
  from `src/sandbox/container.ts` — none of that is npm-specific). `buildRunArgs`/
  `buildContainerEnv` are NOT reused: they hard-code npm's env vars with no injection point,
  so there's a Python-flavored `buildPythonRunArgs`/`buildPythonContainerEnv` instead
  (pip/uv/poetry cache and config redirected via HOME/XDG). `sandbox.ts`'s
  `withPythonSandbox` takes an optional `container` option, same shape as the npm core's
  `SandboxOptions.container`. `ensurePythonManagerInImage` fails early (with the fix) when
  the image lacks `uv`/`poetry`, same pattern as the npm core's `ensureManagerInImage` for
  pnpm/yarn. Wired into the CLI as `--container <image>`. Verified against real podman on
  this dev box (image pull + a command run through the container); not yet covered by a
  dedicated CI job the way the npm core's container tests run on `ubuntu-latest`.

- **CLI polish (partly done)**: `--base` git-ref reading and `--format json` are done (this
  pass). Still open: SARIF output, a config file, a GitHub Action, and a `package.json` `bin`
  entry (needs its own build step — this module currently isn't compiled into `dist` or
  listed in `package.json`'s `files`, so it isn't published to npm at all yet).
- **`requirements.txt` support (done)**: `lockfile.ts`'s `parsePythonLock` auto-detects the
  format (TOML `[[package]]` vs. no such marker) and parses hash-pinned pip-compile output
  (`name==version` plus `--hash=...`/`# via ...` continuation lines; `\`-line-continuations
  joined before matching). `PythonManager` gained `"pip"`: install is
  `pip install --require-hashes -r requirements.txt` (refuses any unhashed requirement, the
  same "frozen, do not silently re-resolve" guarantee `uv sync --frozen`/`poetry install`
  give); the test command runs directly with no wrapper subcommand (`uv run`/`poetry run`
  have no pip equivalent). Environment markers (`; python_version < "3.9"`) are stripped, not
  evaluated — v1/v2 has no per-environment resolution concept.
- **Test command auto-detection (done)**: `detectPythonTestCommand` (`testrun.ts`) checks a
  short list of real, unambiguous conventions before the `["pytest"]` default: `pytest.ini`,
  a `[tool.pytest.ini_options]`/`[tool:pytest]`/`[pytest]` section in `pyproject.toml`/
  `setup.cfg`/`tox.ini`, and a Django `manage.py` (-> `python manage.py test`). No guessing
  beyond names pytest/Django themselves define — e.g. `tool.poetry.scripts` was considered
  and rejected: it defines console-script entry points, not a test-runner convention, so
  using it would have been a guess about intent rather than reading an explicit signal.
  `options.testCommand` still overrides detection entirely, in both `testrun.ts` and `real.ts`.

## Known v1/v2 gaps (open follow-ups, not started)

All five original v2 items (matcher, container mode, CLI polish, `requirements.txt`, test
command auto-detection) are done or partly done (see above). What's left, none started:

- `package.json` `bin` entry + the build step it needs (this module still isn't part of
  `dist`/`files`, so it isn't published to npm).
- SARIF output.
- A config file (mirroring `.ratchetrc`).
- A GitHub Action for this module.
