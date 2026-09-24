import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { DEFAULT_IMAGE, detectEngine, type ContainerSettings } from "../container.js";
import type { AuditEntry } from "../registry-proxy/index.js";
import { READY_PREFIX } from "../registry-proxy/index.js";
import type { BuiltProxyConfig } from "./build-config.js";
import { SIDECAR_PORT } from "./build-config.js";
import {
  networkCreateArgs, networkNameFor, proxyUrlFor, sidecarConnectArgs, sidecarCreateArgs, sidecarNameFor, sidecarStartArgs,
} from "./commands.js";
import { createRealEngine, type AttachedProcess, type Engine } from "./engine.js";
import { ProxyTopologyError } from "./errors.js";
import { runSelfTest, type SelfTestCheck } from "./selftest.js";
import { pickSubnet, subnetsFromInspect, SUBNET_CONFLICT_RE } from "./subnet.js";
import { LABEL_RUN, makeLabels, rmArgs, sweepStale, type SweepResult } from "./sweep.js";

/** The compiled proxy directory next to this module (`dist/sandbox/registry-proxy`): main.js imports only its siblings and node built-ins. */
export const DEFAULT_PROXY_MAIN = fileURLToPath(new URL("../registry-proxy/main.js", import.meta.url));

export interface TopologyTimeouts {
  readyMs: number;
  commandMs: number;
  pullMs: number;
  selfTestMs: number;
}
export const DEFAULT_TIMEOUTS: Readonly<TopologyTimeouts> = { readyMs: 20_000, commandMs: 60_000, pullMs: 10 * 60_000, selfTestMs: 60_000 };

export interface TopologyOptions {
  settings: ContainerSettings;
  /** Validated config + stdin blob from `buildProxyConfig`. */
  config: BuiltProxyConfig;
  /** Injectable engine (fake in unit tests). Defaults to the real docker/podman client. */
  engine?: Engine;
  /** Path of the compiled proxy `main.js` (its directory is mounted read-only). */
  proxyMain?: string;
  /** Optional non-secret CA bundle for the sidecar (NODE_EXTRA_CA_CERTS), mounted read-only. */
  extraCaFile?: string;
  sidecarImage?: string;
  /** Sweep stale ratchet resources first (default true). */
  sweep?: boolean;
  timeouts?: Partial<TopologyTimeouts>;
  /** Redacted progress lines. */
  log?: (line: string) => void;
  /** Test seams. */
  runId?: string;
  random?: () => number;
  tmpRoot?: string;
}

export interface TopologyTimings {
  sweepMs: number;
  networkMs: number;
  sidecarReadyMs: number;
  selfTestMs: number;
  setupMs: number;
  teardownMs: number;
}

export interface ProxyTopology {
  /** What the sandbox's package-manager config points at, e.g. `http://ratchet-proxy-1a2b3c4d:3128`. */
  proxyUrl: string;
  networkName: string;
  /** Arguments for `buildRunArgs({ network })`: `--network <internal>`. */
  sandboxNetworkArgs: string[];
  sidecarName: string;
  runId: string;
  /** The proxy's audit lines, read from the sidecar client's stderr (never over the network). Redacted. */
  audit(): AuditEntry[];
  /** Names auto-allowed by `discovery: "audit"`. */
  discoveredNames(): string[];
  /** Non-JSON stderr lines (drop counters, crash line). Redacted. */
  diagnostics(): string[];
  /** The isolation self-test result that gated this run. */
  selfTest: readonly SelfTestCheck[];
  timings: Readonly<TopologyTimings>;
}

const MAX_KEPT_LINES = 10_000;
const EGRESS_RE = /nftables|Could not process rule|netavark|iptables|firewall/i;
const EGRESS_HINT =
  "the container engine cannot start a container on its default (non-internal) bridge network, which the proxy sidecar needs for egress. " +
  "Rootless podman on WSL2 kernels without nft_fib_inet: set `[network] firewall_driver=\"none\"` in the podman machine's containers.conf, or use a kernel/distro with netavark nftables support. " +
  "ratchet never edits that file and never falls back to running without the proxy.";

