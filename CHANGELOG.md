# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Documentation
- CI recipes for GitLab CI, Azure DevOps, CircleCI and Jenkins in `docs/ci.md`. These recipes are adapted from the GitHub Action and require platform-specific verification.

### Added
- Changelog sources (#7): GitLab (releases API + raw `CHANGELOG` files) and Bitbucket (raw files) repositories, and a changelog shipped in the npm tarball of the new version as the last fallback (also when the package has no supported repository). Priority: host releases, repo file, GitHub wiki, tarball; each fills only versions still missing, so `missingVersions` and the "no changelog" caveat stay accurate. The tarball is untrusted: https only, 20 MB download cap, 100 MB decompression cap, 1 MB per file, parsed in memory (root-level regular files only; `..`, absolute, nested and link entries ignored), never executed. Conventional-commit derived notes deliberately not added (noisy, low-trust, would mask the "no changelog" caveat).
- Last known-good suggestion (#14): an exact, confirmed bisection now suggests the last version ratchet tested passing, with `npm install name@x.y.z` for direct dependencies (text, Markdown PR comment, SARIF, and the optional JSON field `verdicts[].suggestion`; `schemaVersion` stays 1). Never shown for narrowed, flaky, unconfirmed or unbisected results.
- yarn.lock support (#2), classic v1 and berry v2+: hand-written parser (`src/lockfile/yarn.ts`) into the same install-map shape; several ranges per entry, scoped names, `npm:` aliases (the real package is reported, direct via the alias name), and workspace/git/file/patch entries skipped. Several versions of one name are keyed per range so a bump still lines up. `--base` reads `yarn.lock` with `git show`; the lockfile is detected in the project (or from `--old`/`--new`).
- `PackageManager` abstraction (`src/testrun/managers.ts`): frozen install (`yarn install --frozen-lockfile` / `--immutable`) and single-dependency probe (`yarn add name@ver --ignore-scripts` / `--mode=skip-build`) per manager, used by the isolation and bisect probes in `src/pipeline/real.ts`. A manager without a probe degrades to "not tested on its own", never a false safe. Ready for pnpm (#3).
- Corpus: chalk 4.1.2 -> 5.3.0 through yarn classic (skipped when yarn is not installed).

### Changed
- A lone `pnpm-lock.yaml` now errors with "pnpm lockfiles are not supported yet".

## [0.3.0] - 2026-09-24

### Added
- Usage scanner (#6): re-exports through the project's own modules (`export {x} from`, `export *`, chains, `index` files) are followed, so uses in importing files count as package use. Local shadowing (parameters, `let`/`const`/`var`, functions, classes, catch and loop variables) is ignored; unsure cases still count. CommonJS forwarding (`module.exports = require('pkg')` and variants) is followed. Forms it cannot follow (`wrap(pkg)`, computed require paths, unstable re-export chains) are reported in `UsageScan.unresolved` and downgrade safe to safe (partial). Not handled: tsconfig path aliases and workspace specifiers.
- Corpus: five more cases with independently verified outcomes (debug, is-number, yargs, uuid main-entry and the deep-require uuid case that is broken).
- Container mode restricts egress for the test phase (#23): the project's tests run in a separate container with `--network none`, so a test (or anything it loads) cannot send data out. The install phase keeps the network. Opt out with `--network open` / `"containerNetwork": "open"` (Action input `network`) for suites that need the network.
- Bisector flaky detection (#8): the reported first-bad and last-good versions are re-run once each. A flipped result gives status `unstable` (verdict stays broken, reads "flaky suite: result not reliable", no exact culprit); inconclusive or unaffordable re-runs are marked unconfirmed. The 2 re-runs are reserved from `maxInstalls`, so total installs never exceed it. `BisectResult.confirmation`, `bisect(..., { confirm })`.

### Changed
- Container mode now runs `npm test` offline by default. Projects whose tests reach the network must set `containerNetwork: "open"`. Not restricted: install scripts still have the network (no per-host allowlist in docker/podman).
- Changelog fetcher: a pointer `CHANGELOG` file with no version headings (lodash) no longer ends the file search; more file-name variants tried (`Changelog.md`, `History.md`, `NEWS.md`, ...); changelogs kept in the GitHub wiki (`raw.githubusercontent.com/wiki/...`, lodash) are read as a last fallback; the rate-limit note now says to set `GITHUB_TOKEN`. Real-fetch finding: the debug "no changelog" report was unauthenticated GitHub rate limiting (60/h), not a missing changelog; is-number truly has none.
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

[0.3.0]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.3.0
[0.2.0]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.2.0
[0.1.1]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.1.1
