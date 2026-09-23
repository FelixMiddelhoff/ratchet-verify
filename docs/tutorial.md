# Tutorial

This walks through ratchet on three small real projects, one per verdict
type. Every command and output below was run with real npm packages
(lodash, commander, chalk) on Node 24; long stack traces are shortened with
`…`, and the sandbox path in output differs on every run.

## 1. Install

```
git clone <this repository> ratchet && cd ratchet
npm ci
npm run build
```

Run it as `node <path-to-ratchet>/dist/cli/main.js`. Below that is written
`ratchet`.

## 2. How a run works

ratchet needs the lockfile *before* the bump and the one *after*. In a git
repository that is `--base <ref>` (the lockfile at that ref) against the
working tree:

```
ratchet . --base HEAD        # working tree has the bump, HEAD does not
ratchet . --base origin/main # in a pull request branch
```

Without git, pass `--old <lockfile>` (and `--old-package-json <file>` if
`package.json` changed too).

## 3. A safe (partial) bump: lodash 4.17.20 → 4.17.21

The project depends on `lodash` and its test calls `_.chunk`. After
`npm install lodash@4.17.21 --save-exact`:

```
$ ratchet . --base HEAD
SAFE (PARTIAL)  lodash 4.17.20 -> 4.17.21 (direct)
  tests pass; verdict is partial: no changelog was found; this is a tests-only verdict
  caveat: no changelog was found; this is a tests-only verdict
  note: No notes found for: 4.17.21

overall: safe (partial)
```

The tests passed in the sandbox, but lodash publishes no release notes or
`CHANGELOG.md` for this version, so ratchet could not check breaking changes
and says the verdict is tests-only. Exit code `0`.

## 4. A risky bump: commander 8.3.0 → 9.0.0

`cli.js` uses commander like this, and its test only checks that `-d` is
parsed, which still works after the upgrade:

```js
const { program } = require("commander");
program.option("-d, --debug", "enable debug output");
program.parse(["node", "cli", "-d"]);
module.exports = program.opts();
```

```
$ ratchet . --base HEAD
RISKY  commander 8.3.0 -> 9.0.0 (direct)
  tests pass, but the changelog names 2 symbol uses in your code as breaking
  - cli.js:3  program.option("-d, --debug", "enable debug output");
    changelog 9.0.0 (high): - *Breaking:* default value specified for boolean option now always used as default value (see .preset() to match some previous behaviours) (#1652)
  - cli.js:4  program.parse(["node", "cli", "-d"]);
    changelog 9.0.0 (high): - *Breaking:* removed internal fallback to `require.main.filename` when script not known from arguments passed to `.parse()`
  caveat: major version bump: breaking changes are allowed even if the changelog does not list them

overall: risky
```

The tests are green, yet the release notes list breaking changes that name
`option` and `parse`, and ratchet shows both the excerpt and the line in your
code that uses them. By default a `risky` verdict exits `0`; add
`--fail-on risky` (or set `failOn` in `.ratchetrc`) to make it exit `1`.

The match is by name, so it can flag a breaking note that doesn't affect how
you call the function — read the excerpt and decide. That trade is
deliberate: see [verdicts.md](verdicts.md).

## 5. A broken bump: chalk 4.1.2 → 5.3.0

chalk 5 is ESM-only; the project's test does `require("chalk")`.

```
$ ratchet . --base HEAD
RISKY  5 transitive dependencies (ansi-styles, color-convert, color-name, has-flag, supports-color)
  unverified: the suite fails because of chalk; this dependency was not tested on its own

BROKEN  chalk 4.1.2 -> 5.3.0 (direct)
  broken by 5.0.0 (4.1.2 still passed)
  - bisected in 2 installs: last good 4.1.2, first bad 5.0.0
    | > demo-broken@1.0.0 test
    | > node test.js
    |
    | …\test.js:2
    | if (typeof chalk.red("x") !== "string") throw new Error("chalk broke");
    |                  ^
    |
    | TypeError: chalk.red is not a function
    | …

overall: broken
```

What happened, in order:

1. ratchet installed the new lockfile in a sandbox and ran `npm test`: it failed.
2. It ran the suite against the *old* lockfile to make sure the failure comes
   from the bump and not from an already-red suite: it passed.
3. It reinstalled each changed direct dependency alone, found that `chalk`
   reproduces the failure, and bisected the versions between 4.1.2 and 5.3.0
   in two installs: 5.0.0 is the first version that breaks.
4. The process exits with code `1`.
5. The transitive packages that changed along with chalk (chalk 5 dropped
   them) are not blamed and not cleared; they are grouped as unverified.

### When the bisection runs out of budget

With `{"maxInstalls": 1}` in `.ratchetrc`, ratchet stops after one install and
reports the range it reached instead of guessing:

```
BROKEN  chalk 4.1.2 -> 5.3.0 (direct)
  broken somewhere in 4.1.2 < v <= 5.1.0 (bisection bound reached)
  - bisected in 1 install: last good 4.1.2, still failing at 5.1.0
```

## 6. Machine-readable output

```
ratchet . --base HEAD --json       # stable schema, schemaVersion: 1
ratchet . --base HEAD --sarif      # SARIF 2.1.0 for code scanning
ratchet . --base HEAD --markdown   # the pull request comment
ratchet . --base HEAD --report-dir out   # all three files from one run
```

For the commander project `--markdown` prints:

```
<!-- ratchet-verdict -->
## ratchet: ⚠️ risky

| | Dependency | Change | Verdict |
|---|---|---|---|
| ⚠️ | `commander` | `8.3.0` → `9.0.0` | risky |

<details><summary><b>commander</b>: tests pass, but the changelog names 2 symbol uses in your code as breaking</summary>

- `cli.js:3` `program.option("-d, --debug", "enable debug output");`
  - changelog 9.0.0 (high confidence): - *Breaking:* default value specified for boolean option now always used as default value (see .preset() to match some previous behaviours) (#1652)
- `cli.js:4` `program.parse(["node", "cli", "-d"]);`
  - changelog 9.0.0 (high confidence): - *Breaking:* removed internal fallback to `require.main.filename` when script not known from arguments passed to `.parse()`
- **caveat:** major version bump: breaking changes are allowed even if the changelog does not list them

</details>
```

## 7. In CI

Use the GitHub Action from the [README](../README.md#github-action): it runs
`--base` against the pull request's base commit, posts the Markdown above as
one comment that it updates on every push, optionally uploads the SARIF, and
fails the check when the overall verdict reaches `fail-on`. Check out with
`fetch-depth: 0` so the base commit's lockfile is readable.

## 8. Configuration

See [configuration.md](configuration.md) for `.ratchetrc`, and
[verdicts.md](verdicts.md) for exactly what each verdict and caveat means.
