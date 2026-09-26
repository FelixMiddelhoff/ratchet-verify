# Tutorial: verify bumps from a private registry

Goal: run ratchet on a project whose dependencies come from a private registry
(Artifactory, Nexus, Verdaccio, GitHub Packages, CodeArtifact, npm Enterprise,
...) **without** giving the sandbox that runs untrusted install scripts your
token. Reference material (every option, every limit) is in
[private-registries.md](private-registries.md); this page is the walk-through.

You will: create a token, tell ratchet where it is, run locally, check that the
protection works, then wire it into CI.

## How it works in one paragraph

Installing a candidate version runs its install scripts. Normally that means
those scripts can read your `.npmrc` token. With `--registry-auth` ratchet starts
a small **proxy container** that holds the token. The **sandbox** container is
attached to an internal network whose only reachable peer is the proxy, so it
gets no token, no internet and no direct route to the registry. The proxy
serves only package names from your lockfiles and refuses everything else.
If any of this cannot be set up, the run fails instead of running unprotected.

## Before you start

- docker or podman running **Linux** containers (GitHub-hosted Ubuntu runners
  are fine). Windows-containers mode is refused.
- Everything from [setup.md](setup.md) steps 0-3 works for a public project.
- The registry is reachable over **https**. (Plain http registries are refused.)

## Step 1: create a read-only token

Create a token that can only **read** the packages this project needs (in
Artifactory, a token for a group with read permission on the virtual repo; in
GitHub Packages, a fine-grained token with `read:packages` only). ratchet cannot
check this for you and it is the single most important safety control: what a
hostile pull request or dependency can read through the proxy is bounded by
what the token can read, not by ratchet's package allowlist.

## Step 2: reference the token by name in `.npmrc`

Never put the token value in a file. Refer to an environment variable:

```ini
registry=https://npm.corp.example/api/npm/repo/
//npm.corp.example/api/npm/repo/:_authToken=${NPM_TOKEN}
@acme:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
```

Supported credential forms: `_authToken` (bearer), `_auth` (basic) and
`username` + `_password` (basic). Yarn berry's `.yarnrc.yml` settings
(`npmRegistryServer`, `npmAuthToken`, `npmAuthIdent`, `npmScopes`,
`npmRegistries`) are read too. An unset `${VAR}` is an error naming the
variable, never an empty token. ratchet reads the project file and your user
`~/.npmrc` (the project file wins).

## Step 3: turn the feature on

Either on the command line:

```sh
NPM_TOKEN=... GH_PACKAGES_TOKEN=... \
  ratchet-verify . --base origin/main --isolation container --registry-auth
```

or in `.ratchetrc` (commit it to your main branch, see step 7):

```json
{
  "isolation": "container",
  "registryAuth": true
}
```

The first run pulls the image(s) and starts the proxy, which takes several
seconds. Without a container engine, `registryAuth` is an error: there is no
fallback to `temp-dir`.

## Step 4: read the report

With the proxy on, every report says what it did. The last lines of a text
report look like this (real output of the report code for two registries, one
using a bearer token and one a client certificate):

```
via proxy, credentials never entered the sandbox: npm.corp.example (bearer credential held by the proxy), mtls.example (client certificate held by the proxy); package allowlist on (212 names); 418 requests allowed, 0 denied
```

The JSON report has a `registryProxy` object with the same facts (see
[report-format.md](report-format.md)). Only registry **hosts** are shown, never a
token, a path or a file name. On a public repository the host names of your
private registries are public in the PR comment.

Things you may see:

| Line | Meaning |
|---|---|
| `SUSPICIOUS install activity` | Something in the sandbox asked the proxy for a thing no normal install asks for (a tunnel to an unlisted host, a package nobody declared, a write). The run is at least `risky`. |
| `AUDIT INCOMPLETE` | Audit entries were dropped (a script may have flooded the proxy). Refusals still held, but ratchet cannot prove nothing was attempted, so the run is not called `safe`. |
| `package allowlist OFF` | You turned the allowlist off (`--no-registry-allowlist`). Not recommended. |
| `TUNNEL hosts (open egress): ...` | You configured `registryConnectHosts` (step 6). |

## Step 5: check that the protection really works on your setup

Do this once, in a scratch branch. Add a test script that fails if it can see any
secret, and run ratchet on a bump:

```js
// check-no-secrets.js
const fs = require("node:fs");
const problems = [];
for (const name of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD|AUTH/i.test(name)) problems.push(`environment variable ${name}`);
}
for (const file of [".npmrc", `${process.env.HOME}/.npmrc`]) {
  try {
    if (/_authToken|_auth=|_password/i.test(fs.readFileSync(file, "utf8"))) problems.push(`${file} holds a credential`);
  } catch {}
}
if (problems.length > 0) { console.error("LEAK:", problems.join("; ")); process.exit(1); }
```

with `"test": "node check-no-secrets.js && your-real-tests"`. If ratchet reports
`broken` with a `LEAK:` line, the credential reached the sandbox and you should
not use the setup until that is understood (please open an issue). No `LEAK:` and
a passing verdict is the expected result. The project's own test suite
(`test/proxy-topology/e2e-real.test.ts`) runs a malicious install script against
this setup on real docker and podman.