const now = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/**
 * Creates the run-scoped internal network, starts the credential-holding proxy sidecar (dual-homed) and proves the
 * isolation from a sandbox-shaped container BEFORE `fn` runs. Everything is torn down in `finally`, verified.
 * Any protection that cannot be established throws a typed `ProxyTopologyError`; there is no unprotected fallback.
 */
export async function withProxyTopology<T>(options: TopologyOptions, fn: (topology: ProxyTopology) => Promise<T>): Promise<T> {
  const { settings, config } = options;
  const engine = options.engine ?? createRealEngine(settings.runtime);
  const redact = config.redact;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const runId = options.runId ?? randomUUID();
  const labels = makeLabels(runId);
  const networkName = networkNameFor(runId);
  const sidecarName = sidecarNameFor(runId);
  const log = (line: string): void => options.log?.(redact(line));
  const fail = (code: ConstructorParameters<typeof ProxyTopologyError>[0], message: string, details: string[] = []): ProxyTopologyError =>
    new ProxyTopologyError(code, redact(message), details.map((d) => redact(d)));

  const timings: TopologyTimings = { sweepMs: 0, networkMs: 0, sidecarReadyMs: 0, selfTestMs: 0, setupMs: 0, teardownMs: 0 };
  let client: AttachedProcess | undefined;
  const audit: AuditEntry[] = [];
  const diagnostics: string[] = [];
  const t0 = now();

  const run = (args: string[], timeoutMs = timeouts.commandMs) => engine.run(args, { timeoutMs });

  let tornDown = false;
  const body = async (): Promise<T> => {
    // 0. Engine must run LINUX containers (docker OSType, podman); same rule as the sandbox itself.
    const detected = await detectEngine(settings.runtime, (o) => engine.run(o.args, { timeoutMs: o.timeoutMs }));
    if (!detected.usable) throw fail("engine-unsupported", `${settings.runtime} is not available or not running Linux containers; the registry proxy topology needs a Linux-containers engine`);

    if (options.sweep !== false) {
      const s = now();
      const swept = await sweepStale(engine);
      timings.sweepMs = now() - s;
      if (swept.removedContainers.length + swept.removedNetworks.length > 0) log(`swept stale ratchet resources: ${swept.removedContainers.length} container(s), ${swept.removedNetworks.length} network(s)`);
    }

    // 1. Images (a first pull must not be charged to the readiness timeout).
    for (const image of new Set([options.sidecarImage ?? DEFAULT_IMAGE, settings.image])) {
      const present = await run(["image", "inspect", image]);
      if (present.exitCode !== 0) {
        const pulled = await run(["pull", image], timeouts.pullMs);
        if (pulled.exitCode !== 0) throw fail("sidecar-start-failed", `could not pull container image ${image}`, [pulled.output.trim().slice(-300)]);
      }
    }

    // 2. Internal network (explicit collision-safe subnet on docker, retry on conflict).
    const tn = now();
    await createNetwork();
    timings.networkMs = now() - tn;

    // 3. Sidecar: create on the internal net, join the egress bridge, start attached with the config on STDIN only.
    const ts = now();
    const created = await run(
      sidecarCreateArgs({
        runtime: settings.runtime,
        name: sidecarName,
        network: networkName,
        labels,
        image: options.sidecarImage ?? DEFAULT_IMAGE,
        proxyDir: dirname(options.proxyMain ?? DEFAULT_PROXY_MAIN),
        extraCaFile: options.extraCaFile,
      }),
    );
    if (created.exitCode !== 0) throw fail("sidecar-start-failed", "could not create the proxy sidecar container", [created.output.trim().slice(-400)]);
    const connected = await run(sidecarConnectArgs(settings.runtime, sidecarName));
    if (connected.exitCode !== 0) {
      throw fail(EGRESS_RE.test(connected.output) ? "egress-unavailable" : "sidecar-start-failed", `could not attach the sidecar to the engine's default network: ${EGRESS_HINT}`, [connected.output.trim().slice(-400)]);
    }

    let stdoutText = "";
    let stderrText = "";
    let readyPort: number | undefined;
    client = engine.spawnAttached(sidecarStartArgs(sidecarName), config.stdinBlob);
    client.onStdoutLine((line) => {
      stdoutText = `${stdoutText}${line}\n`.slice(-4000);
      const m = new RegExp(`^${READY_PREFIX} port=(\\d+)$`).exec(line.trim());
      if (m) readyPort = Number(m[1]);
    });
    client.onStderrLine((raw) => {
      const line = redact(raw);
      stderrText = `${stderrText}${line}\n`.slice(-4000);
      const entry = parseAuditLine(line);
      if (entry) {
        if (audit.length < MAX_KEPT_LINES) audit.push(entry);
      } else if (diagnostics.length < 1000) diagnostics.push(line.slice(0, 500));
    });
    const exitedEarly = client.exited.then((code) => code);
    const deadline = now() + timeouts.readyMs;
    let earlyExit: number | null | undefined;
    void exitedEarly.then((c) => {
      earlyExit = c;
    });
    while (readyPort === undefined) {
      if (earlyExit !== undefined) {
        const text = `${stdoutText}${stderrText}`;
        throw fail(EGRESS_RE.test(text) ? "egress-unavailable" : "sidecar-exited", EGRESS_RE.test(text) ? `sidecar could not start: ${EGRESS_HINT}` : `the proxy sidecar exited (code ${earlyExit}) before it was ready`, [redact(text.trim().slice(-500))]);
      }
      if (now() > deadline) throw fail("sidecar-timeout", `the proxy sidecar was not ready within ${timeouts.readyMs} ms`, [redact(`${stdoutText}${stderrText}`.trim().slice(-500))]);
      await new Promise((r) => setTimeout(r, 25));
    }
    timings.sidecarReadyMs = now() - ts;
    if (readyPort !== SIDECAR_PORT) throw fail("sidecar-start-failed", `the sidecar listens on port ${readyPort}, expected ${SIDECAR_PORT}`);

    // 4. Egress capability: the sidecar must have a default route (through the engine's bridge).
    const route = await run(["exec", sidecarName, "cat", "/proc/net/route"]);
    if (route.exitCode !== 0 || !route.output.split("\n").slice(1).some((l) => l.split(/\s+/)[1] === "00000000")) {
      throw fail("egress-unavailable", `the sidecar has no default route, so it cannot reach the registry: ${EGRESS_HINT}`, [route.output.trim().slice(-300)]);
    }

    // 5. Isolation self-test from a sandbox-shaped container. Any failed check throws.
    const tt = now();
    const checks = await runSelfTest({
      engine,
      settings,
      network: networkName,
      sidecarName,
      sidecarPort: SIDECAR_PORT,
      name: `ratchet-selftest-${runId.slice(0, 8)}`,
      tmpRoot: options.tmpRoot,
      timeoutMs: timeouts.selfTestMs,
    }).catch((e: unknown) => {
      throw e instanceof ProxyTopologyError ? fail(e.code, e.message, [...e.details]) : fail("selftest-failed", `isolation self-test could not run: ${e instanceof Error ? e.message : String(e)}`);
    });
    timings.selfTestMs = now() - tt;
    timings.setupMs = now() - t0;
    log(`proxy topology ready (${timings.setupMs} ms): network ${networkName}, sidecar ${sidecarName}`);

    const topology: ProxyTopology = {
      proxyUrl: proxyUrlFor(sidecarName),
      networkName,
      sandboxNetworkArgs: ["--network", networkName],
      sidecarName,
      runId,
      audit: () => audit.slice(),
      discoveredNames: () => [...new Set(audit.filter((e) => e.reason === "discovered" && e.name !== null).map((e) => e.name as string))],
      diagnostics: () => diagnostics.slice(),
      selfTest: checks,
      timings,
    };
    return await fn(topology);
  };

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let problems: string[];
  try {
    problems = await teardown();
  } catch (e) {
    problems = [redact(e instanceof Error ? e.message : String(e))];
  }
  if (!outcome.ok) {
    const e = outcome.error;
    if (e instanceof ProxyTopologyError) {
      e.teardownProblems = problems;
      throw e;
    }
    if (e instanceof Error) {
      // Thrown by the caller's fn (or unexpected): same error, scrubbed.
      e.message = redact(e.message);
      if (e.stack) e.stack = redact(e.stack);
      throw e;
    }
    throw fail("sidecar-start-failed", String(e));
  }
  if (problems.length > 0) throw fail("teardown-failed", "teardown could not be verified: resources may be left behind", problems);
  return outcome.value;

  async function createNetwork(): Promise<void> {
    const used: string[] = [];
    if (settings.runtime === "docker") {
      const ids = await run(["network", "ls", "-q"]);
      const list = ids.output.split("\n").map((l) => l.trim()).filter(Boolean);
      if (list.length > 0) used.push(...subnetsFromInspect((await run(["network", "inspect", ...list])).output));
    }
    const attempts = settings.runtime === "docker" ? 8 : 1;
    let last = "";
    for (let i = 0; i < attempts; i++) {
      const subnet = settings.runtime === "docker" ? pickSubnet(used, options.random) : undefined;
      if (settings.runtime === "docker" && subnet === undefined) throw fail("network-create-failed", "no free subnet left in the private range 10.200.0.0/12 style pool");
      const r = await run(networkCreateArgs(settings.runtime, networkName, labels, subnet));
      if (r.exitCode === 0) return;
      last = r.output.trim();
      if (subnet !== undefined && SUBNET_CONFLICT_RE.test(last)) {
        used.push(subnet);
        continue;
      }
      if (/inhibit_ipv4|invalid option|unsupported option|unknown option/i.test(last)) {
        throw fail("inhibit-ipv4-unsupported", "the engine rejected --opt com.docker.network.bridge.inhibit_ipv4=true; without it the host stays reachable from the sandbox, so ratchet refuses to continue", [last.slice(-300)]);
      }
      break;
    }
    throw fail("network-create-failed", `could not create the internal network ${networkName}`, [last.slice(-300)]);
  }

  async function teardown(): Promise<string[]> {
    if (tornDown) return [];
    tornDown = true;
    const problems: string[] = [];
    const ts = now();
    client?.kill();
    const names = new Set<string>();
    for (const filter of [`label=${LABEL_RUN}=${runId}`, `network=${networkName}`]) {
      const r = await run(["ps", "-a", "-q", "--filter", filter], 30_000);
      for (const id of r.output.split("\n").map((l) => l.trim()).filter(Boolean)) names.add(id);
    }
    names.add(sidecarName);
    const rm = await run(rmArgs(engine, [...names]), 30_000);
    // `rm -f` of a name that never existed exits non-zero on some engines; the verification below is what counts.
    const left = await run(["ps", "-a", "-q", "--filter", `label=${LABEL_RUN}=${runId}`], 30_000);
    const onNet = await run(["ps", "-a", "-q", "--filter", `network=${networkName}`], 30_000);
    if (left.output.trim() !== "" || onNet.output.trim() !== "") problems.push(`containers still present after removal: ${redact(rm.output.trim().slice(-200))}`);
    const nrm = await run(["network", "rm", networkName], 30_000);
    const nets = await run(["network", "ls", "-q", "--filter", `label=${LABEL_RUN}=${runId}`], 30_000);
    if (nets.output.trim() !== "") problems.push(`network still present after removal: ${redact(nrm.output.trim().slice(-200))}`);
    timings.teardownMs = now() - ts;
    return problems.map((p) => redact(p));
  }
}

export function parseAuditLine(line: string): AuditEntry | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(line) as Partial<AuditEntry>;
    return typeof v === "object" && v !== null && typeof v.decision === "string" && typeof v.class === "string" ? (v as AuditEntry) : undefined;
  } catch {
    return undefined;
  }
}

export type { SweepResult };
