# Private registries

If your project installs packages from a private registry (Artifactory,
Verdaccio, GitHub Packages, CodeArtifact, npm Enterprise), the install inside
ratchet's sandbox needs a credential. ratchet does **not** copy your `.npmrc`
token into the sandbox. That is exactly where a malicious install script would
look for it. Instead it runs a small **registry proxy** that holds the
credential, and the sandbox can only talk to the proxy.

This feature is **opt-in** and off by default. It needs container isolation
(docker or podman running Linux containers). It supports npm and yarn classic
in real runs; yarn berry and pnpm are wired the same way but have not been run
against a real registry yet (see [Limits](#limits)).

## How it works

```
 your machine / CI runner
 ┌─ ratchet ── reads .npmrc, holds the token ─────────────┐
 │        │ token sent once, on stdin (never env/args/files)│
 │        ▼                                                 │
 │  internal network (no route out, no external DNS)        │
 │  ┌────────────────────┐        ┌───────────────────────┐ │
 │  │ sandbox container  │ ─────► │ proxy sidecar         │ │──► your registry
 │  │ npm / yarn install │        │ adds the Authorization│ │    (+ hosts you allow)
 │  │ no token, no net   │        │ header, filters       │ │
 │  └────────────────────┘        └───────────────────────┘ │
 └──────────────────────────────────────────────────────────┘
```

1. ratchet reads the registries and credentials from your `.npmrc`.
2. It starts the proxy in its own container and hands it the credential on
   stdin. The credential is not in any environment variable, command line,
   mounted file or `inspect` output.
3. The sandbox runs on a run-scoped **internal-only** network. Its only
   reachable peer is the proxy. Before any candidate code runs, an isolation
   self-test proves from a sandbox-shaped container that the host, the
   network gateway and the internet are unreachable.
4. Inside the sandbox, the project's `.npmrc` / `.yarnrc` / `.yarnrc.yml` are
   rewritten: every registry, auth and proxy setting is removed and replaced
   by the proxy's address. Lockfile tarball URLs are pointed at the proxy in
   the sandbox copy only (integrity hashes are untouched, so a tampered
   tarball still fails). Your files and the lockfile you diff are never
   modified.

If any protection cannot be set up (no Linux engine, network or sidecar
failure, a teardown ratchet cannot verify), the run **fails with an error**.
It never forwards the credential into the sandbox and never runs unprotected.

## What the proxy allows

Everything else is refused and counted.

- Only `GET` and `HEAD` for package metadata and tarballs. No publishing, no
  token or user endpoints, no query strings.
- Only package names that appear in the old or new lockfile or in a manifest,
  plus dependencies declared by an allowed package (a bisected version can
  bring new ones; these are reported as "discovered"). This **allowlist is on
  by default**.
- The credential is attached only to requests for the configured registry
  origin and is dropped on any redirect that leaves it. Redirects to a CDN
  work only for hosts you list in `registryAllowHosts`.
- No requests to loopback, private, link-local or cloud-metadata addresses,
  unless you name that registry host in `registryPrivateHosts`.
- Size, time and concurrency limits. Tokens (and their base64, URL-encoded and
  hex forms) are redacted from every log, report and error.

## Turning it on

Create a read-only token scoped to the registries you need (ratchet cannot
verify that, so please do), then:

```sh
NPM_TOKEN=... ratchet-verify --base origin/main --isolation container --registry-auth
```

with `.npmrc` referring to the token by name, never by value:

```ini
registry=https://npm.corp.example/api/npm/repo/
//npm.corp.example/api/npm/repo/:_authToken=${NPM_TOKEN}
@acme:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
```

An unset `${VAR}` is an error naming the variable, never an empty token.
`_authToken` (bearer), `_auth` (basic) and `username` + `_password` (basic) are
supported. ratchet reads the project `.npmrc` and your user `.npmrc`
(`NPM_CONFIG_USERCONFIG` or `~/.npmrc`); the project file wins. Registry URLs
must be `https`.

Options in `.ratchetrc` (all apply only with `registryAuth`):

| Option | Default | Meaning |
|---|---|---|
| `registryAuth` | `false` | Turn the proxy on (same as `--registry-auth`). Needs container isolation. |
| `registryAllowlist` | `true` | Only lockfile package names pass. `false` (or `--no-registry-allowlist`) lets any valid package name through; the report then says "package allowlist OFF". |
| `registryAllowHosts` | `[]` | Extra `host` or `host:port` (port defaults to 443) the proxy may tunnel to or follow redirects to: a CDN or S3 host for tarballs, a binary download host. |
| `registryDns` | `["1.1.1.1", "9.9.9.9"]` | Resolver IPs the proxy uses for registry host names (it never uses the system resolver). Set your corporate DNS for internal registries. |
| `registryPrivateHosts` | `[]` | Registry host names that may resolve to private addresses (an internal Artifactory on `10.x`). Everything else is refused by the proxy's address guard. |
| `registryCaFile` | none | PEM file with the CA the proxy should trust for a registry with a corporate certificate. |

## In CI: always use `--base`

The project `.npmrc` and `.ratchetrc` come from the checkout under test, and
in a pull request an outsider controls them. A hostile pull request could
otherwise point `.npmrc` at its own server with `_authToken=${NPM_TOKEN}` and
have ratchet send your token there.

So **with `--base` (the GitHub Action's default), every `registry*` setting and
the project `.npmrc` are read from the base ref**, the reviewed and merged
state. Values in the working tree's `.ratchetrc` that differ are ignored with a
note (setting names only). Consequences:

- The settings must already exist on the base branch. If the base has no
  `.ratchetrc`, the feature is off, whatever the pull request enables.
- With `--base`, `registryCaFile` must be an absolute path (a relative file
  would come from the checkout under test).
- Command-line flags still win, since they come from whoever runs ratchet.
- Without `--base` (for example `--old`), ratchet reads the working tree and
  prints a warning. Use that only on your own machine.

In the GitHub Action, pass the token as an environment variable of the step
and keep `isolation: container`:

```yaml
- uses: FelixMiddelhoff/ratchet-verify/.github/actions/ratchet@main
  env:
    NPM_TOKEN: ${{ secrets.NPM_READ_TOKEN }}
  with:
    isolation: container
    registry-auth: "true"
```

The Action always passes `--base`, so the registry lines of `.npmrc` and any
`registry*` options in `.ratchetrc` must already be on the base branch.
Secrets are not available to workflows from forks; there the run simply
cannot authenticate. The `registry-auth` input needs ratchet-verify 0.6.0 or newer (older versions
reject the flag); the default `ratchet-version: latest` qualifies.

## What the report tells you

With the proxy on, every report says what it did (last lines of the text
output; a `registryProxy` object in JSON; a `<sub>` line in the Markdown
comment). Real output of a run:

```
registry proxy: via proxy, credentials never entered the sandbox: npm.corp.example/api/npm/repo (bearer credential held by the proxy); package allowlist on (214 names); extra hosts: cdn.corp.example:443; discovered dependencies: gamma; 96 requests allowed, 0 denied
```

If the proxy refused requests that no normal install makes (a tunnel to an
unlisted host, a package nobody declared, a write method), the run is never
plainly safe. The overall verdict becomes at least `risky` and the report says:

```
SUSPICIOUS install activity: the registry proxy refused requests no normal install makes (2x connect: host-not-allowed; 1x denied: package-not-allowlisted (evil-lib)). An install script may have tried to reach the network through it
```

This is the sign of an install script that found the proxy address in the
sandbox and tried to use it. npm's own `/-/` probes and ratchet's self-test are
not counted.

## Limits

Be honest about what this does and does not give you.

- A malicious install script can still **fetch any package that is on the
  allowlist** (or discovered), and the hosts in `registryAllowHosts` are a
  narrow way out. It cannot get the token, the host's files or the internet.
- **Direct network attempts are dropped silently** by the internal network.
  Only attempts that go through the proxy are visible in the report. A script
  that behaves during the test run and misbehaves later is invisible to any
  test-based check.
- The report and PR comment **name your private registry hosts**. On a public
  repository that is public information.
- The sandbox image must contain the package manager. The default `node`
  image has npm and yarn classic. yarn berry and pnpm are configured the same
  way but were **not run against a real registry**; pnpm and berry normally
  need a download (corepack) that the sandbox cannot do, so use an image that
  ships them.
- Only the root `.npmrc` / `.yarnrc` / `.yarnrc.yml` are rewritten, not files
  in workspace subdirectories. yarn's own credential settings
  (`npmAuthToken` in `.yarnrc.yml`) are not read as a credential source; use
  `.npmrc`.
- Install scripts of the packages themselves still run, inside the sandbox.
  A dependency whose install script is new in this version is flagged in its
  verdict (npm and pnpm lockfiles record this; yarn's do not).
- mTLS client certificates are not supported yet.
- ratchet's own review of this feature was done by its author, with an
  adversarial test for each attack row of the threat model
  (`test/registry-proxy/`, `test/proxy-topology/`); it has not had an
  independent security audit. Use read-only, single-registry tokens.
