import type { ContainerRuntime } from "../../src/sandbox/container.js";
import type { RunResult } from "../../src/sandbox/exec.js";
import type { AttachedProcess, Engine, RunOptions } from "../../src/sandbox/proxy-topology/engine.js";
import { SELFTEST_MARKER } from "../../src/sandbox/proxy-topology/selftest.js";

export interface Recorded {
  kind: "run" | "attach";
  args: string[];
  stdin?: string;
}

const ok = (output = ""): RunResult => ({ exitCode: 0, timedOut: false, output, truncated: false });
const bad = (output: string, exitCode = 1): RunResult => ({ exitCode, timedOut: false, output, truncated: false });

export const PASSING_CHECKS = [
  "noDefaultRoute", "noCapabilities", "noNewPrivileges", "ipRouteAddFails", "noExternal 1.1.1.1:443", "noExternalDns example.com",
  "sidecarResolvable", "sidecarReachable", "hostAndGatewayUnreachable",
];

interface FakeContainer {
  name: string;
  labels: Record<string, string>;
  networks: string[];
}

export interface FakeBehavior {
  /** Address count the fake self-test claims to have probed (default 12). */
  scanned?: number;
  /** Return a result to override the default answer for this command. */
  override?: (args: string[], engine: FakeEngine) => RunResult | undefined;
  /** Lines the sidecar client prints on stdout after start (default: the ready line). */
  stdoutLines?: string[];
  stderrLines?: string[];
  /** Exit the attached client immediately with this code instead of printing the ready line. */
  exitCode?: number;
  /** Never become ready. */
  silent?: boolean;
  failingChecks?: string[];
  omitChecks?: string[];
  dockerOsType?: string;
  /** How many `network create` calls fail with a subnet conflict first. */
  subnetConflicts?: number;
  routeOutput?: string;
}

