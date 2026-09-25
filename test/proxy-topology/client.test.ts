import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { runInContainer, type ContainerSettings } from "../../src/sandbox/container.js";
import { applyProxyClient, type SandboxProxy } from "../../src/sandbox/proxy-client.js";
import { withSandbox } from "../../src/sandbox/sandbox.js";

const PROXY_URL = "http://ratchet-proxy-1a2b3c4d:3128";
const TOKEN = "npm_SUPERSECRETTOKEN0123456789";
const proxy: SandboxProxy = {
  network: "ratchet-net-1a2b3c4d",
  proxyUrl: PROXY_URL,
  registries: [{ id: "main", isDefault: true }],
  lockUrlMappings: [{ from: "https://registry.yarnpkg.com/", to: `${PROXY_URL}/` }],
};

async function inProject(files: Record<string, string>, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-client-"));
  try {
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("applyProxyClient", () => {
  test("npm: project .npmrc loses registry and token, lockfile stays untouched", async () => {
    await inProject(
      { ".npmrc": `registry=https://priv.example/\n//priv.example/:_authToken=${TOKEN}\nlegacy-peer-deps=true\n`, "package-lock.json": `{"resolved":"https://priv.example/a.tgz"}` },
      async (dir) => {
        const r = await applyProxyClient(dir, proxy, "package-lock.json");
        const rc = readFileSync(join(dir, ".npmrc"), "utf8");
        assert.ok(!rc.includes(TOKEN) && !rc.includes("priv.example") && rc.includes("legacy-peer-deps=true") && rc.includes(`registry=${PROXY_URL}/`));
        assert.equal(r.lockUrlsReplaced, 0);
        assert.ok(readFileSync(join(dir, "package-lock.json"), "utf8").includes("priv.example"));
      },
    );
  });

  test("yarn classic: .yarnrc written, lockfile URLs moved to the proxy", async () => {
    await inProject({ ".yarnrc": `registry "https://priv.example/"\n`, "yarn.lock": `# yarn lockfile v1\n\na@1:\n  resolved "https://registry.yarnpkg.com/a/-/a-1.tgz#abc"\n` }, async (dir) => {
      const r = await applyProxyClient(dir, proxy, "yarn.lock");
      assert.equal(r.lockUrlsReplaced, 1);
      assert.ok(readFileSync(join(dir, "yarn.lock"), "utf8").includes(`resolved "${PROXY_URL}/a/-/a-1.tgz#abc"`));
      const rc = readFileSync(join(dir, ".yarnrc"), "utf8");
      assert.ok(rc.includes(`registry "${PROXY_URL}/"`) && !rc.includes("priv.example"));
    });
  });

  test("yarn berry: .yarnrc.yml written", async () => {
    await inProject({ ".yarnrc.yml": `npmAuthToken: ${TOKEN}\nnodeLinker: node-modules\n`, "yarn.lock": `__metadata:\n  version: 8\n` }, async (dir) => {
      await applyProxyClient(dir, proxy, "yarn.lock");
      const yml = readFileSync(join(dir, ".yarnrc.yml"), "utf8");
      assert.ok(!yml.includes(TOKEN) && yml.includes("nodeLinker: node-modules") && yml.includes(`npmRegistryServer: "${PROXY_URL}/"`));
    });
  });
});

describe("sandbox with a proxy", () => {
  test("temp-dir isolation is refused", async () => {
    await inProject({ "package.json": "{}" }, async (dir) => {
      await assert.rejects(withSandbox({ projectDir: dir, proxy }, async () => 1), /needs container isolation/);
    });
  });

  test("install phases join the proxy network, offline phases stay offline", async () => {
    const settings: ContainerSettings = { runtime: "docker", image: "node:24", rootless: true };
    const seen: string[][] = [];
    const exec = async (o: { args: string[] }) => {
      seen.push(o.args);
      return { exitCode: 0, timedOut: false, output: "", truncated: false };
    };
    await runInContainer(settings, "/r", "npm", ["ci"], 1000, exec, { network: "ratchet-net-x" });
    await runInContainer(settings, "/r", "npm", ["test"], 1000, exec, { network: "ratchet-net-x", offline: true });
    const net = (a: string[]) => a[a.indexOf("--network") + 1];
    assert.equal(net(seen[0]!), "ratchet-net-x");
    assert.equal(net(seen[1]!), "none");
  });
});
