# Using ratchet in CI

## GitHub Actions

```yaml
name: ratchet
on:
  pull_request:
    paths: ["package.json", "package-lock.json"]   # only when dependencies change

permissions:
  contents: read
  pull-requests: write      # the verdict comment
  security-events: write    # only if sarif: "true"

jobs:
  ratchet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }      # the base commit's lockfile must be readable
      - uses: FelixMiddelhoff/ratchet-verify/.github/actions/ratchet@main
        with:
          fail-on: broken
```

The action compares the pull request's lockfile with its base commit, runs
your `scripts.test` in a sandbox, posts **one** comment and updates it on every
push, and fails the check according to `fail-on`.

| Input | Default | Meaning |
|---|---|---|
| `base` | the pull request's base commit | Git ref whose `package-lock.json` is the "before" state |
| `project-dir` | `.` | Directory with `package.json` and `package-lock.json` |
| `fail-on` | `broken` | `broken` or `risky` |
| `comment` | `true` | Post and update the verdict comment |
| `sarif` | `false` | Upload results to code scanning (needs `security-events: write`) |
| `isolation` | `temp-dir` | `temp-dir`, `container` or `auto`. GitHub-hosted Ubuntu runners have docker, so `container` works out of the box (the image is pulled on the first run) |
| `ratchet-version` | `latest` | Version or tag of `ratchet-verify` to run |
| `node-version` | `24` | Node.js used to run ratchet and your tests |

Outputs: `verdict` (`safe`, `risky` or `broken`) and `report-dir` (holding
`report.json`, `report.md`, `report.sarif`).

Notes:
- The comment is only posted on `pull_request` events. On pull requests from
  forks the token is read-only, so the comment step can't post; the check
  result still works.
- `GITHUB_TOKEN` reaches ratchet only for changelog lookups. It is never
  passed to the sandbox that installs and tests the candidate versions.
- Pin `ratchet-version` to an exact version (for example `0.1.1`) if you want
  reproducible checks.

### Dependabot and Renovate

Both open ordinary pull requests that change `package.json` and
`package-lock.json`, so the workflow above runs on them unchanged. To make a
red verdict block merging, mark the `ratchet` check as required in the
repository's branch protection rules. Dependabot pull requests get a read-only
`GITHUB_TOKEN` by default, so the comment step may not be able to post there;
use the check result and the `report-dir` output (or `--sarif` with code
scanning) to see the details.

## Any other CI system

The CLI is self-contained, so anything that can run Node 24 works:

```
git fetch origin main
npx ratchet-verify . --base origin/main --markdown --report-dir ratchet-report
```

- The exit code is the gate: `0` ok, `1` at or above `--fail-on`, `2` could not
  run.
- `ratchet-report/report.md` is ready to paste into a comment; `report.json`
  and `report.sarif` are for tooling. See [report-format.md](report-format.md).
- Make the base ref available (`git fetch`, or a full clone) and run on the
  *branch with the bump*, so the working tree's lockfile is the "after" state.

## Choosing `fail-on`

| Setting | Effect | Good for |
|---|---|---|
| `broken` (default) | Only failing tests / installs fail the check | Getting started; noisy codebases |
| `risky` | Also fails on breaking changes that hit your code, and on bumps nothing could verify (no test script, a suite that was already red) | Projects with a solid test suite and a habit of reading the excerpt |

A `safe (partial)` verdict never fails the check: read its caveats.

## Running it on a schedule

Dependencies also drift without a pull request. To check a lockfile that
changed on `main`, run the same command with `--base` pointing at the previous
commit (`--base HEAD~1`).

## Security notes for CI

Installing a candidate version executes its install scripts. By default ratchet
strips credentials from that environment and redirects the home directory
(`temp-dir` isolation), which does not stop a script from reading host files.
In CI, prefer `isolation: container` (docker or podman, present on GitHub-hosted
Ubuntu runners): the install and the tests then see only the sandbox directory.
Either way, run on ephemeral runners rather than machines holding long-lived
secrets. Details in the [README](../README.md#safety-of-the-install-step) and
[configuration.md](configuration.md#isolation).
