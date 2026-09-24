# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Added
- Bisector flaky detection (#8): the reported first-bad and last-good versions are re-run once each. A flipped result gives status `unstable` (verdict stays broken, reads "flaky suite: result not reliable", no exact culprit); inconclusive or unaffordable re-runs are marked unconfirmed. The 2 re-runs are reserved from `maxInstalls`, so total installs never exceed it. `BisectResult.confirmation`, `bisect(..., { confirm })`.

### Changed
- Removed `registry-url` from setup-node in release workflow (npm Trusted Publisher OIDC handles registry authentication).
- Bumped `actions/setup-node` from v4 to v7 in GitHub Action.
- Changelog matching (#5): common-word symbols (`option`, `parse`, `get`, ...) named only in bare prose are capped at medium confidence in breaking sections and no longer match plain lines of a major release. Backticks, `.symbol` and `symbol(` keep full strength. Nothing is dropped from breaking sections or removal notes.

- Changelog matching: a `pkg/sub` deep-import token (e.g. `require('uuid/v4')`) no longer matches a root-import member of the same name (`require("uuid").v4`). It matches only sites importing that subpath, which stay high confidence; root-import use gets no hit from that bullet. Namespace sites from subpath imports now carry `subpath`.
- Changelog matching: a subpath token no longer matches inside a URL in the notes (`yargs/yargs` in `github.com/yargs/yargs/issues/1`), which had turned the yargs 15 to 16 bump risky.

## [0.2.0] - 2026-09-23

### Added
- Container isolation (`--isolation container|auto|temp-dir`, `isolation`, `containerRuntime` and `containerImage` in `.ratchetrc`): installs and tests run in a docker or podman container that only sees the sandbox directory.
- Every report states the isolation level (text, JSON `isolation`, Markdown footer).
- GitHub Action input `isolation`.
- Corpus case that runs the full pipeline inside a container.

### Changed
- Text output now ends with an `isolation:` line.
- Long runs of versions without changelog notes are summarised ("58 versions (25.0.0 to 26.6.2)") instead of listed one by one.

## [0.1.1] - 2026-09-23

### Added
- Lockfile diff for `package-lock.json` versions 1, 2 and 3.
- Sandboxed install and test run with a scrubbed environment.
- Static usage scan (TypeScript compiler API) of the packages a project imports.
- Changelog lookup from GitHub releases and `CHANGELOG.md` files.
- Matching of changelog breaking changes against usage sites.
- Bisection of a failing version range.
- safe / risky / broken verdicts with evidence; text, JSON, SARIF and Markdown output.
- Command line interface, `.ratchetrc`, and a GitHub Action with a pull request comment.
- `--version` flag.
- Issue template for wrong or surprising verdicts, and CONTRIBUTING.md.
- Documentation: two-minute demo, CI guide, report-format reference, troubleshooting.

### Changed
- A missing `package-lock.json` now says what ratchet supports (and mentions a
  found `yarn.lock` / `pnpm-lock.yaml`) instead of a bare `ENOENT`.

[0.2.0]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.2.0
[0.1.1]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.1.1
