import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test, type TestContext } from "node:test";
import { detectEngine, type ContainerSettings } from "../../src/sandbox/container.js";
import { allowedPackageNames, buildProxyConfig, createRealEngine, defaultBridge, ProxyTopologyError, withProxyTopology, type Engine } from "../../src/sandbox/proxy-topology/index.js";
import { ClientCertificate, Credential, secretForms } from "../../src/sandbox/registry-proxy/index.js";
import { withSandbox } from "../../src/sandbox/sandbox.js";
import { suspiciousDenials } from "../../src/pipeline/registry-proxy.js";
import { buildReport } from "../../src/report/index.js";
import { CLIENT_CA, CLIENT_CERT, CLIENT_KEY } from "../registry-proxy/mtls-fixtures.js";
import { FIXTURE_JS, TRAP_JS } from "./registry-fixture.js";

/**
 * A real package manager inside a real sandbox container installs through the proxy from a token-checking https "private
 * registry". Skips without an engine (Windows/macOS legs); on Linux CI a missing engine is a failure.
 */
const CANARY = "CANARY-e2e-tok-4c81d0aa93f7be52";
const OTHER_TOKEN = "npm_PROJECTRCTOKEN0123456789abcdef";
const IN_CI = process.env.CI === "true";

let settings: ContainerSettings | undefined;
let engine: Engine | undefined;

before(async () => {
  const preferred = process.env.RATCHET_TEST_ENGINE === "docker" || process.env.RATCHET_TEST_ENGINE === "podman" ? process.env.RATCHET_TEST_ENGINE : "auto";
  const d = await detectEngine(preferred, (o) => createRealEngine(o.command as "docker" | "podman").run(o.args, { timeoutMs: o.timeoutMs }));
  if (d.usable) {
    settings = { runtime: d.usable.runtime, rootless: d.usable.rootless, image: "node:24" };
    engine = createRealEngine(d.usable.runtime);
  }
});

async function guarded(t: TestContext, body: (s: ContainerSettings, e: Engine) => Promise<void>): Promise<void> {
  if (!settings || !engine) {
    if (IN_CI && process.platform === "linux") assert.fail("CI on Linux must have a container engine");
    return t.skip("no docker/podman engine available");
  }
  try {
    await body(settings, engine);
  } catch (e) {
    if (e instanceof ProxyTopologyError && e.code === "egress-unavailable" && !IN_CI) return t.skip(`engine cannot give the sidecar egress: ${e.message}`);
    throw e;
  }
}

interface ManagerCase {
  manager: string;
  label: string;
  args: string[];
  frozen?: string[];
  lock: string;
  /** Derived image with the manager (the stock node:24 ships npm and yarn 1 only). */
  image?: { tag: string; run: string };
  /** Extra project files (berry: the release its .yarnrc.yml pins by yarnPath). */
  prepare?: (project: string, work: string) => Promise<void>;
  /** The lockfile records the registry origin, so the second (frozen, upstream-URL) phase is required to see the proxy rewrite. */
  recordsUrl: boolean;
}