export class FakeEngine implements Engine {
  readonly commands: Recorded[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, Record<string, string>>();
  readonly attached: FakeAttachedProcess[] = [];
  readonly behavior: FakeBehavior;
  constructor(readonly runtime: ContainerRuntime, behavior: FakeBehavior = {}) {
    this.behavior = behavior;
  }

  /** Every recorded argv (no stdin), flattened, for secret scans. */
  argvText(): string {
    return this.commands.map((c) => c.args.join(" ")).join("\n");
  }
  index(prefix: string[]): number {
    return this.commands.findIndex((c) => prefix.every((p, i) => c.args[i] === p));
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const a = [...args];
    this.commands.push({ kind: "run", args: a, stdin: options.stdin });
    const o = this.behavior.override?.(a, this);
    if (o) return o;
    const [cmd, sub] = a;
    if (cmd === "info") return ok(this.runtime === "docker" ? `${this.behavior.dockerOsType ?? "linux"}|name=seccomp` : "true");
    if (cmd === "image") return ok();
    if (cmd === "pull") return ok();
    if (cmd === "network" && sub === "ls") {
      const f = a.indexOf("--filter");
      const want = f >= 0 ? a[f + 1] : undefined;
      const names = [...this.networks].filter(([, l]) => !want || matchLabel(l, want)).map(([n]) => n);
      return ok(names.join("\n"));
    }
    if (cmd === "network" && sub === "inspect") {
      const names = a.slice(2).filter((x) => !x.startsWith("-"));
      const json = names.map((n) => ({ Name: n, IPAM: { Config: [{ Subnet: this.networks.has(n) ? "10.201.5.0/24" : "172.17.0.0/16", Gateway: this.networks.has(n) ? "" : "172.17.0.1" }] } }));
      return ok(JSON.stringify(json));
    }
    if (cmd === "network" && sub === "create") {
      if ((this.behavior.subnetConflicts ?? 0) > 0) {
        this.behavior.subnetConflicts!--;
        return bad("Error response from daemon: Pool overlaps with other one on this address space");
      }
      const labels = labelsOf(a);
      this.networks.set(a[a.length - 1] as string, labels);
      return ok("id");
    }
    if (cmd === "network" && sub === "connect") return ok();
    if (cmd === "network" && sub === "rm") {
      const n = a[2] as string;
      const busy = [...this.containers.values()].some((c) => c.networks.includes(n));
      if (busy) return bad("network has active endpoints");
      this.networks.delete(n);
      return ok(n);
    }
    if (cmd === "create") {
      const name = a[a.indexOf("--name") + 1] as string;
      this.containers.set(name, { name, labels: labelsOf(a), networks: [a[a.indexOf("--network") + 1] as string] });
      return ok("id");
    }
    if (cmd === "exec") return ok(this.behavior.routeOutput ?? "Iface\tDestination\tGateway\neth1\t00000000\t0100000A\n");
    if (cmd === "run") {
      const failing = new Set(this.behavior.failingChecks ?? []);
      const omit = new Set(this.behavior.omitChecks ?? []);
      const checks = PASSING_CHECKS.filter((c) => !omit.has(c)).map((name) => ({ name, ok: !failing.has(name), detail: failing.has(name) ? "FAILED" : name === "hostAndGatewayUnreachable" ? `scanned ${this.behavior.scanned ?? 12} addresses x 7 ports; open: []` : "ok" }));
      return ok(`${SELFTEST_MARKER} ${JSON.stringify(checks)}\n`);
    }
    if (cmd === "ps") {
      const f = a.indexOf("--filter");
      const want = f >= 0 ? (a[f + 1] as string) : "";
      const hits = [...this.containers.values()].filter((c) => (want.startsWith("network=") ? c.networks.includes(want.slice(8)) : matchLabel(c.labels, want)));
      return ok(hits.map((c) => c.name).join("\n"));
    }
    if (cmd === "rm") {
      for (const n of a.slice(1)) if (!n.startsWith("-") && n !== "0") this.containers.delete(n);
      return ok();
    }
    if (cmd === "kill") return ok();
    return bad(`fake engine: unhandled ${a.join(" ")}`);
  }

  spawnAttached(args: readonly string[], stdin: string): AttachedProcess {
    this.commands.push({ kind: "attach", args: [...args], stdin });
    const p = new FakeAttachedProcess();
    this.attached.push(p);
    setTimeout(() => {
      if (this.behavior.silent) return;
      for (const l of this.behavior.stderrLines ?? []) p.emitErr(l);
      if (this.behavior.exitCode !== undefined) {
        for (const l of this.behavior.stdoutLines ?? []) p.emitOut(l);
        p.exit(this.behavior.exitCode);
        return;
      }
      for (const l of this.behavior.stdoutLines ?? ["RATCHET_PROXY_READY port=3128"]) p.emitOut(l);
    }, 5);
    return p;
  }
}

export class FakeAttachedProcess implements AttachedProcess {
  killed = false;
  private out: Array<(l: string) => void> = [];
  private err: Array<(l: string) => void> = [];
  private resolveExit!: (c: number | null) => void;
  readonly exited = new Promise<number | null>((r) => {
    this.resolveExit = r;
  });
  onStdoutLine(l: (line: string) => void): void {
    this.out.push(l);
  }
  onStderrLine(l: (line: string) => void): void {
    this.err.push(l);
  }
  kill(): void {
    this.killed = true;
    this.resolveExit(null);
  }
  emitOut(line: string): void {
    for (const l of this.out) l(line);
  }
  emitErr(line: string): void {
    for (const l of this.err) l(line);
  }
  exit(code: number): void {
    this.resolveExit(code);
  }
}

function labelsOf(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  args.forEach((x, i) => {
    if (x === "--label") {
      const [k, ...v] = (args[i + 1] as string).split("=");
      out[k as string] = v.join("=");
    }
  });
  return out;
}

function matchLabel(labels: Record<string, string>, filter: string): boolean {
  const m = /^label=([^=]+)(?:=(.*))?$/.exec(filter);
  if (!m) return false;
  const [, key, value] = m;
  return key! in labels && (value === undefined || labels[key!] === value);
}
