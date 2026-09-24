# ratchet

[![npm version](https://img.shields.io/npm/v/ratchet-verify?logo=npm&color=cb3837)](https://www.npmjs.com/package/ratchet-verify)
[![npm downloads](https://img.shields.io/npm/dm/ratchet-verify?logo=npm)](https://www.npmjs.com/package/ratchet-verify)
[![CI](https://github.com/FelixMiddelhoff/ratchet-verify/actions/workflows/ci.yml/badge.svg)](https://github.com/FelixMiddelhoff/ratchet-verify/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/ratchet-verify?logo=nodedotjs)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/ratchet-verify)](LICENSE)
[![runtime dependencies: 1](https://img.shields.io/badge/runtime%20dependencies-1-brightgreen)](package.json)
[![help wanted](https://img.shields.io/github/issues/FelixMiddelhoff/ratchet-verify/help%20wanted?label=help%20wanted&color=blue)](https://github.com/FelixMiddelhoff/ratchet-verify/labels/help%20wanted)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#help-wanted)

*Don't just bump the version — prove it still works.*

Dependabot and Renovate open a pull request when a new version exists. That is
the whole feature. They don't run your tests against the bump in isolation,
don't check whether the release notes' breaking changes touch code you
actually have, and don't tell you which of five transitive bumps in a
lockfile diff broke CI.

**ratchet** does. Given the lockfile before and after a bump, it

1. installs the new lockfile in a sandbox and runs your **real test suite**,
2. reads the changelog for every version in between and checks its **breaking
   changes against the symbols your code really imports and calls**,
3. when the tests fail, **bisects** the version range to the exact release
   that broke them.

You get one verdict per changed dependency — **safe**, **risky** or
**broken** — each with the evidence behind it: a changelog excerpt and the
`file:line` it hits, or the bisected version and the failing test output.
A "safe" that rests on incomplete information says so instead of pretending.

```
$ ratchet-verify . --base main
BROKEN  chalk 4.1.2 -> 5.3.0 (direct)
  broken by 5.0.0 (4.1.2 still passed)
  - bisected in 2 installs: last good 4.1.2, first bad 5.0.0
    | TypeError: chalk.red is not a function
    | …
```

```
RISKY  commander 8.3.0 -> 9.0.0 (direct)
  tests pass, but the changelog names 2 symbol uses in your code as breaking
  - cli.js:3  program.option("-d, --debug", "enable debug output");
    changelog 9.0.0 (high): - *Breaking:* default value specified for boolean option now always used as default value …
```

## Contents

[Quick start](#quick-start) · [How it works](#how-it-works) ·
[Verdicts](#verdicts-at-a-glance) · [Command line](#command-line) ·
[GitHub Action](#github-action) · [Safety of the install step](#safety-of-the-install-step) ·
[Limitations](#limitations) · [FAQ](#faq) · [Help wanted](#help-wanted) ·
[Development](#development)

## Quick start

Requirements: Node.js 24 or newer, npm, git, and an npm project with a
`package-lock.json` (lockfile version 1, 2 or 3).

```
npm install -g ratchet-verify        # or run it with: npx ratchet-verify
cd /path/to/your/project             # a git repo with the bump applied
ratchet-verify . --base main         # the short alias `ratchet` works too
```

`--base main` compares the working tree's `package-lock.json` with the one
on `main`. Exit code `0` means ok, `1` means a verdict at or above
`--fail-on` (default `broken`), `2` means a usage or runtime error.

More in [docs/](docs/README.md): a [two-minute demo and tutorial](docs/tutorial.md)
with real output, what every [verdict and caveat means](docs/verdicts.md),
[CI recipes](docs/ci.md) (GitHub Action, Dependabot/Renovate, other systems),
the [configuration reference](docs/configuration.md), the
[report formats](docs/report-format.md) and [troubleshooting](docs/troubleshooting.md).

## How it works

```
package.json + old/new package-lock.json
        |
        v
  Lockfile-Diff --> changed dependencies (direct / transitive)
        |
        v   per dependency
  Changelog-Fetcher (GitHub releases + CHANGELOG.md)   Usage-Scanner (TypeScript AST)
        \                                                /
         '--> Breaking-Change-Matcher --> hits with excerpt + file:line
        |
        v
  Sandbox: install candidate lockfile, run your test script
        |-- passes ---------------------------> safe / risky
        '-- fails --> baseline check on the old lockfile
                      --> test each direct bump alone --> Bisector --> exact version
        |
        v
  Verdict-Reporter --> text | JSON | SARIF | PR comment
```

- **One runtime dependency.** Only `typescript`, used as a parser (it reads JS
  and TS alike). HTTP, CLI parsing, process spawning and file I/O are Node
  built-ins. A tool that judges supply-chain safety should have a small
  supply chain of its own.
- **Isolated installs.** Optionally in a docker/podman container that sees
  only the sandbox directory (see below).
- **Failures are explained, not just reported.** If the suite was already red
  on the old lockfile, that is not blamed on the bump. If several
  dependencies changed, each direct one is tested alone, and only the ones
  that reproduce the failure are bisected.
- **Silence is not a safety claim.** No changelog, a major-version bump, a
  file that would not parse, or a whole-module import all become explicit
  caveats on the verdict.

## Verdicts at a glance

| Verdict | Meaning | Evidence shown |
|---|---|---|
| **safe** | Tests pass and nothing in the changelog names code you use. | – |
| **safe (partial)** | Tests pass, but a signal is missing (no changelog, major bump, unparsed file, …). | The caveats |
| **risky** | Tests pass, but the changelog names a symbol you use as breaking; or nothing could be run to verify the bump. | Changelog excerpt + `file:line` |
| **broken** | Tests fail, hang, or the install fails. | Bisected version (or narrowed range) + failing output |

Details and every caveat: [docs/verdicts.md](docs/verdicts.md).

## Command line

```
ratchet-verify [project-dir] (--base <git-ref> | --old <lockfile>) [options]

  --base <ref>        compare against package-lock.json at this git ref
  --old <file>        compare against this lockfile instead of a git ref
  --old-package-json <file>  package.json that goes with --old
  --new <file>        lockfile with the proposed bump (default: project's)
  --json | --sarif | --markdown   output format (default: text)
  --report-dir <dir>  also write report.json, report.md and report.sarif
  --isolation <mode>  temp-dir (default), container (docker/podman) or auto
  --fail-on <level>   exit 1 on "broken" (default) or "risky"
  -v, --version       print the version
```

Project options (`ignore`, `maxInstalls`, `testTimeoutMs`, `failOn`, `isolation`, `containerRuntime`, `containerImage`) live in
a `.ratchetrc` file: see [docs/configuration.md](docs/configuration.md).

## GitHub Action

`.github/actions/ratchet/action.yml` runs ratchet on pull requests, keeps a
single verdict comment up to date, optionally uploads SARIF to code scanning,
and fails the check according to `fail-on`.

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write      # verdict comment
  security-events: write    # only with sarif: true
jobs:
  ratchet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }     # the base commit's lockfile must be readable
      - uses: FelixMiddelhoff/ratchet-verify/.github/actions/ratchet@main
        with: { fail-on: broken, sarif: "true" }
```

## Safety of the install step

Installing a candidate version runs its install scripts, and attacks such as
the April 2026 SAP CAP "mini Shai-Hulud" steal credentials at exactly that
moment. ratchet has two isolation levels, and every report states which one
was used:

- **`temp-dir` (default).** Installs run in a temporary copy of the project
  with an *allowlisted* environment (no `GITHUB_TOKEN`, `NPM_TOKEN`, cloud
  credentials) and a redirected home directory, so the usual `~/.npmrc` and
  `~/.aws` lookups find nothing. An install script that reads absolute host
  paths, or reaches the network, is **not** stopped.
- **`container` (`--isolation container`).** Everything runs in a docker or
  podman container whose only mount is the sandbox directory, with all
  capabilities dropped and a from-scratch environment. A script that tries to
  read `~/.ssh` or any other host path finds nothing there. `--isolation auto`
  uses a container when an engine is available. The test phase runs in its
  own container with no network (`--network none`), so tests cannot send data
  out; `--network open` restores the network for suites that need it. The
  install phase still has full network access (install scripts run there and
  no per-host allowlist exists), so a malicious install script can still
  exfiltrate what it can see, which in a container is only the sandbox.
  `temp-dir` restricts nothing.

The repository's [corpus](corpus/) replays a credential-stealing `preinstall`
script and checks that nothing leaks, and an integration test shows the
difference between the levels: a script can read a host file under `temp-dir`
and cannot inside a container. Run ratchet on CI runners or disposable
machines either way. Details: [docs/configuration.md](docs/configuration.md#isolation).

## Limitations

- **Install-phase network is open.** In container mode tests run offline, but
  install scripts can reach any host (only the sandbox is readable to them).
- **Tests-based.** ratchet proves "your tests still pass and no cited
  breaking change hits your code". It does *not* prove a version isn't
  malicious: behaviour-preserving malice (the event-stream and ua-parser-js
  incidents) passes a test suite. Such bumps end as "safe (partial)", never a
  full-confidence "safe", and the sandbox at least withholds your credentials.
- **Only as good as your tests.** No `scripts.test` means "risky
  (unverified)", never "safe".
- **npm and `package-lock.json` only** for now. Yarn and pnpm lockfiles are
  not diffed; Python and other ecosystems don't exist yet; monorepo
  workspaces aren't understood.
- **Changelog matching is by identifier**, so common words (`option`,
  `parse`) can match an unrelated breaking note. False positives cost a
  minute of review; a missed break costs an incident, and ratchet prefers the
  former.
- **Private registries** that need `.npmrc` credentials can't authenticate
  inside the sandbox.
- **GitHub-hosted changelogs only**: release notes or a `CHANGELOG.md` in a
  GitHub repository.

## FAQ

**Why not just use Dependabot or Renovate?** Use them — ratchet complements
them. They open the pull request; ratchet is the check that says whether it is
safe to merge, and why.

**Does it change my project?** No. It reads your lockfiles and source, and
installs and tests inside a temporary copy that is deleted afterwards.

**Which package manager runs the install?** `npm ci`, then your own
`scripts.test`. The test runner also recognises yarn and pnpm lockfiles, but
only `package-lock.json` is diffed today (see Help wanted).

**Will it call an outdated dependency "broken"?** Only when the tests fail
(or hang, or the install fails) on the new version and pass on the old one.
A suite that is already failing is reported as unverified, not blamed on the
bump.

**Is the name `ratchet`?** The product is called ratchet; on npm it is
`ratchet-verify` (`ratchet` was taken). Both commands work.

## Help wanted

ratchet is young, and there is a lot of well-defined work where an outside
contribution makes a real difference. Everything below is open, and most items
already have an issue with context and a "done when" checklist: browse the
[`help wanted`](https://github.com/FelixMiddelhoff/ratchet-verify/labels/help%20wanted)
and [`good first issue`](https://github.com/FelixMiddelhoff/ratchet-verify/labels/good%20first%20issue)
labels. Comment on (or open) an issue before starting anything big so we don't
duplicate effort; small fixes can go straight to a pull request.

### High impact

- **Registry-only egress for the install phase.** Tests already run offline in
  container mode; installs still have the whole network. An allowlisting proxy
  (issue #23 follow-up) would close that.
- **Yarn and pnpm lockfile support.** Parse `yarn.lock` (classic and berry) and
  `pnpm-lock.yaml` into the same `InstalledPackages` shape that
  `src/lockfile/parse.ts` produces from `package-lock.json`, so the rest of the
  pipeline works unchanged. Test-runner detection already knows all three
  managers. *Done when:* fixtures for each format diff correctly, direct vs
  transitive flag included.
- **Monorepo / workspaces.** Understand `workspaces`, run per-package test
  scripts, and attribute a bump to the workspace that declares it.

### Better detection

- **Smarter changelog matching.** Fewer false positives on common words
  (`option`, `parse`, `get`); understand renamed/moved exports; use the
  package's own type declarations to check that a flagged symbol is really the
  one you use. The matcher lives in `src/match/`; its tests use paired
  (changelog, usage) fixtures with known matches *and* known non-matches.
- **Usage scanner depth** (`src/usage/`): follow re-exports through your own
  modules, respect name shadowing, handle `import()` chains and CommonJS
  patterns like `module.exports = require("pkg")`.
- **More changelog sources.** GitLab and Bitbucket repositories, changelogs
  shipped inside the npm tarball, and conventional-commit histories when no
  notes exist (`src/changelog/`).
- **Flaky-test handling in the bisector.** The bisector assumes "once broken,
  stays broken". Detect non-monotonic results, re-run a probe to confirm, and
  say so in the report (`src/bisect/`).
- **Private registry support** that forwards registry credentials into the
  sandbox *safely* (scoped, read-only, never the real `.npmrc`).

### Easy ways in

- **Grow the corpus.** Add a historical dependency bump with a known outcome
  to `corpus/cases.mjs` — a bump that shipped fine, one that broke something
  (a reverted PR, a public issue), or a sabotaged/malicious release. Fixtures
  for unpublished packages use the local registry in `corpus/registry.mjs`.
  Run `npm run corpus` to check that ratchet's verdict matches.
- **Try it on your own project and report what happens.** A false "safe", a
  false "broken", a confusing message, a crash: each is a valuable issue. Include
  the ratchet output, the bump, and (if you can) the relevant changelog lines.
- **Test on more platforms.** CI runs on Ubuntu and development happens on
  Windows; macOS and Windows aren't in the CI matrix yet. Path handling,
  process-tree killing on timeout and shell quoting are the likely trouble
  spots (`src/sandbox/exec.ts`).
- **Documentation.** Tutorial improvements, a walkthrough for your CI system,
  translations, or a fix for anything that read confusingly. Rule of thumb:
  every command and output shown must have actually been run.
- **Other CI integrations.** GitLab CI, Azure DevOps, CircleCI, Jenkins: the
  CLI already emits JSON, SARIF and Markdown, so this is mostly wrapper and
  documentation work.

### Bigger ideas

- **Other ecosystems** (Python with pip/poetry first), as separate modules
  rather than bolted onto the npm core.
- **Auto-merge / auto-PR** flows that use the verdict as the gate (deliberately
  out of the first release).
- **Ecosystem-aware fixes**, e.g. suggesting the last known-good version when a
  bump is bisected as broken.

### How to contribute

```
git clone https://github.com/FelixMiddelhoff/ratchet-verify
cd ratchet-verify
npm ci
npm run lint && npm test         # fast suite: no network, no real installs
npm run build && npm run corpus  # real installs against npm and GitHub
```

1. Fork, branch, keep the change focused.
2. Add tests: a positive case, a "nothing to report" case, and the edge case
   you care about. New detection logic needs a *non-match* test too.
3. Keep the code readable: small functions, intention-revealing names,
   comments that say *why*.
4. Documentation describes the product as it is: update the relevant file in
   `docs/` in the same pull request, and only show output you actually ran.
5. Open the pull request and describe the change and how you verified it.

The one rule that is not negotiable: **a "safe" verdict must never be wrong.**
Changes that make ratchet report fewer risks in exchange for less noise will be
asked to show they don't turn a real break into an all-clear.

Questions, ideas and half-formed proposals are welcome as issues.

## Development

```
npm run lint      # type-check
npm test          # unit and integration tests (fast, offline)
npm run build     # compile to dist/
npm run corpus    # historical-bump corpus (network)
```

Source layout: `src/lockfile` (diff), `src/changelog` (release notes),
`src/usage` (static scan), `src/match` (breaking-change matcher),
`src/sandbox` and `src/testrun` (isolated install and test), `src/bisect`,
`src/report` (verdicts and renderers), `src/pipeline`, `src/cli`, `src/ci`.

## License

[MIT](LICENSE)
