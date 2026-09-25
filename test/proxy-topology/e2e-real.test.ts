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

// Serves one real package (left-pad 1.0.0 with a real tarball and integrity) and rejects requests without a token.
const FIXTURE_JS = String.raw`
const os = require("os"), cp = require("child_process"), fs = require("fs"), https = require("https"), crypto = require("crypto");
const ip = Object.values(os.networkInterfaces()).flat().find((a) => a.family === "IPv4" && !a.internal).address;
cp.execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/k.pem", "-out", "/tmp/c.pem", "-days", "1", "-subj", "/CN=fixture", "-addext", "subjectAltName=IP:" + ip], { stdio: "ignore" });
fs.mkdirSync("/tmp/pkg/package", { recursive: true });
fs.writeFileSync("/tmp/pkg/package/package.json", JSON.stringify({ name: "left-pad", version: "1.0.0", main: "index.js" }));
fs.writeFileSync("/tmp/pkg/package/index.js", "module.exports = (s, n) => String(s).padStart(n);\n");
cp.execFileSync("tar", ["czf", "/tmp/left-pad-1.0.0.tgz", "-C", "/tmp/pkg", "package"]);
const tgz = fs.readFileSync("/tmp/left-pad-1.0.0.tgz");
const integrity = "sha512-" + crypto.createHash("sha512").update(tgz).digest("base64");
const shasum = crypto.createHash("sha1").update(tgz).digest("hex");
const auth = (h) => (h ? crypto.createHash("sha256").update(h).digest("hex") : "none");
https.createServer({ key: fs.readFileSync("/tmp/k.pem"), cert: fs.readFileSync("/tmp/c.pem") }, (req, res) => {
  console.log("REQ " + req.method + " " + req.url + " auth=" + auth(req.headers.authorization));
  if (!req.headers.authorization) { res.writeHead(401); return res.end("no"); }
  if (req.url === "/left-pad") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ name: "left-pad", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "left-pad", version: "1.0.0", dist: { tarball: "https://" + ip + ":8443/left-pad/-/left-pad-1.0.0.tgz", integrity, shasum } } } }));
  }
  if (req.url === "/left-pad/-/left-pad-1.0.0.tgz") { res.setHeader("content-type", "application/octet-stream"); return res.end(tgz); }
  res.writeHead(404); res.end("nf");
}).listen(8443, "0.0.0.0", () => {
  console.log("FIXTURE_IP " + ip);
  console.log("FIXTURE_CERT_B64 " + fs.readFileSync("/tmp/c.pem").toString("base64"));
  console.log("FIXTURE_READY");
});
`;

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
          });
          const fx = (await e.run(["logs", name])).output;
          const want = createHash("sha256").update(`Bearer ${CANARY}`).digest("hex");
          const reqs = fx.split("\n").filter((l) => l.startsWith("REQ"));
          assert.ok(reqs.some((l) => l.includes("/left-pad ") && l.endsWith(`auth=${want}`)), reqs.join("\n"));
          assert.ok(reqs.every((l) => l.endsWith(`auth=${want}`)), "every upstream request carried the injected token: " + reqs.join("\n"));
          const audit = topo.audit();
          assert.ok(audit.some((a) => a.class === "tarball" && a.decision === "allow"), JSON.stringify(audit));
          for (const form of secretForms(CANARY)) assert.ok(!JSON.stringify([audit, topo.diagnostics()]).includes(form));
        });
      } finally {
        await e.run(s.runtime === "podman" ? ["rm", "-f", "-t", "0", name] : ["rm", "-f", name]);
        rmSync(work, { recursive: true, force: true });
      }
    });
  });
});

