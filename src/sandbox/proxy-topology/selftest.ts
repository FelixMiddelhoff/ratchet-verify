import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunArgs, hostUser, type ContainerSettings } from "../container.js";
import { ProxyTopologyError } from "./errors.js";
import type { Engine } from "./engine.js";
import { defaultBridge } from "./commands.js";
import { parseCidr, ipv4, subnetsFromInspect } from "./subnet.js";

export const SELFTEST_MARKER = "RATCHET_SELFTEST";
/** Ports probed on every non-sidecar address the sandbox could conceivably reach (53 is left out: podman's gateway answers DNS by design). */
export const SCAN_PORTS = [22, 80, 443, 2375, 3128, 8080, 9999];
export const EXTERNAL_TCP = ["1.1.1.1:443", "9.9.9.9:443", "8.8.8.8:53"];
export const EXTERNAL_NAMES = ["example.com", "registry.npmjs.org"];

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Runs INSIDE a sandbox-shaped container (same flags as the real sandbox, on the internal network). It reports, it never
 * decides: the host side judges the checks. Plain CommonJS so it runs under `node -e` on any node image.
 */
export const SELFTEST_SCRIPT = String.raw`
const net = require("net"), dns = require("dns"), http = require("http"), fs = require("fs"), os = require("os"), cp = require("child_process");
const cfg = JSON.parse(process.argv[1]);
const out = [];
const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail: String(detail).slice(0, 240) });
const tcp = (host, port, ms) => new Promise((res) => {
  let done = false, s;
  const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} res(v); };
  try { s = net.connect({ host, port }); } catch (e) { return res("error"); }
  s.setTimeout(ms, () => fin("timeout"));
  s.on("connect", () => fin("connected"));
  s.on("error", (e) => fin(e.code || "error"));
});
const lookup = (name, opts) => new Promise((res) => {
  const t = setTimeout(() => res({ err: "timeout" }), 4000);
  dns.lookup(name, opts, (err, addr) => { clearTimeout(t); res(err ? { err: err.code || "error" } : { addr }); });
});
(async () => {
  const route = fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1).filter(Boolean);
  const defaults = route.filter((l) => l.split(/\s+/)[1] === "00000000");
  add("noDefaultRoute", defaults.length === 0, defaults.length ? "a default route exists" : "no default route");
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const cap = /CapEff:\s*([0-9a-fA-F]+)/.exec(status), nnp = /NoNewPrivs:\s*(\d)/.exec(status);
  add("noCapabilities", cap && /^0+$/.test(cap[1]), "CapEff=" + (cap ? cap[1] : "?"));
  add("noNewPrivileges", nnp && nnp[1] === "1", "NoNewPrivs=" + (nnp ? nnp[1] : "?"));
  const ip = cp.spawnSync("ip", ["route", "add", "203.0.113.0/24", "dev", "lo"]);
  add("ipRouteAddFails", ip.error ? true : ip.status !== 0, ip.error ? "no ip binary in the image; NET_ADMIN is absent (noCapabilities)" : "ip route add exit " + ip.status);
  const ext = await Promise.all([
    ...cfg.externalTcp.map(async (hp) => { const i = hp.lastIndexOf(":"); return ["noExternal " + hp, await tcp(hp.slice(0, i), Number(hp.slice(i + 1)), 1500), false]; }),
    ...cfg.externalNames.map(async (n) => ["noExternalDns " + n, await lookup(n, {}), true]),
  ]);
  for (const [name, r, isDns] of ext) {
    if (isDns) add(name, !!r.err, r.err ? r.err : "resolved to " + r.addr);
    else add(name, r !== "connected", r);
  }
  const sc = await lookup(cfg.sidecar, { all: true, family: 4 });
  add("sidecarResolvable", !sc.err, sc.err ? sc.err : sc.addr.map((a) => a.address).join(","));
  const sidecarIps = sc.err ? [] : sc.addr.map((a) => a.address);
  const httpStatus = await new Promise((res) => {
    const req = http.get({ host: cfg.sidecar, port: cfg.port, path: "/", timeout: 4000 }, (r) => { r.resume(); res(r.statusCode); });
    req.on("timeout", () => { req.destroy(); res("timeout"); });
    req.on("error", (e) => res(e.code || "error"));
  });
  add("sidecarReachable", typeof httpStatus === "number", "http " + httpStatus);
  const own = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list) own.add(a.address);
  const targets = cfg.scan.filter((a) => !own.has(a) && !sidecarIps.includes(a));
  const jobs = [];
  for (const a of targets) for (const p of cfg.ports) jobs.push(tcp(a, p, 700).then((r) => [a + ":" + p, r]));
  const res = await Promise.all(jobs);
  const open = res.filter((x) => x[1] === "connected").map((x) => x[0]);
  add("hostAndGatewayUnreachable", open.length === 0, "scanned " + targets.length + " addresses x " + cfg.ports.length + " ports; open: [" + open.join(",") + "]");
  console.log("${SELFTEST_MARKER} " + JSON.stringify(out));
})().catch((e) => { console.log("${SELFTEST_MARKER} " + JSON.stringify([{ name: "script", ok: false, detail: String(e && e.message) }])); });
`;

