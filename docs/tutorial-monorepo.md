# Tutorial: monorepos and workspaces

This walks through ratchet on an npm-workspaces project, then shorter pnpm
and yarn classic passes, then container isolation. Every command and output
below was run for real — npm 11, pnpm 9.15.9, yarn classic 1.22.22 and
podman 6.1.2, all on Node 24 — the sandbox path in output differs on every
run. Read [tutorial.md](tutorial.md) first if you haven't — this page only
covers what changes for a monorepo.

## The one limitation to know up front

**Only the root `scripts.test` runs.** ratchet understands npm/yarn
`workspaces` and pnpm's `pnpm-workspace.yaml` — it attributes dependencies to
the workspaces that declare and use them, and it scans usage across every
workspace package — but the test run itself is always the repository root's
`scripts.test`. Per-workspace test scripts are not run. If your root has no
`scripts.test` (common when each workspace owns its own tests and the root
just delegates), point the root script at something that actually runs the
workspaces' tests (e.g. `"test": "npm test --workspaces --if-present"` for
npm, or an equivalent for yarn/pnpm) — otherwise ratchet reports every bump
as "risky (unverified)" even when the workspace tests would have passed.
This is a deliberate, documented gap (see the README limitations section and
`docs/README.md`'s AGENTS notes), not a bug; running each declaring
workspace's own script is open work.

## npm workspaces

### Set up the fixture

A root with two workspace packages: `@mono-demo/core` (depends on
`commander`) and `@mono-demo/cli` (depends on `@mono-demo/core`).

`package.json` (root):

```json
{
  "name": "mono-demo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "npm test --workspaces --if-present"
  }
}
```

`packages/core/package.json`:

```json
{
  "name": "@mono-demo/core",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": { "commander": "8.3.0" },
  "scripts": { "test": "node test.js" }
}
```

`packages/core/index.js`:

```js
const { program } = require("commander");

function parseDebug(argv) {
  program.option("-d, --debug", "enable debug output");
  program.parse(argv);
  return program.opts();
}

module.exports = { parseDebug };
```

`packages/core/test.js`:

```js
const { parseDebug } = require("./index");
if (parseDebug(["node", "cli", "-d"]).debug !== true) throw new Error("debug flag not parsed");
console.log("core ok");
```

`packages/cli/package.json`:

```json
{
  "name": "@mono-demo/cli",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": { "@mono-demo/core": "*" },
  "scripts": { "test": "node test.js" }
}
```

`packages/cli/index.js`:

```js
const { parseDebug } = require("@mono-demo/core");
module.exports = { parseDebug };
```

`packages/cli/test.js`:

```js
const { parseDebug } = require("./index");
if (typeof parseDebug !== "function") throw new Error("parseDebug missing");
console.log("cli ok");
```

Add a `.gitignore` with `node_modules`, run `npm install`, commit the
"before" state, then bump `commander` in the one workspace that uses it:

```
$ npm run test --silent
cli ok
core ok
$ git init -b main && git add . && git commit -m "before the bump"
$ npm install commander@9.0.0 --save-exact -w packages/core
```

### Run ratchet

```
$ ratchet . --base HEAD
```

Real output:

```
ratchet: workspace project (2 packages); tests run via the root scripts.test only
RISKY  commander 8.3.0 -> 9.0.0 (direct)
  tests pass, but the changelog names 2 symbol uses in your code as breaking
  workspaces: declared in @mono-demo/core; used in @mono-demo/core
  - packages/core/index.js:5  program.parse(argv);
    changelog 9.0.0 (high): - *Breaking:* removed internal fallback to `require.main.filename` when script not known from arguments passed to `.parse()`
  - packages/core/index.js:4  program.option("-d, --debug", "enable debug output");
    changelog 9.0.0 (medium): - *Breaking:* default value specified for boolean option now always used as default value (see .preset() to match some previous behaviours) (#1652)
  caveat: major version bump: breaking changes are allowed even if the changelog does not list them

overall: risky
isolation: temp-dir: credentials are withheld, but install scripts can still read host files (use --isolation container)
```

Two things differ from the single-project tutorial:

- The leading `ratchet: workspace project (N packages); ...` note. It always
  appears for a discovered workspace root, as a reminder of the root-only
  test-script limitation above.
- The `workspaces: declared in ...; used in ...` line. `commander` is
  declared only in `@mono-demo/core`'s `package.json` — that's `declaredIn`
  in the JSON report (`ratchet . --base HEAD --json`, field
  `dependencies[].workspaces.declaredIn`) — and the usage scan, which covers
  every workspace package, found the call sites only in that same package's
  source (`used in`). Had `@mono-demo/cli` also listed `commander` directly,
  or imported it, both would be named. A dependency is treated as **direct**
  the moment *any* manifest in the tree — root or workspace — names it
  directly; it doesn't matter which one.

Because only one workspace (`@mono-demo/core`) declares `commander`, ratchet
could have probed it alone with `npm -w packages/core install commander@ver`
during bisection, had the tests failed. (They didn't here — this is a
`risky`, not a `broken`, verdict.) When more than one manifest declares the
same dependency, or a yarn workspace has no `name` field, that single-package
probe isn't possible and bisection falls back to whole-project installs.

### Baselines with `--old` instead of `--base`

Without git, pass `--old <lockfile>` as usual, plus one
`--old-workspace-package-json <dir>=<file>` per workspace whose
`package.json` changed, so the sandbox installs the *old* dependency
versions instead of the current (already-bumped) ones:

```
ratchet . --old old-package-lock.json \
  --old-workspace-package-json packages/core=old-core-package.json
```

`<dir>` must be one of the discovered workspace directories; the file
becomes that workspace's `package.json` in the sandbox. Skip this and the
baseline install uses the *current* workspace manifests, which can fail as
"baseline-failing" if they already contain the bump. `--base <ref>` doesn't
need this flag — the old workspace manifests are read straight from git.

## pnpm workspaces

Same idea, `pnpm-workspace.yaml` instead of the `workspaces` field, and
`workspace:*` protocol references between packages. Verified for real with
pnpm 9.15.9 (installed with `npm i pnpm@9 --prefix <tmp>` and prepending its
`.bin` to `PATH`, matching how the project's own corpus runs pnpm/yarn on a
box without them globally installed).

`package.json` (root):

```json
{
  "name": "mono-pnpm-demo",
  "private": true,
  "scripts": {
    "test": "node -e \"console.log('root: no per-workspace scripts run')\""
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

`packages/core/package.json` (`commander` dependency, same `index.js` as
above) and `packages/cli/package.json` depending on
`"@mono-pnpm/core": "workspace:*"`. `pnpm install`, commit, then:

```
$ pnpm add commander@9.0.0 --save-exact --filter @mono-pnpm/core
```

### Run ratchet

```
$ ratchet . --base HEAD
```

Real output:

```
ratchet: workspace project (2 packages); tests run via the root scripts.test only
RISKY  commander 8.3.0 -> 9.0.0 (direct)
  tests pass, but the changelog names 2 symbol uses in your code as breaking
  workspaces: declared in @mono-pnpm/core; used in @mono-pnpm/core
  - packages/core/index.js:5  program.parse(argv);
    changelog 9.0.0 (high): - *Breaking:* removed internal fallback to `require.main.filename` when script not known from arguments passed to `.parse()`
  - packages/core/index.js:4  program.option("-d, --debug", "enable debug output");
    changelog 9.0.0 (medium): - *Breaking:* default value specified for boolean option now always used as default value (see .preset() to match some previous behaviours) (#1652)
  caveat: major version bump: breaking changes are allowed even if the changelog does not list them

overall: risky
isolation: temp-dir: credentials are withheld, but install scripts can still read host files (use --isolation container)
```

Note the root `scripts.test` here is a stub that doesn't call into either
workspace's code — deliberately, to make the "root-only" limitation
concrete: this report's "tests pass" only proves that stub ran and exited 0,
not that `@mono-demo/core`'s own tests ran. Give the root a real
`scripts.test` that runs your workspaces (`pnpm -r test`, or the
`--workspaces --if-present` form for npm) if you want the verdict to mean
something beyond "the repo didn't crash".

## Yarn classic workspaces

Same shape again: `packages/core` (declares `commander`) and `packages/cli`
(declares a plain-version dependency on `packages/core`, since yarn classic
doesn't have pnpm's `workspace:*` protocol). Verified for real with yarn
classic 1.22.22, installed the same way as pnpm above
(`npm i yarn@1 --prefix <tmp>`, `.bin` prepended to `PATH` — this project's
own corpus runner uses the same trick for a box without yarn/pnpm globally
installed).

`package.json` (root) — same `workspaces` field as the npm case, root test
script left as a stub for the same reason as the pnpm section:

```json
{
  "name": "mono-yarn-demo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "node -e \"console.log('root: no per-workspace scripts run')\""
  }
}
```

`packages/cli/package.json` depends on `"@mono-yarn/core": "1.0.0"` (a pinned
version — yarn classic workspaces link same-repo packages by matching
version ranges against what's on disk, not by a special protocol).
`yarn install`, commit, then bump with the per-workspace form:

```
$ yarn workspace @mono-yarn/core add commander@9.0.0 --exact
```

### Run ratchet

```
$ ratchet . --base HEAD
```

Real output:

```
ratchet: workspace project (2 packages); tests run via the root scripts.test only
RISKY  commander 8.3.0 -> 9.0.0 (direct)
  tests pass, but the changelog names 2 symbol uses in your code as breaking
  workspaces: declared in @mono-yarn/core; used in @mono-yarn/core
  - packages/core/index.js:5  program.parse(argv);
    changelog 9.0.0 (high): - *Breaking:* removed internal fallback to `require.main.filename` when script not known from arguments passed to `.parse()`
  - packages/core/index.js:4  program.option("-d, --debug", "enable debug output");
    changelog 9.0.0 (medium): - *Breaking:* default value specified for boolean option now always used as default value (see .preset() to match some previous behaviours) (#1652)
  caveat: major version bump: breaking changes are allowed even if the changelog does not list them

overall: risky
isolation: temp-dir: credentials are withheld, but install scripts can still read host files (use --isolation container)
```

Same `declaredIn`/`used in` attribution as npm and pnpm. Bisection would use
`yarn workspace @mono-yarn/core add commander@ver --ignore-scripts` here,
since `@mono-yarn/core` is the sole declaring workspace.

**Yarn berry was not covered here.** Setting up a real berry-workspaces
fixture (`.yarnrc.yml`, `nodeLinker`, a committed `.yarn/releases`) on top of
the three package managers above was more setup than this pass justified;
berry workspace support is exercised by the project's own test suite
(`test/workspaces.test.ts`) and by the corpus, just not re-demonstrated with
fresh real output in this tutorial. Treat berry specifically as
documented-but-not-re-verified-here if you rely on it.

## Stronger isolation: `--isolation container`

Everything above used the default `temp-dir` isolation. Workspaces work the
same way under `--isolation container` — verified for real on podman 6.1.2
against the npm-workspaces fixture from the first section:

```
$ ratchet . --base HEAD --isolation container
```

Real output:

```
ratchet: workspace project (2 packages); tests run via the root scripts.test only
RISKY  commander 8.3.0 -> 9.0.0 (direct)
  tests pass, but the changelog names 2 symbol uses in your code as breaking
  workspaces: declared in @mono-demo/core; used in @mono-demo/core
  - packages/core/index.js:5  program.parse(argv);
    changelog 9.0.0 (high): - *Breaking:* removed internal fallback to `require.main.filename` when script not known from arguments passed to `.parse()`
  - packages/core/index.js:4  program.option("-d, --debug", "enable debug output");
    changelog 9.0.0 (medium): - *Breaking:* default value specified for boolean option now always used as default value (see .preset() to match some previous behaviours) (#1652)
  caveat: major version bump: breaking changes are allowed even if the changelog does not list them

overall: risky
isolation: container (podman, node:24): installs and tests could only see the sandbox directory
```

Only the final `isolation:` line changes — everything about workspace
discovery, attribution and the root-only test-script limitation is
identical under container isolation. For a pnpm or yarn workspace project,
remember the default `node:24` image doesn't ship pnpm (and only ships yarn
classic, not berry): point `containerImage` at an image that has what you
need, per
[configuration.md#images-for-pnpm-and-yarn](configuration.md#images-for-pnpm-and-yarn).
That combination (pnpm/berry workspaces *and* container isolation, together)
wasn't re-run for this tutorial; the npm-workspaces case above is what was
verified.

## Where next

- [tutorial.md](tutorial.md): the two-minute demo and the three verdict types
- [configuration.md](configuration.md): every `.ratchetrc` option, including
  workspace-related ones
- [verdicts.md](verdicts.md): exactly what each verdict and caveat means
- the README "Limitations" section: the authoritative, terse statement of
  what workspace support does and doesn't do
