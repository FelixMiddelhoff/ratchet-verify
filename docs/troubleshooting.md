# Troubleshooting

Every message below is copied from a real run. Exit code `2` always means
"ratchet could not run"; `0` and `1` are verdicts.

## Errors (exit code 2)

**`need --base <git-ref> or --old <lockfile> (see --help)`**
ratchet needs the "before" lockfile. Pass a git ref
(`ratchet-verify . --base main`) or a file
(`--old old-package-lock.json`).

**`git show nope:package-lock.json failed: fatal: invalid object name 'nope'.`**
The ref doesn't exist in this checkout. In CI, fetch it: `actions/checkout`
with `fetch-depth: 0`, or `git fetch origin main` and use `--base origin/main`.
The same message appears when the lockfile does not exist at that ref.

**`no lockfile at …/package-lock.json: run `npm install` (or `yarn install`) to create one`**
ratchet reads the project's `package-lock.json` or `yarn.lock`. Create it, or point at
another file with `--new <file>`.

**`found pnpm-lock.yaml, but pnpm lockfiles are not supported yet`**
npm and yarn (classic and berry) lockfiles work; pnpm isn't diffed yet
([help wanted](../README.md#help-wanted)). If you also keep a
`package-lock.json` generated from the same `package.json`, ratchet can use it.

**`.ratchetrc: unknown option(s): ignor`**
Unknown keys are rejected so a typo can't silently weaken a check. See
[configuration.md](configuration.md) for the option names.

**`isolation "container" needs docker or podman, but no working engine was found (is the daemon running?). Use --isolation temp-dir to accept weaker isolation.`**
Container isolation was requested but neither `docker info` nor `podman info`
succeeded. Start the engine (Docker Desktop, `systemctl start docker`,
`podman machine start`), or use `--isolation auto` to fall back with a warning.

**`isolation "container": docker is in Windows-containers mode, but ratchet needs Linux containers. …`**
Docker answered but runs Windows containers (Docker Desktop default on
Windows, and GitHub `windows-latest` runners), so the Linux `node` image and the
`/sandbox` mount cannot work. Switch Docker Desktop to Linux containers (tray
menu, or `DockerCli.exe -SwitchLinuxEngine`), use podman, or pass
`--isolation temp-dir`. With `--isolation auto` ratchet falls back to temp-dir
and prints this as a note.

**`could not pull container image node:24 with docker: …`**
The image is pulled up front. Check network access and registry login, or set
`containerImage` in `.ratchetrc` to an image you can pull (it needs Node and
npm).

**Tests pass normally but fail in container mode with `ENOTFOUND`, `EAI_AGAIN` or connection errors.**
The test phase runs with `--network none` (`containerNetwork: "tests-offline"`).
If the suite genuinely needs the network, set `"containerNetwork": "open"` in
`.ratchetrc` (or `--network open`, Action input `network: open`). The failure
then shows in the baseline too, so it is reported as `baseline-failing`, not
blamed on the bump. Install steps are unaffected.

**`Unknown option '--bogus'. …`**
Check `ratchet-verify --help`.

## Surprising verdicts

**`unverified: package.json has no scripts.test, so nothing ran against this bump`**
ratchet runs your own test script. Without one there is nothing to prove a
bump safe, so the verdict is risky, never safe. Add a `test` script.

**`unverified: the test suite already fails on the old lockfile …`**
The suite is red before the bump too, so a failure after it proves nothing
about the bump. Fix the suite on the base branch first.

**`unverified: the suite fails because of chalk; this dependency was not tested on its own`**
Several dependencies changed and `chalk` reproduces the failure alone. The
others changed together with it, are neither blamed nor cleared, and are
collapsed into one line in the text and Markdown output (the JSON keeps every
one).

**`broken … not isolated to a single version`**
The tests fail, but ratchet could not pin the failure on one release. Typical
causes: the npm registry could not be reached (no version list to bisect), or
no single direct bump reproduces the failure (an interaction between several
bumps). The failing output is still shown.

**`broken somewhere in 4.1.2 < v <= 5.1.0 (bisection bound reached)`**
`maxInstalls` (default 10) ran out. Raise it in `.ratchetrc` for the exact
version.

**`broken, but flaky suite: result not reliable`**
The re-run of the reported first bad or last good version gave the opposite
result, so the suite is not deterministic and no exact version is claimed.
Fix or quarantine the flaky test and run ratchet again. The re-runs use two
of the `maxInstalls` budget.

**`safe (partial)` and a caveat about the changelog**
Tests passed, but there was nothing to check breaking changes against: no
changelog was found, or some versions in the range have no notes. Many
packages publish no release notes, no repository `CHANGELOG.md` and none in
the npm tarball (ratchet tries GitHub, GitLab, Bitbucket, then the tarball). The
verdict is then exactly as strong as your tests.

**`safe (partial)` and "major version bump"**
Semver allows breaking changes in a major release even when the notes don't
list them. Your tests are the only evidence.

**A `risky` hit that doesn't affect you**
Matching is by identifier; a common word (`option`, `parse`) named only in prose is capped at medium. It can still match a
breaking note about something else. Read the excerpt: it is shown next to your
call site so you can judge in one glance. Packages you don't want judged at all
can go in `ignore`.

**`note: GitHub releases rate limited (HTTP 403).`**
Unauthenticated GitHub API calls are limited. Set `GITHUB_TOKEN` in the
environment (the GitHub Action does this for you); ratchet then falls back to
`CHANGELOG.md` files, and a token raises the limit.

**A test run is killed after ten minutes**
`testTimeoutMs` in `.ratchetrc` (default 600000). A hung suite counts as a
failure, which is intentional: a dependency that hangs on import is a real
break.

**`ratchet: no container engine found: falling back to temp-dir isolation …`**
Only a warning, printed with `--isolation auto` (or `"isolation": "auto"`). The
report's last line then says `isolation: temp-dir`.

## Things that look wrong but aren't

- **`risky` exits 0.** By default only `broken` fails the run. Use
  `--fail-on risky` or `"failOn": "risky"` to be stricter.
- **The install runs somewhere else.** The sandbox is a temporary copy of your
  project without `node_modules` and `.git`; your working tree is never
  touched, and the copy is deleted afterwards.
- **Your private registry doesn't work.** Credentials in `~/.npmrc` are
  deliberately unreachable from the sandbox. A project-level `.npmrc` with a
  registry URL is copied along, but auth tokens are not forwarded.
