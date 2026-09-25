import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test, type TestContext } from "node:test";
import { runCli } from "../../src/cli/main.js";
import { detectEngine, type ContainerSettings } from "../../src/sandbox/container.js";
import { allowedPackageNames, buildProxyConfig, createRealEngine, defaultBridge, ProxyTopologyError, withProxyTopology, type Engine } from "../../src/sandbox/proxy-topology/index.js";
import { Credential, secretForms } from "../../src/sandbox/registry-proxy/index.js";
import { withSandbox } from "../../src/sandbox/sandbox.js";
import { FIXTURE_JS } from "./registry-fixture.js";

/**
 * The whole product path on a real engine: `ratchet --registry-auth --isolation container` against a token-checking https
 * "private registry". The bump breaks the project's tests; ratchet must find it through the proxy (install, pin, bisect) and
 * report it, while the token stays out of every output. Skips without an engine; on Linux CI a missing engine is a failure.
 */
const TOKEN = "CANARY-cli-tok-77d2c10be95a4f36";
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

describe("ratchet --registry-auth on a real engine", () => {
  test("a breaking bump is found through the proxy; the token appears in no output", async (t) => {
    await guarded(t, async (s, e) => {
      const name = `ratchet-cli-fixture-${Math.random().toString(16).slice(2, 10)}`;
      const work = mkdtempSync(join(tmpdir(), "ratchet-cli-e2e-"));
      try {
        const started = await e.run(["run", "-d", "--name", name, "--network", defaultBridge(s.runtime), "--label", "ratchet.test=fixture", s.image, "node", "-e", FIXTURE_JS]);
        assert.equal(started.exitCode, 0, started.output);
        let text = "";
        for (let i = 0; i < 100 && !text.includes("FIXTURE_READY"); i++) {
          text = (await e.run(["logs", name])).output;
          if (!text.includes("FIXTURE_READY")) await new Promise((r) => setTimeout(r, 200));
        }
        assert.ok(text.includes("FIXTURE_READY"), text);
        const ip = /FIXTURE_IP (\S+)/.exec(text)![1]!;
        const certFile = join(work, "ca.pem");
        writeFileSync(certFile, Buffer.from(/FIXTURE_CERT_B64 (\S+)/.exec(text)![1]!, "base64"));

        // The two lockfile states, written the way a developer's machine would (upstream URLs).
        const project = join(work, "app");
        mkdirSync(project);
        const manifest = (v: string) => JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: `node -e "require('left-pad')('x', 3)"` }, dependencies: { "left-pad": v } }, null, 2);
        const locks: Record<string, string> = {};
        const genConfig = buildProxyConfig({
          registries: [{ id: "main", upstream: `https://${ip}:8443`, allowPrivateAddresses: true, credential: new Credential("bearer", TOKEN) }],
          packages: { allow: allowedPackageNames([], ["left-pad"]) },
          dns: ["1.1.1.1"],
        });
        await withProxyTopology({ settings: s, config: genConfig, engine: e, extraCaFile: certFile }, async (topo) => {
          const proxy = { network: topo.networkName, proxyUrl: topo.proxyUrl, registries: [{ id: "main", isDefault: true }], lockUrlMappings: [] };
          for (const v of ["1.0.0", "1.1.0"]) {
            const dir = join(work, `gen-${v}`);
            mkdirSync(dir);
            writeFileSync(join(dir, "package.json"), manifest(v));
            await withSandbox({ projectDir: dir, container: s, proxy }, async (sb) => {
              const r = await sb.run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], 240_000);
              assert.equal(r.exitCode, 0, r.output);
              locks[v] = readFileSync(join(sb.dir, "package-lock.json"), "utf8").split(topo.proxyUrl).join(`https://${ip}:8443`);
            });
          }
        });
        writeFileSync(join(project, "package.json"), manifest("1.1.0"));
        writeFileSync(join(work, "old-package.json"), manifest("1.0.0"));
        writeFileSync(join(work, "old-lock.json"), locks["1.0.0"]!);
        writeFileSync(join(work, "new-lock.json"), locks["1.1.0"]!);
        writeFileSync(join(project, ".npmrc"), `registry=https://${ip}:8443/\n//${ip}:8443/:_authToken=\${FIXTURE_TOKEN}\n`);
        writeFileSync(join(project, ".ratchetrc"), JSON.stringify({ registryAuth: true, registryPrivateHosts: [ip], registryCaFile: certFile, isolation: "container", maxInstalls: 6 }));

        const out: string[] = [];
        const err: string[] = [];
        const code = await runCli(
          [project, "--old", join(work, "old-lock.json"), "--old-package-json", join(work, "old-package.json"), "--new", join(work, "new-lock.json"), "--json"],
          { out: (x) => out.push(x), err: (x) => err.push(x), env: { ...process.env, FIXTURE_TOKEN: TOKEN } },
        );
        const stdout = out.join("\n");
        const stderr = err.join("\n");
        assert.equal(code, 1, `stdout: ${stdout}\nstderr: ${stderr}`);
        const report = JSON.parse(stdout) as { overall: string; isolation: { level: string }; registryProxy: { registries: Array<{ credential: string }>; allowlist: string; requestsAllowed: number; requestsDenied: number }; verdicts: Array<{ name: string; status: string }> };
        assert.equal(report.overall, "broken");
        assert.equal(report.verdicts.find((v) => v.name === "left-pad")?.status, "broken");
        assert.equal(report.isolation.level, "container");
        assert.equal(report.registryProxy.registries[0]!.credential, "bearer");
        assert.equal(report.registryProxy.allowlist, "on");
        assert.ok(report.registryProxy.requestsAllowed > 0, "requests went through the proxy");
        for (const form of secretForms(TOKEN)) {
          assert.ok(!stdout.includes(form) && !stderr.includes(form), "token form found in ratchet's output");
        }
        assert.match(stderr, /registry proxy: main: https:\/\/.* \(bearer credential from \.npmrc\)/);
      } finally {
        await e.run(s.runtime === "podman" ? ["rm", "-f", "-t", "0", name] : ["rm", "-f", name]);
        rmSync(work, { recursive: true, force: true });
      }
    });
  });
});
