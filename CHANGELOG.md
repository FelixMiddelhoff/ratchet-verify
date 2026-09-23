# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

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
