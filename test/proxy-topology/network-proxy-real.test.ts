import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test, type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { withRegistryProxy } from "../../src/pipeline/registry-proxy.js";
import { detectEngine, type ContainerSettings } from "../../src/sandbox/container.js";
import type { ResolvedIsolation } from "../../src/sandbox/index.js";
import { createRealEngine, ProxyTopologyError, type Engine } from "../../src/sandbox/proxy-topology/index.js";
import { withSandbox } from "../../src/sandbox/sandbox.js";

/**
 * `--network proxy` (#23) with no `--registry-auth`: pure network restriction, no custom registry. Proves on a real
 * engine that the install phase (a) really can install a real package from the real npm registry through the proxy,
 * and (b) cannot reach any other host directly — the sandbox sits on an internal-only network whose only reachable
 * peer is the proxy sidecar, same as the registryAuth path, just without a credential or a custom registry. Skips
 * without an engine (Windows/macOS legs); on Linux CI a missing engine is a failure. Needs real internet access to
 * registry.npmjs.org (same requirement `npm run corpus` already has).
 */
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

describe("--network proxy on a real engine", () => {
  test("installs a real package from the real npm registry through the proxy, and cannot reach any other host directly", async (t) => {
    await guarded(t, async (s, e) => {
      const work = mkdtempSync(join(tmpdir(), "ratchet-network-proxy-e2e-"));
      try {
        const project = join(work, "app");
        mkdirSync(project);
        writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "left-pad": "1.0.0" } }, null, 2));

        const isolation: ResolvedIsolation = { info: { level: "container", runtime: s.runtime, image: s.image }, container: s, notes: [] };
        const logs: string[] = [];
        await withRegistryProxy(
          {
            config: { ...DEFAULT_CONFIG, containerNetwork: "proxy" },
            isolation,
            projectDir: project,
            env: process.env,
            baseLockfileText: "",
            baseManifestNames: [],
            candidateNames: ["left-pad"],
            engine: e,
            log: (l) => logs.push(l),
          },
          async (run) => {
            assert.ok(run, "the proxy runs without --registry-auth when containerNetwork is proxy");
            assert.deepEqual(run.proxy.registries, [{ id: "main", isDefault: true }]);

            await withSandbox({ projectDir: project, container: s, proxy: run.proxy }, async (sb) => {
              // (a) a real install from the real npm registry, through the proxy, works.
              const install = await sb.run("npm", ["install", "--no-audit", "--no-fund"], 180_000);
              assert.equal(install.exitCode, 0, install.output);

              // (b) the sandbox has no route to the internet except the proxy: a direct connection attempt to an
              // unrelated public host must fail (refused/reset/timeout), never succeed. Written as a file (not
              // `node -e <big string>`) so nothing depends on how the engine's CLI quotes a multi-line argument.
              writeFileSync(join(sb.dir, "probe.js"), [
                'const net = require("net");',
                'const conn = net.connect({ host: "1.1.1.1", port: 443 });',
                'conn.setTimeout(4000, () => { console.log("PROBE timeout"); conn.destroy(); });',
                'conn.on("connect", () => { console.log("PROBE connected"); conn.destroy(); });',
                'conn.on("error", (e) => { console.log("PROBE " + (e.code || "error")); });',
              ].join("\n"));
              const probe = await sb.run("node", ["probe.js"], 20_000);
              assert.match(probe.output, /PROBE (?!connected)/, `direct egress to 1.1.1.1 should be blocked, got: ${JSON.stringify(probe)}`);
            });
            const info = run.info();
            assert.equal(info.registries[0]!.host, "registry.npmjs.org");
            assert.equal(info.registries[0]!.credential, "none");
            assert.ok(info.requestsAllowed > 0, "requests went through the proxy");
            return info;
          },
        );
        assert.ok(logs.some((l) => /network-only mode/.test(l)));
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  });
});
