import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test, type TestContext } from "node:test";
import { detectEngine, type ContainerSettings } from "../../src/sandbox/container.js";
import { allowedPackageNames, buildProxyConfig, createRealEngine, defaultBridge, ProxyTopologyError, withProxyTopology, type Engine } from "../../src/sandbox/proxy-topology/index.js";
import { Credential, secretForms } from "../../src/sandbox/registry-proxy/index.js";
import { withSandbox } from "../../src/sandbox/sandbox.js";
import { suspiciousDenials } from "../../src/pipeline/registry-proxy.js";
import { buildReport } from "../../src/report/index.js";
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

const CASES: Array<{ manager: string; args: string[]; lock: string }> = [
  { manager: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"], lock: "package-lock.json" },
  { manager: "yarn", args: ["install", "--ignore-scripts", "--non-interactive"], lock: "yarn.lock" },
];

describe("package manager through the proxy on a real engine", () => {
  for (const c of CASES) test(`${c.manager} install inside a sandbox container: token-protected registry, project .npmrc token stripped, credential invisible`, async (t) => {
    await guarded(t, async (s, e) => {
      const name = `ratchet-e2e-fixture-${Math.random().toString(16).slice(2, 10)}`;
      const work = mkdtempSync(join(tmpdir(), "ratchet-e2e-"));
      try {
        const run = await e.run(["run", "-d", "--name", name, "--network", defaultBridge(s.runtime), "--label", "ratchet.test=fixture", s.image, "node", "-e", FIXTURE_JS]);
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
            assert.ok(/sha(512|1)-|#[0-9a-f]{40}/.test(lock), "integrity recorded");
            for (const f of [CANARY, OTHER_TOKEN, "evil.example"]) assert.ok(!lock.includes(f), `lockfile must not contain ${f}`);
            const rc = readFileSync(join(sb.dir, ".npmrc"), "utf8");
            assert.ok(!rc.includes(OTHER_TOKEN) && !rc.includes("evil.example") && rc.includes("legacy-peer-deps=true"));
            lockText = lock;
          });
          if (c.manager === "yarn") {
            // A lockfile that records the UPSTREAM url (what a developer's machine wrote): the sandbox copy is pointed at the proxy.
            const upstreamLock = lockText.split(topo.proxyUrl).join(`https://${ip}:8443`);
            assert.ok(upstreamLock.includes(`https://${ip}:8443/left-pad`), upstreamLock);
            const mappings = [{ from: `https://${ip}:8443/`, to: `${topo.proxyUrl}/` }];
            await withSandbox({ projectDir: project, container: s, proxy: { ...proxy, lockUrlMappings: mappings }, lockfile: { name: "yarn.lock", content: upstreamLock } }, async (sb) => {
              const frozen = await sb.run("yarn", ["install", "--frozen-lockfile", "--ignore-scripts", "--non-interactive"], 240_000);
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
