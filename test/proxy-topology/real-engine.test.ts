import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRunArgs, detectEngine, hostUser, type ContainerSettings } from "../../src/sandbox/container.js";
import {
  buildProxyConfig, createRealEngine, defaultBridge, ProxyTopologyError, runSelfTest, sweepStale, withProxyTopology, type Engine, type ProxyTopology,
} from "../../src/sandbox/proxy-topology/index.js";
import { Credential, secretForms } from "../../src/sandbox/registry-proxy/index.js";

/**
 * Real docker/podman. Skips cleanly without a capable engine (Windows/macOS legs, no daemon); in CI (CI=true) an
 * unavailable engine or a failing topology is a FAILURE on Linux, never a skip. RATCHET_TEST_ENGINE=docker|podman pins one.
 */
const CANARY = "CANARY-tok-9f3a7c21d4b85e60aa17";
const IN_CI = process.env.CI === "true";
const HOLD = fileURLToPath(new URL("./hold.js", import.meta.url));

let settings: ContainerSettings | undefined;
let engine: Engine | undefined;
const unavailable: { reason?: string } = {};

before(async () => {
  const preferred = process.env.RATCHET_TEST_ENGINE === "docker" || process.env.RATCHET_TEST_ENGINE === "podman" ? process.env.RATCHET_TEST_ENGINE : "auto";
  const d = await detectEngine(preferred, (o) => createRealEngine(o.command as "docker" | "podman").run(o.args, { timeoutMs: o.timeoutMs }));
  if (d.usable) {
    settings = { runtime: d.usable.runtime, rootless: d.usable.rootless, image: "node:24" };
    engine = createRealEngine(d.usable.runtime);
  }
});

const forms = secretForms(CANARY);
const noCanary = (text: string, where: string): void => {
  for (const f of forms) assert.ok(!text.includes(f), `canary form found in ${where}`);
};

/** Runs `body` unless there is no engine; a topology that cannot be built because the engine lacks a working default bridge skips locally, fails in CI. */
async function guarded(t: TestContext, body: (s: ContainerSettings, e: Engine) => Promise<void>): Promise<void> {
  if (!settings || !engine) {
    if (IN_CI && process.platform === "linux") assert.fail("CI on Linux must have a container engine");
    return t.skip("no docker/podman engine available");
  }
  try {
    await body(settings, engine);
  } catch (e) {
    if (e instanceof ProxyTopologyError && e.code === "egress-unavailable" && !IN_CI) {
      unavailable.reason = e.message;
      return t.skip(`engine cannot give the sidecar egress: ${e.message}`);
    }
    throw e;
  }
}

const labelled = async (e: Engine, runId: string): Promise<{ containers: string; networks: string }> => ({
  containers: (await e.run(["ps", "-a", "-q", "--filter", `label=ratchet.run=${runId}`])).output.trim(),
  networks: (await e.run(["network", "ls", "-q", "--filter", `label=ratchet.run=${runId}`])).output.trim(),
});

const FIXTURE_JS = String.raw`
const os = require("os"), cp = require("child_process"), fs = require("fs"), https = require("https"), crypto = require("crypto");
const ip = Object.values(os.networkInterfaces()).flat().find((a) => a.family === "IPv4" && !a.internal).address;
cp.execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/k.pem", "-out", "/tmp/c.pem", "-days", "1", "-subj", "/CN=fixture", "-addext", "subjectAltName=IP:" + ip], { stdio: "ignore" });
const auth = (h) => (h ? crypto.createHash("sha256").update(h).digest("hex") : "none");
https.createServer({ key: fs.readFileSync("/tmp/k.pem"), cert: fs.readFileSync("/tmp/c.pem") }, (req, res) => {
  console.log("REQ " + req.method + " " + req.url + " auth=" + auth(req.headers.authorization));
  if (!req.headers.authorization) { res.writeHead(401); return res.end("no"); }
  if (req.url === "/left-pad") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ name: "left-pad", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "left-pad", version: "1.0.0", dist: { tarball: "https://" + ip + ":8443/left-pad/-/left-pad-1.0.0.tgz", shasum: "0".repeat(40) } } } }));
  }
  if (req.url === "/left-pad/-/left-pad-1.0.0.tgz") { res.setHeader("content-type", "application/octet-stream"); return res.end("TARBALL-BYTES"); }
  res.writeHead(404); res.end("nf");
}).listen(8443, "0.0.0.0", () => {
  console.log("FIXTURE_IP " + ip);
  console.log("FIXTURE_CERT_B64 " + fs.readFileSync("/tmp/c.pem").toString("base64"));
  console.log("FIXTURE_READY");
});
`;

