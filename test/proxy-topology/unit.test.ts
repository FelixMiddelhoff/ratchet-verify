import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildRunArgs, type ContainerSettings } from "../../src/sandbox/container.js";
import { Credential, secretForms } from "../../src/sandbox/registry-proxy/index.js";
import {
  buildProxyConfig, cidrOverlap, decideSweep, judgeSelfTest, labelArgs, makeLabels, parseCidr, pickSubnet, ProxyTopologyError,
  sweepStale, withInternalSubnet, withProxyTopology, type ProxyConfigInput, type TopologyOptions,
} from "../../src/sandbox/proxy-topology/index.js";
import { FakeEngine, type FakeBehavior } from "./fake-engine.js";

const CANARY = "CANARY-tok-9f3a7c21d4b85e60aa17";
const RUN = "0123456789abcdef-aaaa-bbbb-cccc-000000000001";

const input = (over: Partial<ProxyConfigInput> = {}): ProxyConfigInput => ({
  registries: [{ id: "main", upstream: "https://registry.example.com", credential: new Credential("bearer", CANARY) }],
  packages: { allow: ["left-pad"], allowPrefixes: ["@corp"] },
  dns: ["1.1.1.1"],
  ...over,
});
const settings = (runtime: "docker" | "podman"): ContainerSettings => ({ runtime, image: "node:24", rootless: runtime === "podman" });
const opts = (engine: FakeEngine, over: Partial<TopologyOptions> = {}): TopologyOptions => ({
  settings: settings(engine.runtime), config: buildProxyConfig(input()), engine, runId: RUN, sweep: false, proxyMain: "/opt/ratchet/dist/sandbox/registry-proxy/main.js", tmpRoot: process.env.TEMP, ...over,
});
const everything = (e: FakeEngine, extra: unknown[] = []): string => `${e.argvText()}\n${JSON.stringify(extra)}`;
const noCanary = (text: string): void => {
  for (const form of secretForms(CANARY)) assert.ok(!text.includes(form), `leaked secret form ${form.slice(0, 10)}...`);
};
const fails = async (p: Promise<unknown>): Promise<ProxyTopologyError> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ProxyTopologyError, String(e));
    return e;
  }
  return assert.fail("expected a ProxyTopologyError");
};
const idx = (e: FakeEngine, ...prefix: string[]): number => e.index(prefix);

