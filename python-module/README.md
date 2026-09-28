# Python module

Verifies a Python dependency bump (`uv.lock`, `poetry.lock`, or a hash-pinned
`requirements.txt`) the same way the npm core verifies a JavaScript one: install the candidate
lockfile in a sandbox, run your real tests, cross-check the changelog's breaking-change notes
against what your code actually imports, and bisect down to the exact version if tests fail.

It's a separate module next to `src/` rather than bolted onto the npm core, since Python's
tooling, lockfile formats and package index are different enough to warrant that. Reuses the
npm core's generic (non-npm-specific) pieces directly where the concepts line up — git-ref
reading, container-engine detection, changelog markdown classification — and has its own
version of anything that isn't (lockfile parsing, PEP 440 version ordering, environment
variables for pip/uv/poetry).

**Full usage guide, CLI reference, config file and GitHub Action docs:**
[docs/python-module.md](../docs/python-module.md).

## Quick start

```bash
node --experimental-strip-types python-module/cli.ts \
  --project /path/to/your/python/project --base main
```

Requires Node 24+, Python 3 on `PATH`, and whichever of `uv`/`poetry`/`pip` your project's
lockfile needs. See [docs/python-module.md](../docs/python-module.md) for build/install
options, a worked example, and everything else.

## Status and history

Built out fully across issue [#15](https://github.com/FelixMiddelhoff/ratchet-verify/issues/15)
and its follow-ups. For what shipped when and why specific implementation choices were made
(what's reused from the npm core vs. reimplemented, and why), see the PR history on that issue
and [CHANGELOG.md](../CHANGELOG.md). Known limitations are listed in
[docs/python-module.md](../docs/python-module.md#known-limitations).

Contributions welcome — open an issue before a large change.
