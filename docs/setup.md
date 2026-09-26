# Setup guide: from zero to a protected repository

This is the checklist to go from "I have never run ratchet" to "every dependency
pull request in my repository is verified before it merges". Each step says why
it exists and how to check that it worked. The [tutorial](tutorial.md) shows what
the verdicts look like; this guide is about setting things up. Private
registries have their own hands-on guide:
[tutorial-private-registries.md](tutorial-private-registries.md).

## Step 0: what you need

| Need | Why |
|---|---|
| Node.js 24 or newer | ratchet itself runs on it. |
| git, with the branch you compare against (usually `main`) | ratchet reads the "before" lockfile from a git ref. |
| A lockfile: `package-lock.json`, `yarn.lock` (classic or berry) or `pnpm-lock.yaml` | ratchet compares two lockfile states. |
| The package manager on PATH (npm always; yarn or pnpm if your lockfile is theirs) | It runs the frozen install and your tests. Berry projects that commit `.yarn/releases` need nothing extra. |
| A `scripts.test` in `package.json` | Without tests a bump is reported `risky (unverified)`, on purpose. |
| docker or podman (recommended, optional) | Container isolation, see step 3. GitHub-hosted Ubuntu runners already have docker. |

## Step 1: run it once by hand

On a branch where a dependency bump is applied (or any branch that differs from
`main` in its lockfile):

```sh
npx ratchet-verify . --base main
```

Exit code `0` means ok, `1` means a verdict at or above `--fail-on` (default
`broken`), `2` means ratchet could not run. If you get `2`, the message names
the problem; [troubleshooting.md](troubleshooting.md) lists the common ones.

Check: the last lines say which isolation level was used and there is a verdict
per changed dependency. If nothing changed in the lockfile, the answer is
`safe` with an empty list, which is correct.

## Step 2: read the verdict once, on a bump you understand

Pick a bump you know (a minor update). Open [verdicts.md](verdicts.md) next to the
output and check that each line means what you expect: `safe`, `safe (partial)`
(tests passed, but there was no changelog to check breaking changes against),
`risky` (a breaking note matches your code, or nothing could be verified) or
`broken` (tests fail, hang or the install fails; the culprit version is
bisected). `safe (partial)` is not an all-clear: the tests are the only evidence.

## Step 3: choose the isolation level

Installing a candidate version runs its install scripts, which is exactly where
credential stealers strike. Two levels exist and every report states which one
ran:

| Level | Use it when | What it does not stop |
|---|---|---|
| `temp-dir` (default) | You only want a quick local check. | A script reading absolute host paths (`~/.ssh`) or reaching the network. |
| `container` | CI, and any machine with secrets on it. | The install phase keeps network access (see [private-registries.md](private-registries.md) to confine it). |

Recommendation: use `container` in CI. Locally, `--isolation auto` uses a
container when an engine is available and falls back to `temp-dir` with a
warning. `container` without a working engine is an error, never a silent
downgrade.

Check: run `npx ratchet-verify . --base main --isolation container`. The last
line of the report says `isolation: container (docker, node:24)` (or podman).

**pnpm projects:** the stock `node:24` image has no pnpm. ratchet stops before
running anything and tells you. Use an image that has it, for example one built
from

```dockerfile
FROM node:24
RUN npm install -g pnpm@9
```

and set `"containerImage": "my-node-pnpm"` in `.ratchetrc`
([configuration.md](configuration.md#images-for-pnpm-and-yarn)). Yarn classic is
in the stock image; yarn berry works when your repository pins its release with
`yarnPath` (the normal setup).

## Step 4: add a `.ratchetrc` (optional, but commit it to the base branch)

```json
{
  "isolation": "container",
  "failOn": "broken",
  "testTimeoutMs": 600000
}
```

Unknown keys are an error, so a typo cannot silently weaken a check. Options
that matter in CI (`isolation`, `containerImage`, `registry*`) are read from the
base branch when `--base` is used, so **they must be merged to `main` before
they take effect on pull requests**. That is deliberate: a pull request must not
be able to change how its own check runs. All options are in
[configuration.md](configuration.md).

## Step 5: add the GitHub Action

Create `.github/workflows/ratchet.yml`:

```yaml
name: ratchet
on:
  pull_request:
    paths:                        # only when dependencies change
      - "package.json"
      - "package-lock.json"       # or yarn.lock / pnpm-lock.yaml
      - "**/package.json"         # workspaces

permissions:
  contents: read
  pull-requests: write            # the verdict comment

jobs:
  ratchet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }  # the base commit's lockfile must be readable
      - uses: FelixMiddelhoff/ratchet-verify/.github/actions/ratchet@main
        with:
          isolation: container
          fail-on: broken
```

Check: open a pull request that changes the lockfile. One comment appears and
is updated on every push. To see it fail on purpose, bump a dependency to a
version you know breaks your tests.

Notes:

- On pull requests from forks the token is read-only, so the comment cannot be
  posted; the check result still works.
- Pin `ratchet-version` to an exact version if you want reproducible checks.
- Set `GITHUB_TOKEN` (the Action does this) or ratchet may hit the anonymous
  GitHub rate limit when fetching release notes.
- Other CI systems (GitLab, Azure DevOps, CircleCI, Jenkins) are in
  [ci.md](ci.md).

## Step 6: make it block merging

A check that nobody has to pass is a suggestion. In the repository settings
(branch protection or a ruleset for `main`), mark the `ratchet` check as
required. By default only `broken` fails the check. `"failOn": "risky"` (or
`fail-on: risky`) also blocks `risky`, which includes unverified bumps; start
with `broken` and tighten once the noise is low.

## Step 7: monorepos and workspaces

Workspaces are understood (`package.json` `workspaces`, `pnpm-workspace.yaml`):
a dependency counts as direct when any manifest names it and each verdict says
which workspaces declare and use it. The test run is the **root**
`scripts.test` only; per-workspace test scripts are not run, so make the root
script run them (`npm test --workspaces`, `pnpm -r test`, ...). Details are in the
README limitations section.

## Step 8: private registries

If your packages come from a private registry (Artifactory, Verdaccio, GitHub
Packages, CodeArtifact, npm Enterprise), the sandbox cannot use your `.npmrc`
credentials, on purpose. Follow
[tutorial-private-registries.md](tutorial-private-registries.md): it sets up a
proxy that holds the credential while the sandbox never sees it.

## Step 9: keep it healthy

- Dependabot and Renovate open ordinary pull requests, so the workflow runs on
  them unchanged.
- Read a `risky` hit's excerpt: it is shown next to your call site. Packages
  you never want judged can go in `ignore`.
- After a ratchet upgrade, re-run once by hand; [CHANGELOG.md](../CHANGELOG.md)
  lists behaviour changes.
- If a verdict surprises you: [troubleshooting.md](troubleshooting.md).

## Quick decision table

| Situation | Do this |
|---|---|
| Public packages only, GitHub | Steps 1, 3 (container), 5, 6. |
| pnpm project | Add the pnpm image in step 3. |
| Private registry | Steps above plus [tutorial-private-registries.md](tutorial-private-registries.md). |
| Not on GitHub | Steps 1-4 locally, then the recipe for your CI in [ci.md](ci.md). |
| Machine holds secrets and you run it locally | `--isolation container`, never `temp-dir`. |
