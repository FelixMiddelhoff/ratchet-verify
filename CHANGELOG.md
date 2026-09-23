# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Added
- Container isolation (`--isolation container|auto|temp-dir`, `isolation`, `containerRuntime` and `containerImage` in `.ratchetrc`): installs and tests run in a docker or podman container that only sees the sandbox directory.
- Every report states the isolation level (text, JSON `isolation`, Markdown footer).
- GitHub Action input `isolation`.
- Corpus case that runs the full pipeline inside a container.

### Changed
- Text output now ends with an `isolation:` line.

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

[0.1.1]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.1.1
