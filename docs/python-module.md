# The Python module

`ratchet-python` verifies a Python dependency bump the same way the npm core verifies a
JavaScript one: install the candidate lockfile in a sandbox, run your real tests, cross-check
the changelog's breaking-change notes against what your code actually imports, and — if tests
fail — bisect down to the exact version that broke them.

It lives in `python-module/` in this same repository, as a separate module rather than
bolted onto the npm core (Python's tooling, lockfile formats and package index are different
enough to warrant that). It isn't a separate npm package — it ships as part of the same
`ratchet-verify` package (from v0.9.0 onward), adding a second `ratchet-python` bin alongside
`ratchet`/`ratchet-verify`. See [Installing it](#installing-it) below.

This page is the user-facing "what is it, how do I run it" guide. For a two-minute worked
example with real command output, see [tutorial-python.md](tutorial-python.md). For
build/scope/decision history, see issue
[#15](https://github.com/FelixMiddelhoff/ratchet-verify/issues/15) and
[CHANGELOG.md](../CHANGELOG.md).

## What it checks

For every changed entry between your old and new lockfile:

1. **Tests** — installs the new lockfile (frozen: `uv sync --frozen`, `poetry install`, or
   `pip install --require-hashes`, none of which will silently re-resolve a version for you)
   and runs your test command.
2. **Changelog vs. usage** — fetches the package's changelog from PyPI/GitHub and checks
   whether any breaking-change note names a symbol your code actually imports. A hit downgrades
   an otherwise-passing bump from `safe` to `risky`, with the file, line and changelog excerpt
   as evidence.
3. **Bisection** — if tests fail, installs each version between old and new (binary search, not
   linear) until it finds the exact one that broke them, and reports it with a confirmation
   re-run so a flaky suite doesn't get blamed on the wrong version.

The result is one of three verdicts, same meaning as the npm core's:

- **safe** — tests pass, and either no breaking change in the changelog touches your code, or
  (marked as reduced confidence) there was nothing to check because no changelog was found.
- **risky** — tests pass but the changelog names something you use as breaking, or the bump
  could not be verified at all (no lockfile manager detected, the baseline already fails, etc).
- **broken** — tests fail, ideally with the exact culprit version from bisection.

## Requirements

- Node.js 24+ (to run the CLI itself — this project is written in TypeScript).
- Python 3 on `PATH` (for the static usage scan, which shells out to Python's own `ast`
  module — no Python package is installed for this, just the interpreter).
- `uv`, `poetry`, or `pip` — whichever your project's lockfile needs — installed and on `PATH`
  (or present in the container image, if using `--container`).
- git, only if you use `--base <ref>` instead of an explicit `--old-lockfile` path.

## Installing it

**From npm (v0.9.0+), no clone needed:**

```bash
npx --package ratchet-verify@latest ratchet-python --project . --base main
```

Or install it once and get the `ratchet-python` command directly:

```bash
npm install -g ratchet-verify
ratchet-python --project /path/to/your/python/project --base main
```

(There's a separate `ratchet-verify`/`ratchet` bin for the npm core in the same package —
`ratchet-python` is the one this module adds.)

**From a checkout** (for working on this module itself, or to run an unreleased commit):

```bash
git clone https://github.com/FelixMiddelhoff/ratchet-verify.git
node --experimental-strip-types ratchet-verify/python-module/cli.ts --project . --base main
```

`--experimental-strip-types` is a real Node 24 flag — it type-strips TypeScript at runtime
without a build step. Or build it first: `npm ci && npm run build` (compiles both the npm
core's `dist/` and this module's `dist-python/`), then `node dist-python/python-module/cli.js`
or `npm link` for a local `ratchet-python` command.

## Quick example

A project using `uv`, with `pyproject.toml` and `uv.lock` already committed:

```bash
cd your-python-project
uv add requests==2.32.3     # bumps requests, updates uv.lock
git add pyproject.toml uv.lock
```

Before committing, check the bump against the last commit (`--base HEAD` reads the *previous*
committed `uv.lock`; `--new-lockfile` defaults to the working tree's current one):

```bash
node --experimental-strip-types /path/to/ratchet-verify/python-module/cli.ts \
  --project . --base HEAD
```

Output looks like:

```
ratchet: overall safe

requests (2.31.0 -> 2.32.3): SAFE — tests pass, no breaking change detected
```

Or, if something broke:

```
ratchet: overall broken

requests (2.31.0 -> 2.32.3): BROKEN — broken by 2.32.0 (2.31.0 still passed)
  evidence: broke between 2.31.0 and 2.32.0 (exact)
```

## CLI reference

```
ratchet-python --project <dir> (--old-lockfile <path> | --base <git-ref>)
                [--new-lockfile <path>]
                [--lockfile-name uv.lock|poetry.lock|requirements.txt]
                [--container <image>]
                [--format text|json|sarif]
                [--test <cmd...>]
```

| Flag | Meaning |
|---|---|
| `--project <dir>` | Required. The Python project's directory. |
| `--old-lockfile <path>` | The "before" lockfile, as a plain file path. Exactly one of this or `--base` is required. |
| `--base <ref>` | The "before" lockfile is read from this git ref instead (e.g. `main`, `HEAD`, a commit SHA) — the project directory must be inside a git repository for this to work. |
| `--new-lockfile <path>` | The "after" lockfile. Defaults to `<project>/<lockfile-name>` — the working tree's current lockfile, which is the common case ("does my uncommitted bump still work against `main`"). |
| `--lockfile-name <name>` | `uv.lock`, `poetry.lock`, or `requirements.txt`. Guessed from `--new-lockfile`/`--old-lockfile`'s filename when omitted. |
| `--container <image>` | Run installs and tests inside this docker/podman image instead of a temp-dir sandbox. See [Isolation](#isolation) below. |
| `--format` | `text` (default), `json` (the full report as JSON), or `sarif` (for GitHub code scanning). |
| `--test <cmd...>` | Everything after this flag is the test command, e.g. `--test python -m pytest -x`. Must be last — no flags after it are parsed. Overrides auto-detection (see below). |

**Exit codes**: `0` overall verdict is `safe` or `risky`, `1` overall verdict is `broken`, `2`
usage error or a runtime failure (unreadable lockfile, unknown git ref, missing `uv`/`poetry`/`pip`, etc — the message on stderr says which).

### Test command

If `--test` isn't given, the CLI looks for real, unambiguous signals before defaulting to
`pytest`: a `pytest.ini` file, a `[tool.pytest.ini_options]`/`[tool:pytest]`/`[pytest]` section
in `pyproject.toml`/`setup.cfg`/`tox.ini`, or a Django `manage.py` (→ `python manage.py test`).
Nothing fuzzier than that — e.g. `tool.poetry.scripts` is not used as a signal, since it defines
console-script entry points, not a test-runner convention.

### Isolation

Without `--container`, installs and tests run in a temp-dir sandbox: a scrubbed environment
(only `PATH` and a few others pass through) with `HOME`/`TMPDIR`/pip's and uv's/poetry's own
cache and config directories all redirected into the temp dir, so nothing reads your real
`~/.netrc`, pip config, or leaves anything behind. It does **not** stop an install script from
reading absolute host paths it already knows.

With `--container <image>`, installs and tests run inside a docker or podman container that
can only see the sandbox's own mount — no host filesystem access at all, install-script or not.
The image must have `uv`/`poetry` preinstalled if your lockfile needs one (a stock
`python:3.x-slim` ships `pip` but not `uv` or `poetry`); the CLI checks this upfront and fails
with a clear message rather than failing every candidate version one by one.

## Config file

Put a `.ratchetrc.python` JSON file in your project directory to set defaults, so you don't
have to repeat flags every run:

```json
{
  "lockfileName": "uv.lock",
  "testCommand": ["pytest", "-x"],
  "containerImage": "ghcr.io/you/python-with-uv:3.12",
  "maxInstalls": 15,
  "testTimeoutMs": 600000,
  "installTimeoutMs": 600000,
  "format": "json"
}
```

| Option | Default | Meaning |
|---|---|---|
| `lockfileName` | guessed | `uv.lock`, `poetry.lock`, or `requirements.txt`. |
| `testCommand` | `["pytest"]` (or auto-detected) | The command to run tests. |
| `containerImage` | none | Same as `--container`. |
| `maxInstalls` | `10` | Installs allowed per bisection; past it the result is a narrowed range instead of one exact version. |
| `testTimeoutMs` | `600000` | A test run longer than this is killed and counts as a failure. |
| `installTimeoutMs` | `600000` | Same, for the install step. |
| `format` | `"text"` | `"text"`, `"json"`, or `"sarif"`. |

Unknown keys are an error (a typo'd option silently ignored would hide a weakened check, same
policy as the npm core's `.ratchetrc`). CLI flags always override the config file.

## GitHub Action

```yaml
- uses: FelixMiddelhoff/ratchet-verify/.github/actions/ratchet-python@main
  with:
    project-dir: .
    format: json
```

The action runs `npx --package ratchet-verify@<version> ratchet-python` under the hood, same
idea as the npm core's own action (`.github/actions/ratchet/`), just with the `ratchet-python`
bin instead. Inputs: `base`, `project-dir`, `lockfile-name`, `container-image`, `format`,
`ratchet-version` (npm version or tag, default `latest`), `node-version`. Outputs: `verdict`
(only populated when `format: json`) and `report-file`. With `format: sarif`, results are
uploaded to GitHub code scanning automatically. There's no PR-comment posting yet (the npm
core's action has one; this is a known gap, not a design decision).

## Output format (`--format json`)

```json
{
  "schemaVersion": 1,
  "overall": "risky",
  "verdicts": [
    {
      "name": "requests",
      "oldVersion": "2.31.0",
      "newVersion": "2.32.0",
      "status": "risky",
      "confidence": "full",
      "summary": "tests pass, but the changelog names 1 symbol use in your code as breaking",
      "evidence": [
        {
          "kind": "call-site",
          "symbol": "get_legacy",
          "file": "app.py",
          "line": 12,
          "changelogVersion": "2.32.0",
          "changelogExcerpt": "`get_legacy` was removed",
          "matchConfidence": "high",
          "reason": "named in a breaking-change section"
        }
      ],
      "caveats": [],
      "notes": []
    }
  ]
}
```

`evidence[].kind` is one of `bisect`, `test-failure`, `call-site`, or `no-tests` (the
"could not verify this at all" case). `caveats` are reasons a `safe` verdict is only partial
(no changelog found, usage scan incomplete); `notes` are informational, never affect the verdict.

## Known limitations

- **Scope**: `uv.lock`, `poetry.lock`, and hash-pinned `requirements.txt` (`pip-compile`
  output) only — a loose, unpinned `requirements.txt` has no single dependency graph to diff.
- **No workspaces/monorepo support** (the npm core has this; Python's ecosystem doesn't have
  as strong a single convention for it, and it wasn't in scope for v1/v2).
- **Single test command guess**: falls back to `pytest` if nothing more specific is detected
  (see [Test command](#test-command)) — pass `--test` explicitly if that's wrong for your project.
- **No PR-comment posting** from the GitHub Action yet (the npm core's action has one).
- **Environment markers** in `requirements.txt` (`; python_version < "3.9"`) are stripped, not
  evaluated — there's no per-environment resolution concept in this module.

Found something else confusing or wrong? Open an issue.
