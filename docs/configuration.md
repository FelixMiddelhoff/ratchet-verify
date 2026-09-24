# Configuration

Options live in `.ratchetrc` (JSON) in the project directory. Unknown keys are
an error, so a typo can't silently weaken a check.

```json
{
  "ignore": ["some-dev-tool"],
  "maxInstalls": 10,
  "testTimeoutMs": 600000,
  "failOn": "broken",
  "isolation": "container",
  "containerRuntime": "auto",
  "containerImage": "node:24"
}
```

| Option | Default | Meaning |
|---|---|---|
| `ignore` | `[]` | Package names left out of the verdict entirely. |
| `maxInstalls` | `10` | Installs allowed per bisection. When it runs out, the result is a narrowed range instead of one version. |
| `testTimeoutMs` | `600000` | A test run (or install) longer than this is killed and counts as a failure. |
| `failOn` | `"broken"` | `"broken"` or `"risky"`: the overall verdict that makes the exit code 1. `--fail-on` overrides it. |
| `isolation` | `"temp-dir"` | `"temp-dir"`, `"container"` or `"auto"`. See below. `--isolation` overrides it. |
| `containerRuntime` | `"auto"` | `"auto"` (docker, then podman), `"docker"` or `"podman"`. |
| `containerNetwork` | `"tests-offline"` | Container mode only. `"tests-offline"`: the test phase runs with `--network none`. `"open"`: tests keep the network. `--network` overrides it. |
| `containerImage` | `"node:24"` | Image the installs and tests run in. It must contain Node and npm (yarn or pnpm if your project uses them); the full `node` image has the build tools native modules need. |

## Isolation

Installing a candidate version runs its install scripts, and tests run your code
against it. Two levels:

| Level | What it does | What it does not stop |
|---|---|---|
| `temp-dir` | A temporary copy of the project, an allowlisted environment (no `GITHUB_TOKEN`, `NPM_TOKEN`, cloud credentials) and a redirected home directory | A script reading absolute host paths (`~/.ssh`, `~/.aws`) or reaching any network host |
| `container` | Everything above, run in a docker or podman container whose only mount is the sandbox directory; all capabilities dropped, `no-new-privileges`, a process limit; the container's environment is built from scratch | The install phase keeps full network access: installs need the registry, and docker/podman have no per-host allowlist, so an install script can still send out anything it can read (only the sandbox). The test phase runs in a second container with `--network none` (default). |

`auto` uses a container when an engine is available and falls back to
`temp-dir` with a warning on stderr. `container` fails with an error when no
engine works. The report always states the level used (last line of the text
output, `isolation` in JSON, a footer in the Markdown comment).

Notes for container mode:
- Two runs per test: `npm ci` (network, so any registry from `.npmrc` works)
  in one container, then `npm test` in a fresh container on the same sandbox
  directory with `--network none`. Files installed persist between the two.
  Bisection and single-dependency probes (`--package-lock-only`) need the
  network and keep it. Install scripts are not run offline: many legitimately
  download binaries (esbuild, sharp), so `--ignore-scripts` plus an offline
  `npm rebuild` would break real projects; an allowlisting proxy is future work.
- A suite that needs the network (integration tests, a local service) fails
  offline; set `"containerNetwork": "open"`. Tests that fail only because of
  the missing network are reported as failures like any other.
- The image is pulled once, up front, if it is not present.
- A project-level `.npmrc` (for example a registry URL) is part of the copied
  project and is honoured. Credentials in your real `~/.npmrc` are still never
  visible. A registry on your machine's `localhost` is not reachable from
  inside a container.
- Rootful docker on Linux runs the container as your user id so the sandbox
  files can be deleted afterwards; rootless docker and podman need no mapping.
- On macOS and Windows the container runs in the engine's VM (Docker Desktop,
  Podman machine), and the sandbox directory in your temp folder must be
  shareable with it (it is by default).

Environment: `GITHUB_TOKEN`, if set, is used for GitHub API calls that fetch
release notes (raises the rate limit). It is never passed to the sandbox that
installs and tests candidate versions.

Outputs: `--json` is a stable machine-readable report (`schemaVersion: 1`),
`--sarif` is SARIF 2.1.0 (broken → error, risky → warning per call site,
partial safe → note), `--markdown` is the pull-request comment.