/** Berry is run by the image's yarn 1 through yarnPath: fetch that release on the host (the sandbox has no direct network). */
async function prepareBerry(project: string, work: string): Promise<void> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(npm, ["pack", "@yarnpkg/cli-dist@4.9.2", "--pack-destination", work], { encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(packed.status, 0, packed.stderr);
  const unpack = join(work, "berry-unpack");
  mkdirSync(unpack);
  const tar = spawnSync("tar", ["-xzf", "yarnpkg-cli-dist-4.9.2.tgz", "-C", "berry-unpack"], { cwd: work, encoding: "utf8" }); // relative paths: GNU tar reads "C:" as a host
  assert.equal(tar.status, 0, tar.stderr);
  mkdirSync(join(project, ".yarn", "releases"), { recursive: true });
  copyFileSync(join(unpack, "package", "bin", "yarn.js"), join(project, ".yarn", "releases", "yarn-4.9.2.cjs"));
  // A berry lockfile marker: the sandbox rewrites .yarnrc.yml (registry -> proxy) only for a yarn.lock it recognises as berry.
  writeFileSync(join(project, "yarn.lock"), ["__metadata:", "  version: 8", ""].join("\n"));
  writeFileSync(join(project, ".yarnrc.yml"), ["nodeLinker: node-modules", "enableTelemetry: false", "yarnPath: .yarn/releases/yarn-4.9.2.cjs", ""].join("\n"));
}

async function buildImage(runtime: string, tag: string, run: string, work: string): Promise<string> {
  const dir = mkdtempSync(join(work, "image-"));
  writeFileSync(join(dir, "Dockerfile"), ["FROM node:24", `RUN ${run}`, ""].join("\n"));
  const built = spawnSync(runtime, ["build", "-t", tag, dir], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  return tag;
}

const CASES: ManagerCase[] = [
  { manager: "npm", label: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"], lock: "package-lock.json", recordsUrl: false },
  { manager: "yarn", label: "yarn", args: ["install", "--ignore-scripts", "--non-interactive"], frozen: ["install", "--frozen-lockfile", "--ignore-scripts", "--non-interactive"], lock: "yarn.lock", recordsUrl: true },
  { manager: "pnpm", label: "pnpm 9", args: ["install", "--ignore-scripts"], frozen: ["install", "--frozen-lockfile", "--ignore-scripts"], lock: "pnpm-lock.yaml", image: { tag: "ratchet-test-pnpm9", run: "npm install -g pnpm@9" }, recordsUrl: false },
  { manager: "yarn", label: "yarn berry 4", args: ["install", "--mode=skip-build"], frozen: ["install", "--immutable", "--mode=skip-build"], lock: "yarn.lock", prepare: prepareBerry, recordsUrl: false },
];

describe("package manager through the proxy on a real engine", () => {
  for (const c of CASES) test(`${c.label} install inside a sandbox container: token-protected registry, project .npmrc token stripped, credential invisible`, async (t) => {
    await guarded(t, async (base, e) => {
      const name = `ratchet-e2e-fixture-${Math.random().toString(16).slice(2, 10)}`;
      const work = mkdtempSync(join(tmpdir(), "ratchet-e2e-"));
      try {
        const s = c.image ? { ...base, image: await buildImage(base.runtime, c.image.tag, c.image.run, work) } : base;
        const run = await e.run(["run", "-d", "--name", name, "--network", defaultBridge(s.runtime), "--label", "ratchet.test=fixture", base.image, "node", "-e", FIXTURE_JS]);
        assert.equal(run.exitCode, 0, run.output);
        let text = "";
        for (let i = 0; i < 100 && !text.includes("FIXTURE_READY"); i++) {
          text = (await e.run(["logs", name])).output;
          if (!text.includes("FIXTURE_READY")) await new Promise((r) => setTimeout(r, 200));
        }
        assert.ok(text.includes("FIXTURE_READY"), text);
        const ip = /FIXTURE_IP (\S+)/.exec(text)![1]!;
        const certFile = join(work, "ca.pem");
        writeFileSync(certFile, Buffer.from(/FIXTURE_CERT_B64 (\S+)/.exec(text)![1]!, "base64"));

        const project = join(work, "app");
        mkdirSync(project);
        writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } }));
        writeFileSync(join(project, ".npmrc"), `registry=https://evil.example/\n//evil.example/:_authToken=${OTHER_TOKEN}\nlegacy-peer-deps=true\n`);
        await c.prepare?.(project, work);

        const config = buildProxyConfig({
          registries: [{ id: "main", upstream: `https://${ip}:8443`, allowPrivateAddresses: true, credential: new Credential("bearer", CANARY) }],
          packages: { allow: allowedPackageNames([], ["left-pad"]) },
          dns: ["1.1.1.1"],
          limits: { requestTimeoutMs: 15_000 },
        });
        await withProxyTopology({ settings: s, config, engine: e, extraCaFile: certFile }, async (topo) => {
          let lockText = "";
          const proxy = { network: topo.networkName, proxyUrl: topo.proxyUrl, registries: [{ id: "main", isDefault: true }], lockUrlMappings: [] };
          await withSandbox({ projectDir: project, container: s, proxy }, async (sb) => {
            const install = await sb.run(c.manager, c.args, 240_000);
            assert.equal(install.exitCode, 0, install.output);
            assert.ok(existsSync(join(sb.dir, "node_modules", "left-pad", "index.js")), "the package was installed");
            const lock = readFileSync(join(sb.dir, c.lock), "utf8");
            assert.ok(/sha(512|1)-|#[0-9a-f]{40}|checksum: [0-9a-z]+\/[0-9a-f]{32,}/.test(lock), "integrity recorded");
            for (const f of [CANARY, OTHER_TOKEN, "evil.example"]) assert.ok(!lock.includes(f), `lockfile must not contain ${f}`);
            const rc = readFileSync(join(sb.dir, ".npmrc"), "utf8");
            assert.ok(!rc.includes(OTHER_TOKEN) && !rc.includes("evil.example") && rc.includes("legacy-peer-deps=true"));
            if (c.prepare) for (const f of [CANARY, OTHER_TOKEN, "evil.example"]) assert.ok(!readFileSync(join(sb.dir, ".yarnrc.yml"), "utf8").includes(f), `.yarnrc.yml must not contain ${f}`);
            lockText = lock;
          });
          if (c.frozen) {
            // A lockfile that records the UPSTREAM url (what a developer's machine wrote): the sandbox copy is pointed at the proxy.
            const upstreamLock = lockText.split(topo.proxyUrl).join(`https://${ip}:8443`);
            if (c.recordsUrl) assert.ok(upstreamLock.includes(`https://${ip}:8443/left-pad`), upstreamLock);
            const mappings = [{ from: `https://${ip}:8443/`, to: `${topo.proxyUrl}/` }];
            await withSandbox({ projectDir: project, container: s, proxy: { ...proxy, lockUrlMappings: mappings }, lockfile: { name: c.lock, content: upstreamLock } }, async (sb) => {
              const frozen = await sb.run(c.manager, c.frozen!, 240_000);
              assert.equal(frozen.exitCode, 0, frozen.output);
              assert.ok(existsSync(join(sb.dir, "node_modules", "left-pad", "index.js")));
            });
          }
          const fx = (await e.run(["logs", name])).output;
          const want = createHash("sha256").update(`Bearer ${CANARY}`).digest("hex");
          const reqs = fx.split("\n").filter((l) => l.startsWith("REQ"));
          assert.ok(reqs.some((l) => l.includes("/left-pad ") && l.endsWith(`auth=${want}`)), reqs.join("\n"));
          assert.ok(reqs.every((l) => l.endsWith(`auth=${want}`)), "every upstream request carried the injected token: " + reqs.join("\n"));
          const audit = topo.audit();
          assert.ok(audit.some((a) => a.class === "tarball" && a.decision === "allow"), JSON.stringify(audit));
          assert.deepEqual(suspiciousDenials(audit), [], `a normal ${c.manager} install must not look suspicious: ${JSON.stringify(audit.filter((x) => x.decision === "deny"))}`);
          for (const form of secretForms(CANARY)) assert.ok(!JSON.stringify([audit, topo.diagnostics()]).includes(form));
        });
      } finally {
        await e.run(base.runtime === "podman" ? ["rm", "-f", "-t", "0", name] : ["rm", "-f", name]);
        rmSync(work, { recursive: true, force: true });
      }
    });
  });

  test("mutual TLS: the registry demands a client certificate, the proxy presents it, the sandbox never holds the key", async (t) => {
    await guarded(t, async (s, e) => {
      const name = `ratchet-e2e-mtls-${Math.random().toString(16).slice(2, 10)}`;
      const work = mkdtempSync(join(tmpdir(), "ratchet-e2e-mtls-"));
      try {
        const run = await e.run(["run", "-d", "--name", name, "-e", `CLIENT_CA_B64=${Buffer.from(CLIENT_CA).toString("base64")}`, "--network", defaultBridge(s.runtime), "--label", "ratchet.test=fixture-e2e", s.image, "node", "-e", FIXTURE_JS]);
        assert.equal(run.exitCode, 0, run.output);
        let text = "";
        for (let i = 0; i < 100 && !text.includes("FIXTURE_READY"); i++) {
          text = (await e.run(["logs", name])).output;
          if (!text.includes("FIXTURE_READY")) await new Promise((r) => setTimeout(r, 200));
        }
        assert.ok(text.includes("FIXTURE_READY"), text);
        const ip = /FIXTURE_IP (\S+)/.exec(text)![1]!;
        const certFile = join(work, "ca.pem");
        writeFileSync(certFile, Buffer.from(/FIXTURE_CERT_B64 (\S+)/.exec(text)![1]!, "base64"));
        const project = join(work, "app");
        mkdirSync(project);
        writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } }));

        const config = buildProxyConfig({
          registries: [{ id: "main", upstream: `https://${ip}:8443`, allowPrivateAddresses: true, clientCertificate: new ClientCertificate(CLIENT_CERT, CLIENT_KEY) }],
          packages: { allow: allowedPackageNames([], ["left-pad"]) },
          dns: ["1.1.1.1"],
          limits: { requestTimeoutMs: 15_000 },
        });
        await withProxyTopology({ settings: s, config, engine: e, extraCaFile: certFile }, async (topo) => {
          const proxy = { network: topo.networkName, proxyUrl: topo.proxyUrl, registries: [{ id: "main", isDefault: true }], lockUrlMappings: [] };
          await withSandbox({ projectDir: project, container: s, proxy }, async (sb) => {
            const install = await sb.run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], 240_000);
            assert.equal(install.exitCode, 0, install.output);
            assert.ok(existsSync(join(sb.dir, "node_modules", "left-pad", "index.js")), "installed through the mTLS registry");
            // Nothing in the sandbox (files, npm logs, config) holds any part of the key.
            const keyLines = CLIENT_KEY.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----"));
            const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (f === "node_modules" ? [] : statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
            for (const file of walk(sb.dir)) {
              const body = readFileSync(file, "utf8");
              for (const line of keyLines) assert.ok(!body.includes(line), `the key must not be in the sandbox (${file.slice(sb.dir.length)})`);
              assert.ok(!body.includes("BEGIN CERTIFICATE"), `no certificate in the sandbox either (${file.slice(sb.dir.length)})`);
            }
            assert.ok(!install.output.includes(keyLines[0]!));
          });
          const fx = (await e.run(["logs", name])).output;
          const reqs = fx.split("\n").filter((l) => l.startsWith("REQ"));
          assert.ok(reqs.some((l) => l.includes("/left-pad ") && l.endsWith("cn=ratchet-test-client")), reqs.join("\n"));
          assert.ok(reqs.every((l) => l.endsWith("cn=ratchet-test-client")), "every request carried the client certificate: " + reqs.join("\n"));
          const audit = topo.audit();
          assert.deepEqual(suspiciousDenials(audit), [], JSON.stringify(audit.filter((x) => x.decision === "deny")));
          const keyBody = CLIENT_KEY.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----"))[0]!;
          assert.ok(!JSON.stringify([audit, topo.diagnostics()]).includes(keyBody));
        });
      } finally {
        await e.run(s.runtime === "podman" ? ["rm", "-f", "-t", "0", name] : ["rm", "-f", name]);
        rmSync(work, { recursive: true, force: true });
      }
    });
  });

  test("a malicious install script in a private package: no credential visible, no way out, install still completes", async (t) => {
    await guarded(t, async (s, e) => {
      const name = `ratchet-e2e-trap-${Math.random().toString(16).slice(2, 10)}`;
      const work = mkdtempSync(join(tmpdir(), "ratchet-e2e-trap-"));
      try {
        const run = await e.run(["run", "-d", "--name", name, "-e", `TRAP_B64=${Buffer.from(TRAP_JS).toString("base64")}`, "--network", defaultBridge(s.runtime), "--label", "ratchet.test=fixture", s.image, "node", "-e", FIXTURE_JS]);
        assert.equal(run.exitCode, 0, run.output);
        let text = "";
        for (let i = 0; i < 100 && !text.includes("FIXTURE_READY"); i++) {
          text = (await e.run(["logs", name])).output;
          if (!text.includes("FIXTURE_READY")) await new Promise((r) => setTimeout(r, 200));
        }
        assert.ok(text.includes("FIXTURE_READY"), text);
        const ip = /FIXTURE_IP (\S+)/.exec(text)![1]!;
        const certFile = join(work, "ca.pem");
        writeFileSync(certFile, Buffer.from(/FIXTURE_CERT_B64 (\S+)/.exec(text)![1]!, "base64"));
        const project = join(work, "app");
        mkdirSync(project);
        writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { trap: "1.0.0" } }));
        writeFileSync(join(project, ".npmrc"), `registry=https://evil.example/
//evil.example/:_authToken=${OTHER_TOKEN}
`);

        const config = buildProxyConfig({
          registries: [{ id: "main", upstream: `https://${ip}:8443`, allowPrivateAddresses: true, credential: new Credential("bearer", CANARY) }],
          packages: { allow: allowedPackageNames([], ["trap"]) },
          dns: ["1.1.1.1"],
          limits: { requestTimeoutMs: 15_000 },
        });
        await withProxyTopology({ settings: s, config, engine: e, extraCaFile: certFile }, async (topo) => {
          const proxy = { network: topo.networkName, proxyUrl: topo.proxyUrl, registries: [{ id: "main", isDefault: true }], lockUrlMappings: [] };
          await withSandbox({ projectDir: project, container: s, proxy }, async (sb) => {
            const install = await sb.run("npm", ["install", "--no-audit", "--no-fund"], 240_000);
            assert.equal(install.exitCode, 0, install.output);
            const reportPath = join(sb.dir, "..", "trap-report.json");
            assert.ok(existsSync(reportPath), "the install script ran inside the sandbox");
            const raw = readFileSync(reportPath, "utf8");
            const report = JSON.parse(raw) as { env: Record<string, string>; proc: string; files: string; directUpstream: string; directInternet: string; dnsExternal: string };
            for (const f of [...secretForms(CANARY), ...secretForms(OTHER_TOKEN)]) assert.ok(!raw.includes(f), `credential form leaked to the install script: ${f.slice(0, 12)}...`);
            assert.ok(report.proc.includes("npm") || report.proc.length > 0, "the script really read /proc");
            assert.ok(report.files.includes("app"), "the script really read the sandbox files");
            assert.ok(!/TOKEN|SECRET|PASSWORD|AUTH/i.test(Object.keys(report.env).join(" ")), "no credential-like environment variable: " + Object.keys(report.env).join(","));
            assert.notEqual(report.directUpstream, "connected", "the sandbox must not reach the registry directly");
            assert.notEqual(report.directInternet, "connected", "the sandbox must not reach the internet");
            assert.ok(!report.dnsExternal.startsWith("resolved"), `external DNS must fail, got ${report.dnsExternal}`);
          });
          const audit = topo.audit();
          assert.ok(audit.some((a) => a.class === "tarball" && a.decision === "allow"));
          // The script's attempts through the proxy are refused, counted, and turn a passing run into a risky one.
          await new Promise((r) => setTimeout(r, 300));
          const suspicious = suspiciousDenials(topo.audit());
          assert.ok(suspicious.some((x) => x.class === "connect" && x.reason === "host-not-allowed"), JSON.stringify(suspicious));
          assert.ok(suspicious.some((x) => x.reason === "package-not-allowlisted"), JSON.stringify(suspicious));
          const info = { registries: [], allowlist: "on" as const, allowHosts: [], allowedPackages: 1, discoveredPackages: [], requestsAllowed: 0, requestsDenied: suspicious.length, suspicious, auditTruncated: false };
          assert.equal(buildReport([], { level: "container" }, info).overall, "risky");
        });
      } finally {
        await e.run(s.runtime === "podman" ? ["rm", "-f", "-t", "0", name] : ["rm", "-f", name]);
        rmSync(work, { recursive: true, force: true });
      }
    });
  });
});