interface Fixture {
  name: string;
  ip: string;
  certFile: string;
  dir: string;
  logs(): Promise<string>;
  stop(): Promise<void>;
}

/** The spike's A4 approach: an https "private registry" on the engine's default network (the sidecar's egress side), token-checking. */
async function startFixture(e: Engine, s: ContainerSettings): Promise<Fixture> {
  const name = `ratchet-fixture-${Math.random().toString(16).slice(2, 10)}`;
  const dir = mkdtempSync(join(tmpdir(), "ratchet-fixture-"));
  const r = await e.run(["run", "-d", "--name", name, "--network", defaultBridge(s.runtime), "--label", "ratchet.test=fixture", s.image, "node", "-e", FIXTURE_JS]);
  assert.equal(r.exitCode, 0, r.output);
  const logs = async (): Promise<string> => (await e.run(["logs", name])).output;
  let text = "";
  for (let i = 0; i < 100 && !text.includes("FIXTURE_READY"); i++) {
    text = await logs();
    if (!text.includes("FIXTURE_READY")) await new Promise((res) => setTimeout(res, 200));
  }
  assert.ok(text.includes("FIXTURE_READY"), `fixture not ready: ${text}`);
  const ip = /FIXTURE_IP (\S+)/.exec(text)![1]!;
  const cert = Buffer.from(/FIXTURE_CERT_B64 (\S+)/.exec(text)![1]!, "base64");
  const certFile = join(dir, "ca.pem");
  writeFileSync(certFile, cert);
  return {
    name, ip, certFile, dir, logs,
    stop: async () => {
      await e.run(s.runtime === "podman" ? ["rm", "-f", "-t", "0", name] : ["rm", "-f", name]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Process listing of the HOST (what `ps` shows), to prove the credential is not on any command line. */
function hostProcessList(): string {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    }
    return execFileSync("ps", ["-eww", "-o", "args"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return `unavailable: ${String(e)}`;
  }
}

describe("proxy topology on a real engine", () => {
  after(async () => {
    // Belt and braces: the assertions below check per run; this leaves the daemon clean even when one fails.
    if (engine) {
      const left = (await engine.run(["ps", "-a", "-q", "--filter", "label=ratchet.test=fixture"])).output.trim();
      if (left) await engine.run(engine.runtime === "podman" ? ["rm", "-f", "-t", "0", ...left.split("\n")] : ["rm", "-f", ...left.split("\n")]);
    }
  });

  test("full topology: proxied response, credential injected upstream only, invisible everywhere in the sandbox, isolation proven, clean teardown", async (t) => {
    await guarded(t, async (s, e) => {
      const fx = await startFixture(e, s);
      const root = mkdtempSync(join(tmpdir(), "ratchet-sbx-"));
      let runId = "";
      try {
        const config = buildProxyConfig({
          registries: [{ id: "main", upstream: `https://${fx.ip}:8443`, allowPrivateAddresses: true, credential: new Credential("bearer", CANARY) }],
          packages: { allow: ["left-pad"] },
          dns: ["1.1.1.1"],
          limits: { requestTimeoutMs: 10_000 },
        });
        let sidecarLogs = "";
        let topoRef: ProxyTopology | undefined;
        const sandbox = async (topo: ProxyTopology, command: string, args: string[], name: string) =>
          e.run(buildRunArgs({ settings: s, root, name, command, args, user: hostUser(s), network: topo.networkName }), { timeoutMs: 60_000 });

        await withProxyTopology({ settings: s, config, engine: e, extraCaFile: fx.certFile }, async (topo) => {
          topoRef = topo;
          runId = topo.runId;
          console.log(`# ${s.runtime} timings ${JSON.stringify(topo.timings)}`);
          // isolation self-test gated the run and all its checks passed
          assert.ok(topo.selfTest.length >= 9 && topo.selfTest.every((c) => c.ok));

          // 1. proxied response with the credential added upstream, tarball URL rewritten to the proxy
          const pk = await sandbox(topo, "curl", ["-s", "-m", "20", `${topo.proxyUrl}/left-pad`], `${topo.sidecarName}-a`);
          assert.equal(pk.exitCode, 0, pk.output);
          assert.ok(pk.output.includes(`${topo.proxyUrl}/left-pad/-/left-pad-1.0.0.tgz`), pk.output);
          const tar = await sandbox(topo, "curl", ["-s", "-m", "20", `${topo.proxyUrl}/left-pad/-/left-pad-1.0.0.tgz`], `${topo.sidecarName}-b`);
          assert.ok(tar.output.includes("TARBALL-BYTES"), tar.output);
          const denied = await sandbox(topo, "curl", ["-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", `${topo.proxyUrl}/lodash`], `${topo.sidecarName}-c`);
          assert.equal(denied.output.trim(), "403");
          const put = await sandbox(topo, "curl", ["-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "-X", "PUT", `${topo.proxyUrl}/left-pad`], `${topo.sidecarName}-d`);
          assert.equal(put.output.trim(), "405");
          const want = createHash("sha256").update(`Bearer ${CANARY}`).digest("hex");
          const fxLogs = await fx.logs();
          assert.ok(fxLogs.includes(`REQ GET /left-pad auth=${want}`), "the upstream received exactly the injected Bearer");
          assert.ok(!/auth=none/.test(fxLogs.split("\n").filter((l) => l.startsWith("REQ")).join("\n")), "no unauthenticated request reached the upstream");
          noCanary(fxLogs, "fixture logs (it logs only a hash)");

          // 2. the sandbox cannot bypass the proxy (fixture is on the default network, reachable only via the sidecar)
          const direct = await sandbox(topo, "curl", ["-s", "-m", "4", "-k", `https://${fx.ip}:8443/left-pad`], `${topo.sidecarName}-e`);
          assert.notEqual(direct.exitCode, 0, "direct connection to the upstream must fail");

          // 3. canary invisible: sandbox env, /proc of a live sandbox, its mount, inspect of every ratchet object, sidecar /proc, host process list
          const sbxName = `${topo.sidecarName}-live`;
          const live = buildRunArgs({ settings: s, root, name: sbxName, command: "sleep", args: ["120"], user: hostUser(s), network: topo.networkName });
          live.splice(1, 0, "-d");
          assert.equal((await e.run(live)).exitCode, 0);
          const scan = await e.run(["exec", sbxName, "sh", "-c", "env; cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n'; find /sandbox -type f -exec cat {} + 2>/dev/null; cat /etc/hosts /etc/resolv.conf"]);
          noCanary(scan.output, "sandbox env/proc/mount");
          assert.ok(scan.output.includes("HOME=/sandbox/.home"), "the scan really ran inside the sandbox");
          const inspectAll = (await e.run(["inspect", sbxName, topo.sidecarName])).output + (await e.run(["network", "inspect", topo.networkName])).output;
          noCanary(inspectAll, "inspect of sandbox, sidecar and network");
          assert.ok(inspectAll.includes("ratchet.run"), "inspect really returned the labels");
          const sidecarProc = await e.run(["exec", topo.sidecarName, "sh", "-c", "cat /proc/[0-9]*/cmdline /proc/[0-9]*/environ | tr '\\0' '\\n'"]);
          assert.ok(sidecarProc.output.includes("/proxy/main.js"), "the scan really ran inside the sidecar");
          noCanary(sidecarProc.output, "sidecar /proc environ+cmdline");
          noCanary(hostProcessList(), "host process list");
          sidecarLogs = (await e.run(["logs", topo.sidecarName])).output;
          noCanary(sidecarLogs, "sidecar container logs");
          await e.run(s.runtime === "podman" ? ["rm", "-f", "-t", "0", sbxName] : ["rm", "-f", sbxName]);

          // 4. audit via the child process stdio (no network admin channel)
          await new Promise((r) => setTimeout(r, 300));
          const audit = topo.audit();
          assert.ok(audit.some((a) => a.class === "packument" && a.decision === "allow" && a.name === "left-pad"));
          assert.ok(audit.some((a) => a.class === "tarball" && a.decision === "allow"));
          assert.ok(audit.some((a) => a.decision === "deny" && a.reason === "package-not-allowlisted"));
          noCanary(JSON.stringify([audit, topo.diagnostics()]), "audit");

          // 5. a concurrent live run is never swept
          const sweep = await sweepStale(e);
          assert.ok(!sweep.removedNetworks.includes(topo.networkName) && !sweep.removedContainers.includes(topo.sidecarName));
          assert.equal((await e.run(["inspect", "-f", "{{.State.Running}}", topo.sidecarName])).output.trim(), "true");
          assert.equal((await e.run(["network", "inspect", topo.networkName])).exitCode, 0);
        });
        assert.ok(topoRef);
        const left = await labelled(e, runId);
        assert.deepEqual(left, { containers: "", networks: "" }, "teardown leaves zero containers and networks (by label)");
        noCanary(sidecarLogs, "sidecar logs");
        console.log(`# ${s.runtime} teardown ${topoRef!.timings.teardownMs} ms`);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await fx.stop();
      }
    });
  });

  test("threat: a container on the default bridge cannot use the proxy on the sidecar's egress address; the sandbox on the internal net can", async (t) => {
    await guarded(t, async (s, e) => {
      const config = buildProxyConfig({ registries: [{ id: "main", upstream: "https://registry.example.invalid", credential: new Credential("bearer", CANARY) }], packages: { allow: ["left-pad"] }, dns: ["1.1.1.1"] });
      await withProxyTopology({ settings: s, config, engine: e }, async (topo) => {
        const inspected = await e.run(["inspect", "-f", "{{json .NetworkSettings.Networks}}", topo.sidecarName]);
        const networks = JSON.parse(inspected.output.trim()) as Record<string, { IPAddress?: string }>;
        const egress = Object.entries(networks).find(([name, n]) => name !== topo.networkName && n.IPAddress);
        assert.ok(egress, `the sidecar has an egress-side address: ${inspected.output}`);
        const probe = (name: string, network: string, host: string) =>
          e.run(["run", "--rm", "--name", name, "--network", network, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "node:24", "curl", "-s", "-m", "6", "-o", "/dev/null", "-w", "%{http_code}", `http://${host}:3128/left-pad`], { timeoutMs: 60_000 });
        const fromDefaultBridge = await probe(`${topo.sidecarName}-egress`, egress![0], egress![1].IPAddress!);
        assert.notEqual(fromDefaultBridge.exitCode, 0, `the proxy answered on the egress side: ${fromDefaultBridge.output}`);
        assert.ok(!/^[1-5]\d\d$/.test(fromDefaultBridge.output.trim()), `an HTTP status came back on the egress side: ${fromDefaultBridge.output}`);
        const fromSandboxNet = await probe(`${topo.sidecarName}-inner`, topo.networkName, topo.sidecarName);
        assert.equal(fromSandboxNet.exitCode, 0, fromSandboxNet.output);
        assert.match(fromSandboxNet.output.trim(), /^[1-5]\d\d$/, "the proxy answers on the internal network (any HTTP status)");
      });
    });
  });

  test("a deliberately broken topology (sandbox on the default bridge) FAILS the self-test", async (t) => {
    await guarded(t, async (s, e) => {
      const config = buildProxyConfig({ registries: [{ id: "main", upstream: "https://registry.example.com", credential: new Credential("bearer", CANARY) }], dns: ["1.1.1.1"] });
      await withProxyTopology({ settings: s, config, engine: e }, async (topo) => {
        // control: the real topology passes
        await runSelfTest({ engine: e, settings: s, network: topo.networkName, sidecarName: topo.sidecarName, sidecarPort: 3128, name: `${topo.sidecarName}-ok` });
        // broken: same checks from a sandbox that sits on the engine's default (egress) network
        const err = await runSelfTest({
          engine: e, settings: s, network: defaultBridge(s.runtime), scanNetwork: topo.networkName, sidecarName: topo.sidecarName, sidecarPort: 3128, name: `${topo.sidecarName}-bad`,
        }).catch((x: unknown) => x);
        assert.ok(err instanceof ProxyTopologyError && err.code === "selftest-failed", String(err));
        const failed = err.details.join("\n");
        assert.match(failed, /noDefaultRoute/);
        assert.match(failed, /noExternal /);
      });
    });
  });

  test("fn throwing still tears everything down (zero containers/networks by label)", async (t) => {
    await guarded(t, async (s, e) => {
      const config = buildProxyConfig({ registries: [{ id: "main", upstream: "https://registry.example.com", credential: new Credential("bearer", CANARY) }], dns: ["1.1.1.1"] });
      let runId = "";
      await assert.rejects(
        withProxyTopology({ settings: s, config, engine: e }, async (topo) => {
          runId = topo.runId;
          throw new Error(`candidate blew up ${CANARY}`);
        }),
        (err: Error) => {
          noCanary(`${err.message}${err.stack}`, "thrown error");
          return /candidate blew up/.test(err.message);
        },
      );
      assert.deepEqual(await labelled(e, runId), { containers: "", networks: "" });
    });
  });

  test("kill -9 of the parent leaves the sidecar; the next sweep removes it", async (t) => {
    await guarded(t, async (s, e) => {
      const child = spawn(process.execPath, [HOLD, s.runtime], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let errText = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (errText += d.toString()));
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      let runId = "";
      try {
        for (let i = 0; i < 300 && !/UP (\S+)/.test(out); i++) {
          if (child.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const m = /UP (\S+)/.exec(out);
        if (!m) {
          // The child hit the same egress limitation the guard turns into a skip.
          if (/egress-unavailable|nftables|firewall_driver/.test(out + errText) && !IN_CI) return t.skip("engine cannot give the sidecar egress");
          assert.fail(`hold process did not come up: ${out}${errText}`);
        }
        runId = m[1]!;
        child.kill("SIGKILL");
        await exited;
        const orphan = await labelled(e, runId);
        assert.ok(orphan.containers !== "" && orphan.networks !== "", "kill -9 leaves the sidecar and the network behind (the reason the sweep exists)");
        const running = (await e.run(["ps", "-q", "--filter", `label=ratchet.run=${runId}`])).output.trim();
        assert.ok(running !== "", "the sidecar is still running");
        const swept = await sweepStale(e, { nowSeconds: Math.floor(Date.now() / 1000) + 11 * 60 });
        assert.equal(swept.problems.length, 0, swept.problems.join("; "));
        assert.ok(swept.removedNetworks.length >= 1);
        assert.deepEqual(await labelled(e, runId), { containers: "", networks: "" });
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        if (runId) await sweepStale(e, { nowSeconds: Math.floor(Date.now() / 1000) + 11 * 60 });
      }
    });
  });

  test("preflight fails closed on a broken sidecar (invalid mount source), leaving nothing behind", async (t) => {
    await guarded(t, async (s, e) => {
      const config = buildProxyConfig({ registries: [{ id: "main", upstream: "https://registry.example.com", credential: new Credential("bearer", CANARY) }], dns: ["1.1.1.1"] });
      const runId = "11111111-2222-3333-4444-555555555555";
      let ran = false;
      const err = await withProxyTopology({ settings: s, config, engine: e, runId, proxyMain: join(tmpdir(), "does-not-exist", "main.js"), timeouts: { readyMs: 8000 } }, async () => {
        ran = true;
      }).catch((x: unknown) => x);
      assert.ok(err instanceof ProxyTopologyError, String(err));
      assert.equal(ran, false, "no candidate code ran");
      noCanary(`${err.message}${err.details.join("")}`, "preflight error");
      assert.deepEqual(await labelled(e, runId), { containers: "", networks: "" });
    });
  });
});
