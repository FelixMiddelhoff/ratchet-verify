# ratchet

*Don't just bump the version — prove it still works.*

ratchet verifies a dependency bump before you merge it. Given the lockfile
before and after, it

1. installs the new lockfile in a sandbox and runs your real test suite,
2. reads the changelog for the versions in between and checks its breaking
   changes against the symbols your code actually imports and calls,
3. when the tests fail, bisects the version range to the exact release that
   broke them.

The result is one verdict per changed dependency — **safe**, **risky** or
**broken** — each with the evidence behind it (a changelog excerpt and the
`file:line` it hits, or the bisected version and the failing test output).
A "safe" that rests on incomplete information says so.

## Requirements

Node.js 24 or newer, npm, git. npm projects with a `package-lock.json`
(lockfile version 1, 2 or 3).

## Quick start

```
npm install -g ratchet-verify        # or run it with: npx ratchet-verify
cd /path/to/your/project             # a git repo with the bump applied
ratchet-verify . --base main         # the short alias `ratchet` works too
```

`--base main` compares the working tree's `package-lock.json` with the one
on `main`. See [docs/tutorial.md](docs/tutorial.md) for a walkthrough with
real output, [docs/verdicts.md](docs/verdicts.md) for what each verdict
means, and [docs/configuration.md](docs/configuration.md) for options.

## Command line

```
ratchet [project-dir] (--base <git-ref> | --old <lockfile>) [options]

  --base <ref>        compare against package-lock.json at this git ref
  --old <file>        compare against this lockfile instead of a git ref
  --old-package-json <file>  package.json that goes with --old
  --new <file>        lockfile with the proposed bump (default: project's)
  --json | --sarif | --markdown   output format (default: text)
  --report-dir <dir>  also write report.json, report.md and report.sarif
  --fail-on <level>   exit 1 on "broken" (default) or "risky"
```

Exit codes: `0` ok, `1` verdict at or above `--fail-on`, `2` usage or
runtime error.

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
      - uses: ./.github/actions/ratchet
        with: { fail-on: broken, sarif: "true" }
```

## Safety of the install step

Installing a candidate version runs its install scripts, and attacks such as
the April 2026 SAP CAP "mini Shai-Hulud" steal credentials at exactly that
moment. ratchet installs in a temporary directory with an *allowlisted*
environment (no `GITHUB_TOKEN`, `NPM_TOKEN`, cloud credentials) and a
redirected home directory, so the usual `~/.npmrc` and `~/.aws` lookups find
nothing. This is temp-directory isolation: an install script that reads
absolute host paths, or reaches the network, is **not** stopped. Run ratchet
in CI or a disposable environment, not on a machine that holds secrets you
can't afford to lose.

Limits worth knowing: private registries that need `.npmrc` credentials
can't authenticate inside the sandbox; only npm's `package-lock.json` is
diffed; ratchet proves "tests still pass and no cited breaking change hits
your code", not "this version isn't malicious".

## License

MIT
