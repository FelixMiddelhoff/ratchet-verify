import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_CONFIG, type Config } from "../../src/config.js";
import { withRegistryProxy } from "../../src/pipeline/registry-proxy.js";
import type { ResolvedIsolation } from "../../src/sandbox/index.js";
import { FakeEngine } from "./fake-engine.js";

const TOKEN = "npm_PIPELINETOKEN0123456789abcdefgh";
const lock = (names: string[]) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...Object.fromEntries(names.map((n) => [`node_modules/${n}`, { version: "1.0.0" }])) } });
const container: ResolvedIsolation = { info: { level: "container", runtime: "docker", image: "node:24" }, container: { runtime: "docker", image: "node:24", rootless: false }, notes: [] };
const tempDir: ResolvedIsolation = { info: { level: "temp-dir" }, notes: [] };

async function inProject(npmrc: string | undefined, body: (dir: string, home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-rp-"));
  const home = join(dir, "home");
  mkdirSync(home);
  try {
    if (npmrc !== undefined) writeFileSync(join(dir, ".npmrc"), npmrc);
    await body(dir, home);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const base = (dir: string, home: string, config: Partial<Config>, isolation = container, env: NodeJS.ProcessEnv = {}) => ({
  config: { ...DEFAULT_CONFIG, ...config }, isolation, projectDir: dir, env, homeDir: home, lockfiles: [lock(["a", "@s/b"]), lock(["a", "c"])], manifestNames: ["a", "d"],
});

describe("withRegistryProxy", () => {
  test("off by default: no proxy, no engine call", async () => {
    await inProject(undefined, async (dir, home) => {
      const e = new FakeEngine("docker");
      assert.equal(await withRegistryProxy({ ...base(dir, home, {}), engine: e }, async (run) => run), undefined);
      assert.equal(e.commands.length, 0);
    });
  });

  test("registryAuth with temp-dir isolation is an error, never a fallback", async () => {
    await inProject(undefined, async (dir, home) => {
      await assert.rejects(withRegistryProxy(base(dir, home, { registryAuth: true }, tempDir), async () => 1), /needs container isolation/);
    });
  });

  test("enabled: credential only on the sidecar's stdin, allowlist from lockfiles, sandbox config and report info", async () => {
    await inProject(`registry=https://npm.corp.example/api/npm/repo/\n//npm.corp.example/api/npm/repo/:_authToken=\${CORP_TOKEN}\n`, async (dir, home) => {
      const e = new FakeEngine("docker");
      const logs: string[] = [];
      const result = await withRegistryProxy({ ...base(dir, home, { registryAuth: true, registryAllowHosts: ["cdn.example.com:443"] }, container, { CORP_TOKEN: TOKEN }), engine: e, log: (l) => logs.push(l) }, async (run) => {
        assert.ok(run);
        assert.match(run.proxy.network, /^ratchet-net-/);
        assert.deepEqual(run.proxy.registries, [{ id: "main", isDefault: true }]);
        assert.deepEqual(run.proxy.lockUrlMappings.map((m) => m.from), ["https://npm.corp.example/api/npm/repo/"]);
        assert.ok(run.proxy.lockUrlMappings[0]!.to.startsWith(`${run.proxy.proxyUrl}/`));
        return run.info();
      });
      assert.deepEqual(result.registries, [{ id: "main", host: "npm.corp.example/api/npm/repo", credential: "bearer" }]);
      assert.deepEqual([result.allowlist, result.allowedPackages, result.allowHosts], ["on", 4, ["cdn.example.com:443"]]);
      const attach = e.commands.find((c) => c.kind === "attach")!;
      const blob = JSON.parse(attach.stdin!);
      assert.deepEqual(blob.packages.allow, ["@s/b", "a", "c", "d"]);
      assert.equal(blob.discovery, "audit");
      assert.ok(attach.stdin!.includes(TOKEN), "the token travels on stdin");
      const elsewhere = JSON.stringify([e.commands.filter((c) => c.kind !== "attach"), logs, result]);
      assert.ok(!elsewhere.includes(TOKEN), "and nowhere else");
    });
  });

  test("allowlist off: allowAll in the proxy config, reported as off and logged", async () => {
    await inProject(undefined, async (dir, home) => {
      const e = new FakeEngine("docker");
      const logs: string[] = [];
      const info = await withRegistryProxy({ ...base(dir, home, { registryAuth: true, registryAllowlist: false }), engine: e, log: (l) => logs.push(l) }, async (run) => run!.info());
      assert.equal(info.allowlist, "off");
      assert.equal(JSON.parse(e.commands.find((c) => c.kind === "attach")!.stdin!).packages.allowAll, true);
      assert.ok(logs.some((l) => /allowlist is OFF/.test(l)));
    });
  });

  test("an unset ${VAR} in .npmrc fails before anything is started", async () => {
    await inProject(`registry=https://a.example/\n//a.example/:_authToken=\${MISSING_TOKEN}\n`, async (dir, home) => {
      const e = new FakeEngine("docker");
      await assert.rejects(withRegistryProxy({ ...base(dir, home, { registryAuth: true }), engine: e }, async () => 1), /MISSING_TOKEN/);
      assert.equal(e.commands.length, 0);
    });
  });
});