describe("proxy-topology command construction", () => {
  test("docker: exact isolation flags, order, stdin only", async () => {
    const e = new FakeEngine("docker");
    const topo = await withProxyTopology(opts(e), async (t) => t);
    const netCreate = e.commands.find((c) => c.args[0] === "network" && c.args[1] === "create")!.args;
    assert.ok(netCreate.includes("--internal"));
    assert.ok(netCreate.join(" ").includes("--opt com.docker.network.bridge.inhibit_ipv4=true"));
    assert.match(netCreate[netCreate.indexOf("--subnet") + 1]!, /^10\.2[0-5]\d\.\d+\.0\/24$/);
    assert.ok(netCreate.includes(`ratchet.run=${RUN}`));
    assert.ok(netCreate.some((x) => /^ratchet\.owner=.+:\d+$/.test(x)));
    assert.ok(netCreate.some((x) => /^ratchet\.started=\d+$/.test(x)));

    const create = e.commands.find((c) => c.args[0] === "create")!.args;
    for (const flag of ["-i", "--read-only"]) assert.ok(create.includes(flag), flag);
    assert.equal(create[create.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(create[create.indexOf("--security-opt") + 1], "no-new-privileges");
    assert.ok(create.includes("--pids-limit") && create.includes("--memory"));
    assert.equal(create[create.indexOf("--network") + 1], topo.networkName);
    const mounts = create.filter((x, i) => create[i - 1] === "--mount");
    assert.deepEqual(mounts, ["type=bind,source=/opt/ratchet/dist/sandbox/registry-proxy,target=/proxy,readonly"]);
    for (const banned of ["-v", "--volume", "-p", "--publish", "-e", "--env", "--privileged", "--env-file"]) assert.ok(!create.includes(banned), banned);
    assert.deepEqual(create.slice(-3), ["node:24", "node", "/proxy/main.js"]);

    // order: create -> connect bridge -> attached start with the blob on stdin
    assert.ok(idx(e, "create") < idx(e, "network", "connect"));
    assert.deepEqual(e.commands.find((c) => c.args[0] === "network" && c.args[1] === "connect")!.args, ["network", "connect", "bridge", topo.sidecarName]);
    const attach = e.commands.find((c) => c.kind === "attach")!;
    assert.deepEqual(attach.args, ["start", "-a", "-i", topo.sidecarName]);
    assert.ok(attach.stdin!.includes(CANARY), "the blob (stdin) is the one place the credential travels");
    assert.equal(e.commands.filter((c) => c.stdin !== undefined && c.stdin !== "").length, 1);
    assert.equal(topo.proxyUrl, `http://${topo.sidecarName}:3128`);
    assert.deepEqual(topo.sandboxNetworkArgs, ["--network", topo.networkName]);
  });

  test("threat: the sidecar binds only its internal-subnet address and accepts only that subnet (both engines)", async () => {
    for (const runtime of ["docker", "podman"] as const) {
      const e = new FakeEngine(runtime);
      await withProxyTopology(opts(e), async () => {});
      const netCreate = e.commands.find((c) => c.args[0] === "network" && c.args[1] === "create")!.args;
      // docker picks the subnet itself; podman's is read back from `network inspect` (fake: 10.201.5.0/24)
      const subnet = runtime === "docker" ? netCreate[netCreate.indexOf("--subnet") + 1]! : "10.201.5.0/24";
      const blob = JSON.parse(e.commands.find((c) => c.kind === "attach")!.stdin!) as { listen: { cidr?: string; host?: string }; allowClients: string[] };
      assert.equal(blob.listen.cidr, subnet, runtime);
      assert.equal(blob.listen.host, undefined, "no fixed host: the proxy resolves its own address inside the subnet");
      assert.deepEqual(blob.allowClients, [subnet], runtime);
      assert.ok(!JSON.stringify(blob).includes("0.0.0.0"), "never a wildcard");
    }
  });

  test("podman: internal only, default bridge is `podman`, rm -t 0", async () => {
    const e = new FakeEngine("podman");
    const topo = await withProxyTopology(opts(e), async (t) => t);
    const netCreate = e.commands.find((c) => c.args[0] === "network" && c.args[1] === "create")!.args;
    assert.ok(netCreate.includes("--internal"));
    assert.ok(!netCreate.includes("--subnet") && !netCreate.join(" ").includes("inhibit_ipv4"));
    assert.deepEqual(e.commands.find((c) => c.args[0] === "network" && c.args[1] === "connect")!.args, ["network", "connect", "podman", topo.sidecarName]);
    const rm = e.commands.find((c) => c.args[0] === "rm")!.args;
    assert.deepEqual(rm.slice(0, 4), ["rm", "-f", "-t", "0"]);
  });

  test("selftest container has the real sandbox flags on the internal network", async () => {
    const e = new FakeEngine("docker");
    const topo = await withProxyTopology(opts(e), async (t) => t);
    const run = e.commands.find((c) => c.args[0] === "run")!.args;
    assert.equal(run[run.indexOf("--network") + 1], topo.networkName);
    assert.equal(run[run.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(run[run.indexOf("--security-opt") + 1], "no-new-privileges");
    assert.ok(run.includes("--pids-limit"));
    assert.ok(!run.includes("none"));
    assert.equal(run.filter((x, i) => run[i - 1] === "--mount").length, 1);
    assert.ok(topo.selfTest.length > 0);
  });

  test("extra CA is the only optional second mount, read-only, non-secret path", async () => {
    const e = new FakeEngine("podman");
    await withProxyTopology(opts(e, { extraCaFile: "/tmp/ca.pem" }), async () => 1);
    const create = e.commands.find((c) => c.args[0] === "create")!.args;
    assert.equal(create.filter((x, i) => create[i - 1] === "--mount").length, 2);
    assert.ok(create.includes("NODE_EXTRA_CA_CERTS=/ca/ca.pem"));
  });

  test("buildRunArgs: network flag, exclusive with offline", () => {
    const base = { settings: settings("docker"), root: "/r", name: "n", command: "npm", args: ["ci"] };
    const a = buildRunArgs({ ...base, network: "ratchet-net-x" });
    assert.equal(a[a.indexOf("--network") + 1], "ratchet-net-x");
    assert.throws(() => buildRunArgs({ ...base, network: "x", offline: true }), /mutually exclusive/);
    assert.ok(!buildRunArgs(base).includes("--network"));
    assert.deepEqual(buildRunArgs({ ...base, offline: true }).filter((x) => x === "--network" || x === "none"), ["--network", "none"]);
  });
});

describe("proxy-topology credential hygiene", () => {
  test("canary in no argv, log, error or recorded output; stdin blob only", async () => {
    const e = new FakeEngine("docker", { stderrLines: [`{"decision":"allow","class":"tarball","reason":"ok ${CANARY}","name":"left-pad"}`, `crash ${CANARY}`] });
    const logs: string[] = [];
    await withProxyTopology(opts(e, { log: (l) => logs.push(l) }), async (t) => {
      await new Promise((r) => setTimeout(r, 30));
      noCanary(JSON.stringify([t.audit(), t.diagnostics(), t.timings, t.selfTest, t.proxyUrl]));
      assert.equal(t.audit().length, 1);
      assert.ok(t.audit()[0]!.reason.includes("[REDACTED]"));
    });
    noCanary(everything(e, logs));
  });

  test("errors carry no canary (engine output echoing it is scrubbed)", async () => {
    const e = new FakeEngine("docker", { override: (a) => (a[0] === "network" && a[1] === "connect" ? { exitCode: 1, timedOut: false, output: `boom ${CANARY}`, truncated: false } : undefined) });
    const err = await withProxyTopology(opts(e), async () => 1).catch((x: unknown) => x);
    assert.ok(err instanceof ProxyTopologyError);
    noCanary(`${err.message}\n${err.details.join("\n")}\n${err.stack}\n${err.teardownProblems.join("\n")}`);
    assert.ok(`${err.details.join("")}`.includes("[REDACTED]"));
  });

  test("a throwing fn is rethrown, scrubbed, after teardown", async () => {
    const e = new FakeEngine("docker");
    const err = await withProxyTopology(opts(e), async () => {
      throw new Error(`user code failed with ${CANARY}`);
    }).catch((x: unknown) => x as Error);
    noCanary(`${err.message}\n${err.stack}`);
    assert.match(err.message, /user code failed/);
    assert.equal(e.containers.size, 0);
    assert.equal(e.networks.size, 0);
  });

  test("config validation: names paths, never values; credential never serialises", () => {
    const err = (() => {
      try {
        buildProxyConfig(input({ registries: [{ id: "main", upstream: "http://insecure.example.com", credential: new Credential("bearer", CANARY) }] }));
      } catch (e) {
        return e as ProxyTopologyError;
      }
    })()!;
    assert.equal(err.code, "invalid-config");
    assert.match(err.message, /config\.registries\[0\]\.upstream/);
    noCanary(err.message);
    const built = buildProxyConfig(input());
    noCanary(JSON.stringify(built.config));
    noCanary(String(built.config.registries[0]!.credential));
    assert.ok(built.stdinBlob.includes(CANARY));
    assert.equal(built.redact(`x ${CANARY} y`), "x [REDACTED] y");
    assert.throws(() => buildProxyConfig(input({ dns: [] })), /dns/);
    assert.throws(() => buildProxyConfig(input({ packages: { allowPrefixes: ["foo"] } })), /allowPrefixes/);
    assert.equal(built.config.listen.host, "127.0.0.1", "loopback placeholder until the internal subnet is known: fails closed");
    assert.ok(!built.stdinBlob.includes("0.0.0.0"), "no wildcard listen address, ever");
    const bound = withInternalSubnet(built, "10.201.5.0/24");
    assert.equal(bound.config.listen.cidr, "10.201.5.0/24");
    assert.equal(bound.config.allowClients.length, 1);
    assert.ok(!bound.stdinBlob.includes("0.0.0.0"));
    assert.ok(bound.stdinBlob.includes(CANARY), "the credential still only travels in the stdin blob");
  });
});

describe("proxy-topology teardown and failure mapping", () => {
  const assertClean = (e: FakeEngine): void => {
    assert.equal(e.containers.size, 0, "containers left");
    assert.equal(e.networks.size, 0, "networks left");
    const rm = idx(e, "rm");
    const nrm = idx(e, "network", "rm");
    assert.ok(rm >= 0 && nrm > rm, "containers are removed before the network");
    assert.ok(e.attached.every((p) => p.killed), "client killed");
  };

  test("success path tears down, containers before networks", async () => {
    const e = new FakeEngine("docker");
    await withProxyTopology(opts(e), async () => 1);
    assertClean(e);
  });

  test("fn throws: teardown still runs", async () => {
    const e = new FakeEngine("podman");
    await assert.rejects(withProxyTopology(opts(e), async () => Promise.reject(new Error("x"))), /x/);
    assertClean(e);
  });

  test("selftest failure: typed error with the failed checks, no fn, teardown", async () => {
    for (const bad of ["noDefaultRoute", "noExternal 1.1.1.1:443", "hostAndGatewayUnreachable", "sidecarReachable", "noCapabilities"]) {
      const e = new FakeEngine("docker", { failingChecks: [bad] });
      let ran = false;
      const err = await fails(withProxyTopology(opts(e), async () => {
        ran = true;
      }));
      assert.ok(err instanceof ProxyTopologyError && err.code === "selftest-failed", bad);
      assert.ok(err.details.some((d) => d.startsWith(bad)), bad);
      assert.equal(ran, false);
      assertClean(e);
    }
  });

  test("selftest: missing check or missing report is a failure, never vacuous", async () => {
    const e = new FakeEngine("docker", { omitChecks: ["noDefaultRoute"] });
    const err = await fails(withProxyTopology(opts(e), async () => 1));
    assert.equal(err.code, "selftest-failed");
    assert.ok(err.details.some((d) => d.includes("did not run")));
    assert.equal(judgeSelfTest("garbage").ok, false);
    assert.equal(judgeSelfTest("RATCHET_SELFTEST not json").ok, false);
    assertClean(e);
  });

  test("nftables failure at sidecar start maps to egress-unavailable with the actionable hint", async () => {
    const e = new FakeEngine("podman", { exitCode: 126, stderrLines: ['Error: netavark: nftables error: "nft" did not return successfully', "internal:0:0-0: Error: Could not process rule"] });
    const err = await fails(withProxyTopology(opts(e), async () => 1));
    assert.equal(err.code, "egress-unavailable");
    assert.match(err.message, /firewall_driver/);
    assertClean(e);
  });

  test("nftables failure at network connect also maps to egress-unavailable", async () => {
    const e = new FakeEngine("podman", { override: (a) => (a[1] === "connect" ? { exitCode: 1, timedOut: false, output: "netavark: nftables error", truncated: false } : undefined) });
    const err = await fails(withProxyTopology(opts(e), async () => 1));
    assert.equal(err.code, "egress-unavailable");
    assertClean(e);
  });

  test("sidecar without a default route is refused", async () => {
    const e = new FakeEngine("docker", { routeOutput: "Iface\tDestination\neth0\t0005C80A\n" });
    const err = await fails(withProxyTopology(opts(e), async () => 1));
    assert.equal(err.code, "egress-unavailable");
    assertClean(e);
  });

  test("sidecar exits early / never ready", async () => {
    const early = new FakeEngine("docker", { exitCode: 2, stderrLines: ["invalid config: config.dns: at least one"] });
    const e1 = await fails(withProxyTopology(opts(early), async () => 1));
    assert.equal(e1.code, "sidecar-exited");
    assert.ok(e1.details.join("").includes("invalid config"));
    assertClean(early);
    const silent = new FakeEngine("docker", { silent: true });
    const e2 = await fails(withProxyTopology(opts(silent, { timeouts: { readyMs: 150 } }), async () => 1));
    assert.equal(e2.code, "sidecar-timeout");
    assertClean(silent);
  });

  test("docker rejecting inhibit_ipv4 refuses (no weaker network)", async () => {
    const e = new FakeEngine("docker", { override: (a) => (a[0] === "network" && a[1] === "create" ? { exitCode: 1, timedOut: false, output: "invalid option: com.docker.network.bridge.inhibit_ipv4", truncated: false } : undefined) });
    const err = await fails(withProxyTopology(opts(e), async () => 1));
    assert.equal(err.code, "inhibit-ipv4-unsupported");
    assert.equal(e.commands.filter((c) => c.args[0] === "network" && c.args[1] === "create").length, 1);
    assert.equal(idx(e, "create"), -1, "no sidecar was created");
  });

  test("non-Linux docker is refused before anything is created", async () => {
    const e = new FakeEngine("docker", { dockerOsType: "windows" });
    const err = await fails(withProxyTopology(opts(e), async () => 1));
    assert.equal(err.code, "engine-unsupported");
    assert.equal(idx(e, "network", "create"), -1);
  });

  test("subnet conflict on create is retried with another subnet", async () => {
    const e = new FakeEngine("docker", { subnetConflicts: 2 });
    await withProxyTopology(opts(e), async () => 1);
    const subnets = e.commands.filter((c) => c.args[0] === "network" && c.args[1] === "create").map((c) => c.args[c.args.indexOf("--subnet") + 1]);
    assert.equal(subnets.length, 3);
    assert.equal(new Set(subnets).size, 3);
  });

  test("command timeouts pass through and a hung command still tears down", async () => {
    const e = new FakeEngine("docker", { override: (a) => (a[0] === "exec" ? { exitCode: null, timedOut: true, output: "", truncated: false } : undefined) });
    const err = await fails(withProxyTopology(opts(e), async () => 1));
    assert.equal(err.code, "egress-unavailable");
    assertClean(e);
  });

  test("teardown that cannot be verified is an error (and never masks the original one)", async () => {
    const stuck = new FakeEngine("docker", { override: (a, eng) => (a[0] === "rm" ? (eng.commands.length > 0 ? { exitCode: 1, timedOut: false, output: "cannot remove", truncated: false } : undefined) : undefined) });
    const err = await fails(withProxyTopology(opts(stuck), async () => 1));
    assert.equal(err.code, "teardown-failed");
    assert.ok(err.details.length > 0);
    // original failure keeps its own code and lists the teardown problems separately
    const both = new FakeEngine("docker", { failingChecks: ["noDefaultRoute"], override: (a) => (a[0] === "rm" ? { exitCode: 1, timedOut: false, output: "cannot remove", truncated: false } : undefined) });
    const err2 = await fails(withProxyTopology(opts(both), async () => 1));
    assert.equal(err2.code, "selftest-failed");
    assert.ok(err2.teardownProblems.length > 0);
  });

  test("discoveredNames and audit come from the sidecar's stderr only", async () => {
    const lines = [
      JSON.stringify({ decision: "allow", class: "packument", reason: "discovered", name: "dep-a" }),
      JSON.stringify({ decision: "allow", class: "packument", reason: "discovered", name: "dep-a" }),
      JSON.stringify({ decision: "deny", class: "denied", reason: "package-not-allowlisted", name: "evil" }),
      "audit sink dropped 3 lines",
    ];
    const e = new FakeEngine("podman", { stderrLines: lines });
    await withProxyTopology(opts(e), async (t) => {
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(t.discoveredNames(), ["dep-a"]);
      assert.equal(t.audit().length, 3);
      assert.deepEqual(t.diagnostics(), ["audit sink dropped 3 lines"]);
    });
  });
});

describe("subnet picker", () => {
  test("avoids every used range, incl. wider overlapping CIDRs", () => {
    const used = ["10.200.0.0/16", "10.201.0.0/24", "172.17.0.0/16", "10.0.0.0/8"];
    assert.equal(pickSubnet(used), undefined, "10.0.0.0/8 covers the whole pool");
    const s = pickSubnet(["10.200.0.0/12"], () => 0)!;
    assert.ok(!cidrOverlap(parseCidr(s)!, parseCidr("10.200.0.0/12")!), s);
  });
  test("skips exactly the taken candidate; deterministic with a seeded random", () => {
    assert.equal(pickSubnet([], () => 0), "10.200.0.0/24");
    assert.equal(pickSubnet(["10.200.0.0/24"], () => 0), "10.200.1.0/24");
    assert.equal(pickSubnet(["10.200.0.0/24", "10.200.1.0/25"], () => 0), "10.200.2.0/24");
  });
  test("exhaustion returns undefined; malformed entries are ignored", () => {
    assert.equal(pickSubnet(["10.200.0.0/9"]), undefined);
    assert.ok(pickSubnet(["garbage", "999.1.1.1/24", ""]) !== undefined);
  });
  test("wraps around the range end", () => {
    const last = pickSubnet([], () => 0.999999)!;
    assert.ok(last.startsWith("10.250."), last);
    assert.equal(pickSubnet([last], () => 0.999999) !== last, true);
  });
});

describe("stale sweep decision table", () => {
  const ctx = (alive: number[]) => ({ host: "ci-1", nowSeconds: 1_000_000, isPidAlive: (p: number) => alive.includes(p) });
  const young = 1_000_000 - 60;
  const old = 1_000_000 - 13 * 3600;
  test("table", () => {
    assert.deepEqual(decideSweep("ci-1:100", young, ctx([100])), { sweep: false, reason: "live-owner" });
    assert.deepEqual(decideSweep("ci-1:100", young, ctx([])), { sweep: true, reason: "dead-owner" });
    assert.deepEqual(decideSweep("other:100", young, ctx([])), { sweep: false, reason: "other-host" });
    assert.deepEqual(decideSweep("other:100", old, ctx([])), { sweep: true, reason: "too-old" });
    assert.deepEqual(decideSweep("ci-1:100", old, ctx([100])), { sweep: true, reason: "too-old" });
    assert.deepEqual(decideSweep("ci-1:100", 1_000_000 - 11 * 3600, ctx([100])), { sweep: false, reason: "live-owner" });
    assert.deepEqual(decideSweep(undefined, young, ctx([])), { sweep: false, reason: "unreadable" });
    assert.deepEqual(decideSweep("nocolon", young, ctx([])), { sweep: false, reason: "unreadable" });
    assert.deepEqual(decideSweep("ci-1:abc", young, ctx([])), { sweep: false, reason: "unreadable" });
    assert.deepEqual(decideSweep("ci-1:100", undefined, ctx([])), { sweep: true, reason: "dead-owner" });
  });

  test("sweepStale removes only dead/old runs, containers before networks, never a live run", async () => {
    const labels = (run: string, owner: string, started: number) => `${run}|${owner}|${started}`;
    const e = new FakeEngine("docker", {
      override: (a) => {
        const mk = (output: string) => ({ exitCode: 0, timedOut: false, output, truncated: false });
        if (a[0] === "ps" && a.includes("-q")) return mk("c-dead\nc-live");
        if (a[0] === "ps") return mk(a.some((x) => x === "network=n-dead") ? "sandbox-orphan" : "");
        if (a[0] === "network" && a[1] === "ls") return mk("n-dead\nn-live");
        if (a[0] === "inspect") return mk([`c-dead|${labels("r-dead", "ci-1:111", 999_900)}`, `c-live|${labels("r-live", "ci-1:222", 999_900)}`].join("\n"));
        if (a[0] === "network" && a[1] === "inspect") return mk([`n-dead|${labels("r-dead", "ci-1:111", 999_900)}`, `n-live|${labels("r-live", "ci-1:222", 999_900)}`].join("\n"));
        if (a[0] === "rm" || (a[0] === "network" && a[1] === "rm")) return mk("");
        return undefined;
      },
    });
    const r = await sweepStale(e, { host: "ci-1", nowSeconds: 1_000_000, isPidAlive: (p) => p === 222 });
    assert.deepEqual(r.removedContainers.sort(), ["c-dead", "sandbox-orphan"]);
    assert.deepEqual(r.removedNetworks, ["n-dead"]);
    assert.deepEqual(r.kept, [{ run: "r-live", reason: "live-owner" }]);
    const rm = e.commands.findIndex((c) => c.args[0] === "rm");
    const nrm = e.commands.findIndex((c) => c.args[0] === "network" && c.args[1] === "rm");
    assert.ok(rm >= 0 && nrm > rm);
    assert.ok(!e.commands.some((c) => c.args.includes("c-live") && c.args[0] === "rm"));
    assert.ok(!e.commands.some((c) => c.args.includes("n-live") && c.args[1] === "rm"));
  });

  test("labels: run, owner host:pid, started epoch", () => {
    const l = makeLabels("u", 42, "my host", 5_000);
    assert.deepEqual(labelArgs(l), ["--label", "ratchet.run=u", "--label", "ratchet.owner=my_host:42", "--label", "ratchet.started=5"]);
  });
});

test("fake engine sanity: options are typed", () => {
  const b: FakeBehavior = {};
  assert.ok(b);
});
