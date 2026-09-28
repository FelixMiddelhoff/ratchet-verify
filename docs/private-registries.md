# Private registries

Reference page. For a step-by-step setup (token, `.npmrc`, first run, CI) start with
[tutorial-private-registries.md](tutorial-private-registries.md).

If your project installs packages from a private registry (Artifactory,
Verdaccio, GitHub Packages, CodeArtifact, npm Enterprise), the install inside
ratchet's sandbox needs a credential. ratchet does **not** copy your `.npmrc`
token into the sandbox. That is exactly where a malicious install script would
look for it. Instead it runs a small **registry proxy** that holds the
credential, and the sandbox can only talk to the proxy.

This feature is **opt-in** and off by default. It needs container isolation
(docker or podman running Linux containers). It is verified in real runs with npm,
yarn classic, yarn berry 4, pnpm 9 and pnpm 10, against a token-checking and a
client-certificate-checking registry fixture (see [Limits](#limits)).

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
- Only package names already in the BASE lockfile/manifest (the reviewed,
  merged state, not the checkout under test) plus the exact packages ratchet
  is bisecting. This **allowlist is on by default**, but it is not a boundary
  against whoever authored the pull request: they can already introduce any
  name as a "changed dependency", since that is the thing being verified. It
  only stops an unrelated name from being fetched with the token — for
  example one a hostile *version's* packument declares but nothing under test
  asked for. Set `registryDiscovery: true` to let such declared-but-untested
  names through too (reported as "discovered"); it is off by default, so they
  are denied instead.
- The credential is attached only to requests for the configured registry
  origin and is dropped on any redirect that leaves it. Redirects to a CDN
  work only for hosts you list in `registryAllowHosts`. Raw tunnels (`CONNECT`,
  for binary downloads such as esbuild or sharp) need a separate, deliberate
  entry in `registryConnectHosts` and are off by default.
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
supported. ratchet reads the project `.yarnrc.yml` (yarn berry: `npmRegistryServer`,
`npmAuthToken`, `npmAuthIdent`, `npmScopes`, `npmRegistries`; `${VAR}` works the same), the project `.npmrc` and your user `.npmrc`
(`NPM_CONFIG_USERCONFIG` or `~/.npmrc`); earlier in that list wins. Registry URLs
must be `https`.

## Network-only mode (`--network proxy`)

`#23`: when you don't need a private registry at all and just want the install
phase confined to the real npm registry (no arbitrary egress an install script
could use), pass `--network proxy` instead of `--registry-auth`:

```sh
ratchet-verify --base origin/main --isolation container --network proxy
```

This runs the same proxy machinery, but **never reads `.npmrc`/`.yarnrc.yml`
and never sources a credential**: the only registry configured is the public
npm registry (`registry.npmjs.org`), so there is nothing to redirect and
nothing for the proxy to authenticate with. It is pure network restriction,
not registry redirection. The test phase still runs with `--network none`,
same as the default `tests-offline` mode. Use `registryAllowHosts` /
`registryConnectHosts` if the install also needs a CDN or a binary download
host (esbuild, sharp) beyond the registry itself.

Combine it with `--registry-auth` (or set both `registryAuth: true` and
`"containerNetwork": "proxy"` in `.ratchetrc`) when you need a private
registry AND want the same restriction applied to it; in that case `.npmrc` /
`.yarnrc.yml` ARE read, same as plain `--registry-auth`.

### Mutual TLS (client certificates)

A registry that demands a client certificate works the same way as a token: the proxy holds it, the sandbox never does.
Set it the way npm does, in the project or user `.npmrc`:

```ini
//registry.corp.example/npm/:certfile=/etc/ssl/ci/client.pem
//registry.corp.example/npm/:keyfile=/etc/ssl/ci/client.key
```

- `certfile` / `keyfile` (paths) or `cert` / `key` (inline PEM, a literal `\n` for newlines); per registry (`//host/path/:certfile`) or global, in
  which case every configured registry gets it. Both halves are required.
- Paths must be absolute (or start with `~/`) and `${VAR}` works in them; a relative path would mean "somewhere in the project",
  so it is refused. Yarn berry's `httpsCertFilePath` / `httpsKeyFilePath` (global, per scope, per `npmRegistries` entry) are read too.
- The files are read on the machine running ratchet and passed to the proxy container on stdin, like a token: never as an
  argument, environment variable or mount. The sandbox sees neither the certificate nor the key, and the key is redacted from every
  log and report. The certificate is presented only to the registry's own origin, never after a redirect to another host.
- With `--base` the `.npmrc` / `.yarnrc.yml` lines (so the paths) come from the base ref, like every other registry setting. So do `isolation`, `containerRuntime`, `containerImage` and `containerNetwork`: a pull request cannot open the test phase's network or swap the sandbox image.
- The report lists "client certificate" next to the credential kind, never a path or content. Encrypted keys are refused with an error.
- Trust in the registry's own server certificate is separate: `registryCaFile` adds a CA for it.

Options in `.ratchetrc` (all apply only with `registryAuth`):

| Option | Default | Meaning |
|---|---|---|
| `registryAuth` | `false` | Turn the proxy on (same as `--registry-auth`). Needs container isolation. |
| `registryAllowlist` | `true` | Only base-lockfile/manifest and under-test package names pass. `false` (or `--no-registry-allowlist`) lets any valid package name through; the report then says "package allowlist OFF". |
| `registryDiscovery` | `false` | Also let a transitive dependency an allowed packument declares through (reported as "discovered"). Off by default: such a name is denied instead. |
| `registryAllowHosts` | `[]` | Extra `host` or `host:port` (port defaults to 443) the proxy itself may fetch a redirect target or tarball URL from (GET/HEAD): a CDN or S3 host for tarballs. The sandbox cannot tunnel to these. |
| `registryConnectHosts` | `[]` | `host[:port]` the sandbox may open a raw TLS tunnel to (`CONNECT`), for install scripts that download binaries. **A tunnel is open egress to everything on that host** (a shared CDN or object store lets a script upload your source tree to any tenant), so list only hosts that are yours or single-purpose. Capped at 1 GiB per tunnel by default. |
| `registryDns` | `["1.1.1.1", "9.9.9.9"]` | Resolver IPs the proxy uses for registry host names (it never uses the system resolver). Set your corporate DNS for internal registries. |
| `registryPrivateHosts` | `[]` | Registry host names that may resolve to private addresses (an internal Artifactory on `10.x`). Everything else is refused by the proxy's address guard. |
| `registryCaFile` | none | PEM file with the CA the proxy should trust for a registry with a corporate certificate. |

## In CI: always use `--base`

The project `.npmrc` and `.ratchetrc` come from the checkout under test, and
in a pull request an outsider controls them. A hostile pull request could
otherwise point `.npmrc` at its own server with `_authToken=${NPM_TOKEN}` and
have ratchet send your token there.

So **with `--base` (the GitHub Action's default), every `registry*` setting, the
isolation options (`isolation`, `containerRuntime`, `containerImage`,
`containerNetwork`) and the project `.npmrc` / `.yarnrc.yml` are read from the base ref**, the reviewed and merged
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
reject the flag); the default `ratchet-version: latest` qualifies. `registryConnectHosts`, client certificates,
yarn `.yarnrc.yml` credentials and the base-pinned isolation options need 0.7.0 or newer.

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
  allowlist** (or discovered, if `registryDiscovery` is on). It cannot get the
  token, the host's files or the internet. The token's own read permissions,
  not the allowlist, are the real limit on what a hostile PR or dependency can
  read: the allowlist is anchored on the base ref plus the exact packages
  under test, but the PR author already controls which packages are "under
  test" — that part is not a boundary against them. Use a read-only token
  scoped to what the project needs.
- Every host in `registryConnectHosts` is open egress (see the option above).
  `registryAllowHosts` alone is not: the sandbox cannot tunnel to those hosts.
- **Direct network attempts are dropped silently** by the internal network.
  Only attempts that go through the proxy are visible in the report. A script
  that behaves during the test run and misbehaves later is invisible to any
  test-based check.
- The report and PR comment **name your private registry hosts**. On a public
  repository that is public information.
- The sandbox image must contain the package manager. The default `node`
  image has npm and yarn classic (which runs a berry release pinned by
  `yarnPath`). pnpm is not in it: ratchet stops before running anything and
  says so; see "Images for pnpm and yarn" in [configuration](configuration.md#images-for-pnpm-and-yarn).
  Berry through the proxy is tested with a `yarnPath` release; berry via
  corepack needs a download the sandbox cannot do.
- Every existing `.npmrc` / `.yarnrc` / `.yarnrc.yml` in the project copy (workspace
  packages included, up to 8 levels deep, never `node_modules`) is rewritten
  to the proxy. Yarn classic's `.yarnrc` is rewritten but not read for
  credentials (classic reads `.npmrc`).
- Install scripts of the packages themselves still run, inside the sandbox.
  A dependency whose install script is new in this version is flagged in its
  verdict (npm and pnpm lockfiles record this; yarn's do not).
- Client certificates: encrypted (passphrase-protected) private keys are not supported; use an unencrypted key file readable by the user running ratchet. One certificate per registry (or one global pair).
- **Audit reporting is best-effort.** A script can flood the proxy so denied
  attempts are dropped from the audit; refusals still hold, and ratchet then
  reports "AUDIT INCOMPLETE" and does not call the run safe.
- Registries that carry a secret in the URL path are not shown by path (only the
  host) in logs and reports, but the path is still sent to the proxy in its
  config; treat such URLs like tokens.
- `${VAR}` in an `.npmrc`/`.yarnrc.yml` from the base ref expands any
  environment variable of the machine running ratchet into a credential sent to
  that registry. Review changes to those files like changes to a CI workflow.
- A killed ratchet (SIGKILL; Windows has no SIGTERM handler) closes its end of
  the pipe it holds open to the proxy sidecar for exactly this reason: the
  sidecar process notices within seconds and stops itself (dropping the
  credential from memory), well under the 4-hour backstop it used to rely on.
  The now-stopped container and its network are not removed by this — that
  still needs the next run's sweep, or a manual `podman`/`docker rm -f` and
  `network rm` by the run's `ratchet.run=<id>` label.
- The proxy (sidecar) container — the one holding the credential — runs a
  digest-pinned `node` image by default, not the mutable `node:24` tag used
  for the sandbox's own install/test container (`containerImage`): a
  compromised or silently-replaced upstream tag cannot swap what it runs.
- A sandbox script can request many large package documents at once and make
  the proxy run out of memory; that fails the run (closed, no leak).
- **Review status.** The design was reviewed once by an independent,
  read-only adversarial reviewer (a separate AI agent with proof-of-concept
  tests, not a professional audit). Its findings (a symlink write outside the
  sandbox, `registryAllowHosts` doubling as a tunnel list, `.ratchetrc` isolation
  keys not pinned to the base ref, registry paths in reports, audit flooding and
  several smaller ones) are fixed and covered by regression tests
  (`test/registry-proxy/review-fixes.test.ts`, `test/symlink-safety.test.ts`). It
  has not had a professional security audit. Use read-only, single-registry tokens.