/** Judges the script's report; a missing or unparseable report is a failure (never vacuous). */
export function judgeSelfTest(output: string): { ok: boolean; failures: string[]; checks: SelfTestCheck[] } {
  const line = output.split("\n").find((l) => l.startsWith(SELFTEST_MARKER));
  if (!line) return { ok: false, failures: [`self-test produced no report: ${output.trim().slice(-300)}`], checks: [] };
  let checks: SelfTestCheck[];
  try {
    checks = JSON.parse(line.slice(SELFTEST_MARKER.length + 1)) as SelfTestCheck[];
  } catch {
    return { ok: false, failures: ["self-test report is not valid JSON"], checks: [] };
  }
  const required = ["noDefaultRoute", "noCapabilities", "noNewPrivileges", "ipRouteAddFails", "sidecarResolvable", "sidecarReachable", "hostAndGatewayUnreachable"];
  const failures = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  for (const r of required) if (!checks.some((c) => c.name === r)) failures.push(`${r}: check did not run`);
  if (!checks.some((c) => c.name.startsWith("noExternal ") )) failures.push("noExternal: check did not run");
  if (!checks.some((c) => c.name.startsWith("noExternalDns "))) failures.push("noExternalDns: check did not run");
  return { ok: failures.length === 0, failures, checks };
}

const gatewaysFromInspect = (json: string): string[] => {
  const out: string[] = [];
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === "string") {
      if ((key === "Gateway" || key === "gateway") && /^\d+\.\d+\.\d+\.\d+$/.test(v)) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  try {
    walk(JSON.parse(json));
  } catch {
    // no gateway info
  }
  return out;
};

/** Every address the sandbox must NOT reach: the subnet's low addresses, all gateways the engine reports, the host's own IPv4s. */
export async function gatherScanTargets(engine: Engine, internalNetwork: string): Promise<string[]> {
  const targets = new Set<string>();
  const inspectOf = async (name: string): Promise<string> => {
    const r = await engine.run(["network", "inspect", name]);
    return r.exitCode === 0 ? r.output : "";
  };
  const own = await inspectOf(internalNetwork);
  for (const s of subnetsFromInspect(own)) {
    const c = parseCidr(s);
    if (c && c.bits <= 30) for (let i = 1; i <= 10; i++) targets.add(ipv4(c.base + i));
  }
  for (const g of [...gatewaysFromInspect(own), ...gatewaysFromInspect(await inspectOf(defaultBridge(engine.runtime)))]) targets.add(g);
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) targets.add(a.address);
  return [...targets];
}

export interface SelfTestInput {
  engine: Engine;
  settings: ContainerSettings;
  /** The network the sandbox is put on (the run-scoped internal one; a deliberately wrong one makes this fail). */
  network: string;
  sidecarName: string;
  sidecarPort: number;
  /** Where the throwaway sandbox root lives (defaults to the OS temp dir). */
  tmpRoot?: string;
  name: string;
  /** Networks whose gateways/subnet feed the scan (default: `network`). */
  scanNetwork?: string;
  timeoutMs?: number;
}

/**
 * The in-topology isolation self-test. Throws `selftest-failed` when ANY check fails or the report is missing.
 * Returns the checks (all passing) so callers can put them in a report.
 */
export async function runSelfTest(input: SelfTestInput): Promise<SelfTestCheck[]> {
  const root = mkdtempSync(join(input.tmpRoot ?? tmpdir(), "ratchet-selftest-"));
  try {
    const scan = await gatherScanTargets(input.engine, input.scanNetwork ?? input.network);
    const payload = JSON.stringify({ sidecar: input.sidecarName, port: input.sidecarPort, scan, ports: SCAN_PORTS, externalTcp: EXTERNAL_TCP, externalNames: EXTERNAL_NAMES });
    const args = buildRunArgs({
      settings: input.settings,
      root,
      name: input.name,
      command: "node",
      args: ["-e", SELFTEST_SCRIPT, payload],
      user: hostUser(input.settings),
      network: input.network,
    });
    const r = await input.engine.run(args, { timeoutMs: input.timeoutMs ?? 60_000 });
    if (r.timedOut) {
      await input.engine.run(["kill", input.name]).catch(() => undefined);
      throw new ProxyTopologyError("selftest-failed", "isolation self-test timed out", ["self-test container did not finish in time"]);
    }
    const verdict = judgeSelfTest(r.output);
    if (!verdict.ok) {
      throw new ProxyTopologyError("selftest-failed", `isolation self-test failed (${verdict.failures.length} check(s)); no candidate code was run`, verdict.failures);
    }
    return verdict.checks;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