## Step 6: registries that need more

| Situation | Setting |
|---|---|
| Tarballs redirect to a CDN or object store (S3, CloudFront) | `"registryAllowHosts": ["cdn.example.com"]`. The proxy itself follows redirects to these hosts. |
| An install script downloads a binary (esbuild, sharp, Playwright) | `"registryConnectHosts": ["binaries.example.com:443"]`. **A tunnel is open egress to everything on that host.** A shared CDN or object store lets a script send data to any tenant. List only hosts that are yours or single-purpose. Capped at 1 GiB per tunnel. |
| Internal registry on a private address (`10.x`, `192.168.x`) | `"registryPrivateHosts": ["npm.corp.example"]`. |
| Internal DNS names | `"registryDns": ["10.0.0.2"]`. The proxy never uses the system resolver. |
| Corporate CA for the registry's certificate | `"registryCaFile": "/etc/ssl/corp-ca.pem"` (an absolute path in CI). |
| Registry requires a **client certificate (mTLS)** | See below. |
| pnpm project | The image needs pnpm; see [setup.md](setup.md) step 3. |
| Yarn berry | Works when the repository pins its release with `yarnPath`. |

### Client certificates (mutual TLS)

```ini
//npm.corp.example/api/npm/repo/:certfile=/etc/ssl/ci/client.pem
//npm.corp.example/api/npm/repo/:keyfile=/etc/ssl/ci/client.key
```

- Paths must be absolute (or start with `~/`), `${VAR}` works in them, and
  both halves are required. Inline `cert` / `key` PEM (with a literal `\n` for
  newlines) works too. Yarn berry's `httpsCertFilePath` / `httpsKeyFilePath` are
  read.
- The key must **not** be passphrase-protected: encrypted keys are refused.
- A global `certfile` (without the `//host/path/:` prefix) is presented to every
  configured registry; prefer per-registry entries, ratchet notes it when a
  global one reaches several registries.
- The files are read on the machine running ratchet and handed to the proxy
  over stdin. The sandbox sees neither. The certificate is presented only to the
  registry's own origin, never after a redirect elsewhere.

## Step 7: CI

The registry settings **must be on the base branch**. With `--base` (the GitHub
Action always uses it) every `registry*` option, the project `.npmrc` and
`.yarnrc.yml`, and the isolation options (`isolation`, `containerRuntime`,
`containerImage`, `containerNetwork`) are read from the base ref, never from the
checkout under test. Reason: in a pull request an outsider controls those
files; otherwise a hostile PR could point `.npmrc` at its own server with
`_authToken=${NPM_TOKEN}` and have ratchet send your token there.

Consequence: **the pull request that adds `registryAuth` to `.ratchetrc` does not
get the proxy yet.** Merge the settings first, then the next pull requests use
them. If the base has no `.ratchetrc`, the feature is off whatever a PR says.

Workflow:

```yaml
name: ratchet
on:
  pull_request:
    paths: ["package.json", "package-lock.json"]

permissions:
  contents: read
  pull-requests: write

jobs:
  ratchet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: FelixMiddelhoff/ratchet-verify/.github/actions/ratchet@main
        env:
          NPM_TOKEN: ${{ secrets.NPM_READ_TOKEN }}
        with:
          isolation: container
          registry-auth: "true"
```

Secrets are not available to workflows from forks: there the run simply cannot
authenticate. Keep the token read-only and scoped (step 1) and prefer a token
used only for this workflow.

## Step 8: what to do when it does not work

| Message | Fix |
|---|---|
| `registryAuth needs container isolation (docker or podman)` | Add `--isolation container`, or install/start docker or podman (Linux containers). |
| `environment variable(s) referenced by .npmrc but not set: NPM_TOKEN` | Export it (locally) or add it to the step's `env` (CI). |
| `container image ... does not ship pnpm` | Use an image with pnpm; [setup.md](setup.md) step 3. |
| `... must be an absolute path (or start with ~/)` | A `certfile`/`keyfile` path was relative. |
| `... passphrase-protected keys are not supported` | Provide an unencrypted key file. |
| Install fails with 403/404 through the proxy | The package is not in the allowlist (lockfile/manifest names only) or the token cannot read it. Check `registryProxy` in the JSON report (`requestsDenied`, `discoveredPackages`). |
| `SUSPICIOUS install activity` | Read the class/reason/name counts. A binary download host may need `registryConnectHosts`; anything else deserves a look at the package. |
| Setup works locally, not in the PR check | The settings are only on your branch: merge them to the base branch. |

More messages: [troubleshooting.md](troubleshooting.md).

## What this does not protect against

Be honest with your team about the limits (full list in
[private-registries.md](private-registries.md#limits)):

- A malicious script can still **fetch any package the token can read** through
  the proxy, so use a read-only, scoped token.
- Every host in `registryConnectHosts` is open egress.
- Direct network attempts from the sandbox are dropped silently; only attempts
  through the proxy are visible.
- Anyone with root or docker access on the machine running ratchet can read the
  proxy's memory or your files. Run it on CI runners or disposable machines.
- The design had an independent AI security review (with proof-of-concept
  tests), not a professional audit.
