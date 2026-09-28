# ratchet-verify: Python ecosystem module

**Looking for how to use it?** See [docs/python-module.md](../docs/python-module.md) — this
file is the build/design history (phase-by-phase decisions, what's reused from the npm core
and why, known gaps), not a user guide.

Tracks issue #15. All 7 phases below are done (v1). This file starts as the phase-1 design
lock (posted as a comment on #15) and now doubles as the module's own decision log.

## Usage

Direct from source (no build needed):

```
node --experimental-strip-types python-module/cli.ts \
  --project /path/to/python/project \
  (--old-lockfile /path/to/old/uv.lock | --base main) \
  [--new-lockfile /path/to/new/uv.lock] \
  [--lockfile-name uv.lock|poetry.lock|requirements.txt] [--container <image>] [--format text|json|sarif] [--test pytest -x]
```

Or built: `npm run build` compiles `python-module/` into `dist-python/` (via
`tsconfig.build.python.json`, a second `tsc` pass alongside the npm core's own `dist` build)
and the `package.json` `bin` entry runs it as `ratchet-python` once installed — this module
still isn't published to npm as its own release yet, but the build/bin wiring is real and
runnable locally (`npm link`, or `node dist-python/python-module/cli.js` directly). The
`dist-python/` build also contains its own nested copy of the compiled npm core
(`dist-python/src/...`), since `python-module/*.ts` imports it by relative path and there is
no bundler in this project (deliberately: no external build-tool dependency) to flatten that
away — a documented size tradeoff, not a bug.

`--base <ref>` reads the old lockfile from that git ref instead of a plain file path, reusing
`readFileAtRef` from `src/cli/git.ts` directly (reading a file at a git ref is a git concept,
not an npm one). Exactly one of `--old-lockfile`/`--base` is required. `--new-lockfile` is
optional and defaults to `<project>/<lockfile-name>` (the working tree's current lockfile) —
the common case is "does the working tree's bump still work against the base branch".

`--format json`/`--format sarif` render the report as JSON (`renderPythonJson`) or SARIF 2.1.0
(`renderPythonSarif`, ported from `src/report/sarif.ts` — same rule set, `pyproject.toml` as
the fallback artifact location instead of `package.json`) instead of text.

`--container <image>` runs installs and tests inside a docker/podman container instead of a
temp-dir sandbox (stronger isolation: the container only sees the sandbox mount, nothing else
of the host). The image must ship `uv`/`poetry`/`pip` (whichever the lockfile needs; `pip`
is assumed present on any Python image and is not probed for) — a stock `python:3.x-slim`
ships pip but not uv or poetry, and the CLI fails early with that message via
`ensurePythonManagerInImage` rather than failing per-candidate later. Without `--container`,
temp-dir isolation is used (env allowlist + redirected home, no filesystem confinement).

### Config file

A `.ratchetrc.python` JSON file in the project directory supplies defaults for `lockfileName`,
`testCommand`, `containerImage`, `maxInstalls`, `testTimeoutMs`, `installTimeoutMs` and
`format` (`config.ts`, mirroring `src/config.ts`'s validation style — unknown keys are errors,
every field is validated — at python-module's much smaller option set: no registry-proxy
settings exist here, those are npm-registry-specific). CLI flags always override the config
file, which overrides the built-in defaults.

### GitHub Action

`.github/actions/ratchet-python/action.yml` checks out `FelixMiddelhoff/ratchet-verify` at a
pinned ref (`ratchet-ref` input, default `main`) into a scratch directory, builds it there
(`npm ci && npm run build`), then runs `dist-python/python-module/cli.js` against the calling
repo's project directory — this module isn't published to npm yet, so there is no `npx
ratchet-python@version` shortcut the way the npm core's own action has (`.github/actions/
ratchet/action.yml`); this is the honest workaround until it is. Inputs: `base`, `project-dir`,
`lockfile-name`, `container-image`, `format`, `ratchet-ref`, `node-version`. Outputs: `verdict`
(only populated for `format: json` — `text`/`sarif` output isn't parsed for it, a documented
gap) and `report-file`. SARIF is uploaded to code scanning automatically when `format: sarif`.
No PR-comment posting yet (the npm core's action has one; porting `renderPythonText`'s output
into a comment is a natural next increment, not done here).

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

- **CLI polish (done)**: `--base` git-ref reading, `--format json`/`--format sarif`, a
  `.ratchetrc.python` config file, a `package.json` `bin` entry with its own build step
  (`tsconfig.build.python.json` -> `dist-python/`), and a GitHub Action
  (`.github/actions/ratchet-python/`). See the Usage section above for details on each.
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

## Known gaps (open follow-ups, not started)

All five original v2 items, and the CLI-polish leftovers (SARIF, config file, bin entry/build
step, GitHub Action), are done. What's left:

- This module is not published to npm as its own release — the build/bin wiring is real and
  works locally, but there's no `npx ratchet-python` yet. The GitHub Action works around this
  by checking out and building the source directly.
- The Action doesn't post a PR comment (the npm core's action does) and only parses `verdict`
  from `format: json` output.
- No container-mode dedicated CI job (verified manually against real podman on the dev box
  instead — see the v2 progress entry above).
- No breaking-change matcher coverage beyond `from-import` symbol names and whole-module
  `import pkg` flags (no subpath/default-export equivalents, since Python's import shape
  doesn't have JS's forwarding/re-export patterns that motivated those).
