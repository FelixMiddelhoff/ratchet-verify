# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Added
- Workspaces (#4): package.json `workspaces` (npm, yarn classic/berry) and `pnpm-workspace.yaml` are discovered (`src/workspaces/`). A dependency is direct if any workspace (or root) manifest names it; an npm copy under `<workspace>/node_modules` is direct when that workspace names it; pnpm reads every `importers` entry (was root only). Verdicts carry `workspaces: { declared, used }` (JSON optional field, text line, Markdown name cell). The usage scan already covered all packages. Test command unchanged and documented: root `scripts.test` only, none = "risky (unverified)". Single-dependency probes edit the declaring workspace (`npm -w`, `yarn workspace`, `pnpm --filter`, root: `yarn -W` / `pnpm -w`); several declarers = not tested on its own. The baseline/probe sandboxes get the old workspace manifests (`--base` via git; `--old-workspace-package-json <dir>=<file>`); a workspace absent at the base ref is removed from the old state.
- Usage scanner (#35): tsconfig/jsconfig `paths` and `baseUrl` (all configs above a file, `extends` chains incl. node_modules packages, JSONC via the TypeScript API, cycles guarded) and workspace package names/subpaths (`exports`, `module`/`main`, `dist`->`src`, `src/index`) resolve to project files, so re-exports through them are followed. Unlocatable targets (matching alias without a file, unreadable/missing `extends`, unparseable tsconfig, workspace entry not found, `#imports`) go to `UsageScan.unresolved` and downgrade safe to safe (partial).
- Corpus: chalk 4.1.2 -> 5.3.0 in a workspace package via npm, yarn classic and pnpm; lodash 4.17.20 -> 4.17.21 in a workspace package.

### Fixed
- Security: sandbox `files` keys are confined to the sandbox (absolute paths, drive letters, UNC, `..` and links pointing outside are refused; validated in `withSandbox` and at the CLI for `--old-workspace-package-json`). Before, a key like `../../x/package.json` could delete or overwrite a host file.
- Security: workspace patterns with `..`, absolute paths or drive letters, and workspace directories whose real path leaves the project, are ignored (with a note); `--old-workspace-package-json <dir>` must name a discovered workspace and an unreadable file is a clear error.
- Workspace globs: repeated `**` no longer blows up (12 `**` segments took 30 s); `\` in patterns is normalised; `node_modules` is never a workspace.
- `pnpm-workspace.yaml`: `packages:` items at column 0, quoted flow lists containing commas, multi-line flow lists and explicit `[]` are read correctly; a file that yields no packages is announced.
- pnpm workspaces with importers on different versions of one package: only the root importer's version keeps the plain path, other copies are keyed by major, so a bump of one importer's copy pairs up (was removed+added, unattributed) and is attributed to the importers that resolve that copy.
- `--base` now enumerates workspaces at the base ref (old `workspaces` globs, old `pnpm-workspace.yaml`): a removed workspace is restored and an added one deleted in the old state. Only "path not in the base tree" means absent; any other git failure is an error. Paths are read relative to the project directory (a project in a repo subdirectory works).
- Unnamed workspaces: `pnpm --filter ./<dir>`, `npm -w <dir>`, yarn is not tested on its own (needs a name); a workspace literally named `(root)` no longer collides with the root manifest label.
- Usage scan: `.vue`, `.svelte`, `.astro`, `.mdx` files and symlinked directories are reported in `unresolved` ("file type not scanned", "symlinked directory not followed") so a verdict is "safe (partial)" instead of a false "safe"; tsconfig `paths` lookup is indexed (a 200k-key config no longer takes minutes).

## [0.4.0] - 2026-09-24

### Documentation
- CI recipes for GitLab CI, Azure DevOps, CircleCI and Jenkins in `docs/ci.md`. These recipes are adapted from the GitHub Action and require platform-specific verification.

### Added
- Changelog sources (#7): GitLab (releases API + raw `CHANGELOG` files) and Bitbucket (raw files) repositories, and a changelog shipped in the npm tarball of the new version as the last fallback (also when the package has no supported repository). Priority: host releases, repo file, GitHub wiki, tarball; each fills only versions still missing, so `missingVersions` and the "no changelog" caveat stay accurate. The tarball is untrusted: https only, 20 MB download cap, 100 MB decompression cap, 1 MB per file, parsed in memory (root-level regular files only; `..`, absolute, nested and link entries ignored), never executed. Conventional-commit derived notes deliberately not added (noisy, low-trust, would mask the "no changelog" caveat).
- Last known-good suggestion (#14): an exact, confirmed bisection now suggests the last version ratchet tested passing, with `npm install name@x.y.z` for direct dependencies (text, Markdown PR comment, SARIF, and the optional JSON field `verdicts[].suggestion`; `schemaVersion` stays 1). Never shown for narrowed, flaky, unconfirmed or unbisected results.
- yarn.lock support (#2), classic v1 and berry v2+: hand-written parser (`src/lockfile/yarn.ts`) into the same install-map shape; several ranges per entry, scoped names, `npm:` aliases (the real package is reported, direct via the alias name), and workspace/git/file/patch entries skipped. Several versions of one name are keyed per range so a bump still lines up. `--base` reads `yarn.lock` with `git show`; the lockfile is detected in the project (or from `--old`/`--new`).
- `PackageManager` abstraction (`src/testrun/managers.ts`): frozen install (`yarn install --frozen-lockfile` / `--immutable`) and single-dependency probe (`yarn add name@ver --ignore-scripts` / `--mode=skip-build`) per manager, used by the isolation and bisect probes in `src/pipeline/real.ts`. A manager without a probe degrades to "not tested on its own", never a false safe. Ready for pnpm (#3).
- Corpus: chalk 4.1.2 -> 5.3.0 through yarn classic (skipped when yarn is not installed).
- pnpm-lock.yaml support (#3), lockfileVersion 5.x, 6.x and 9.x: hand-written reader for the YAML subset pnpm emits (`src/lockfile/pnpm.ts`, no new dependency) into the same install-map shape. `packages:`/`snapshots:`/`importers['.']`, peer suffixes (`(react@18)` and `_react@18`) stripped so versions line up, `npm:` aliases (real package reported, direct via the alias), git/file/link/directory/workspace entries skipped. Several versions of one name are keyed per major (the root's own version keeps the plain path). Frozen install `pnpm install --frozen-lockfile`; probe `pnpm add name@ver --lockfile-only --ignore-scripts`. `--base` reads `pnpm-lock.yaml` with `git show`; content-sniffing recognises a pnpm lockfile passed with `--old`.
- Sandbox env (temp-dir and container) redirects pnpm/corepack state: `XDG_*`, `PNPM_HOME`, `npm_config_store_dir`/`cache_dir`/`state_dir`, `COREPACK_HOME` all live under the sandbox home.
- Corpus: chalk 4.1.2 -> 5.3.0 through pnpm (skipped when pnpm is not installed).

### Fixed
- Container engine detection only accepts engines running Linux containers (docker must report `OSType` `linux`; podman is Linux). Docker in Windows-containers mode (e.g. GitHub `windows-latest` runners) is no longer picked: `--isolation auto` falls back to temp-dir with a note, `--isolation container` errors with how to switch to Linux containers, and real-engine tests skip.

### Changed
- CI runs lint and tests on Ubuntu, macOS and Windows (#11); the required `test` check fails unless every leg passes.
- `pnpm-lock.yaml` is now supported (see Added); the "pnpm lockfiles are not supported yet" error is gone. An unknown newer `lockfileVersion` errors with a clear message.

## [0.3.0] - 2026-09-24

### Added
- Usage scanner (#6): re-exports through the project's own modules (`export {x} from`, `export *`, chains, `index` files) are followed, so uses in importing files count as package use. Local shadowing (parameters, `let`/`const`/`var`, functions, classes, catch and loop variables) is ignored; unsure cases still count. CommonJS forwarding (`module.exports = require('pkg')` and variants) is followed. Forms it cannot follow (`wrap(pkg)`, computed require paths, unstable re-export chains) are reported in `UsageScan.unresolved` and downgrade safe to safe (partial). Not handled here: tsconfig path aliases and workspace specifiers (see #35 in Unreleased).
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

[0.4.0]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.4.0
[0.3.0]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.3.0
[0.2.0]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.2.0
[0.1.1]: https://github.com/FelixMiddelhoff/ratchet-verify/releases/tag/v0.1.1
