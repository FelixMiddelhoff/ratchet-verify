import { hostname } from "node:os";
import type { Engine } from "./engine.js";

export const LABEL_RUN = "ratchet.run";
export const LABEL_OWNER = "ratchet.owner";
export const LABEL_STARTED = "ratchet.started";
/** Resources older than this are swept even when their owner pid looks alive (pid reuse, hung runs). */
export const MAX_AGE_SECONDS = 12 * 60 * 60;

export interface RunLabels {
  run: string;
  owner: string;
  started: number;
}

const safeHost = (h: string): string => h.replace(/[^A-Za-z0-9._-]/g, "_") || "host";

export function makeLabels(run: string, pid = process.pid, host = hostname(), nowMs = Date.now()): RunLabels {
  return { run, owner: `${safeHost(host)}:${pid}`, started: Math.floor(nowMs / 1000) };
}

/** `--label` arguments for network/container creation. */
export function labelArgs(labels: RunLabels): string[] {
  return ["--label", `${LABEL_RUN}=${labels.run}`, "--label", `${LABEL_OWNER}=${labels.owner}`, "--label", `${LABEL_STARTED}=${labels.started}`];
}

export interface SweepContext {
  host: string;
  nowSeconds: number;
  isPidAlive: (pid: number) => boolean;
  maxAgeSeconds?: number;
}

export type SweepDecision = { sweep: true; reason: "dead-owner" | "too-old" } | { sweep: false; reason: "live-owner" | "other-host" | "young" | "unreadable" };

/**
 * The decision table (never touches a concurrent live run):
 *  - too old (> 12 h)                          -> sweep
 *  - same host, owner pid dead                 -> sweep
 *  - same host, owner pid alive                -> keep
 *  - other host, younger than 12 h             -> keep (its pid means nothing here)
 *  - labels unreadable                         -> keep (cannot prove it is stale)
 */
export function decideSweep(owner: string | undefined, started: number | undefined, ctx: SweepContext): SweepDecision {
  const maxAge = ctx.maxAgeSeconds ?? MAX_AGE_SECONDS;
  if (started !== undefined && Number.isFinite(started) && ctx.nowSeconds - started > maxAge) return { sweep: true, reason: "too-old" };
  const colon = owner?.lastIndexOf(":") ?? -1;
  if (owner === undefined || colon < 1) return { sweep: false, reason: "unreadable" };
  const host = owner.slice(0, colon);
  const pid = Number(owner.slice(colon + 1));
  if (!Number.isInteger(pid) || pid <= 0) return { sweep: false, reason: "unreadable" };
  if (host !== safeHost(ctx.host)) return { sweep: false, reason: "other-host" };
  return ctx.isPidAlive(pid) ? { sweep: false, reason: "live-owner" } : { sweep: true, reason: "dead-owner" };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Found {
  kind: "container" | "network";
  name: string;
  run: string;
  owner: string | undefined;
  started: number | undefined;
}

const field = (v: string | undefined): string | undefined => (v === undefined || v === "" || v === "<no value>" ? undefined : v);

export function parseInventory(kind: Found["kind"], output: string): Found[] {
  const found: Found[] = [];
  for (const line of output.split("\n")) {
    const [name, run, owner, started] = line.trim().split("|");
    if (!name || !field(run)) continue;
    const s = Number(field(started));
    found.push({ kind, name: name.replace(/^\//, ""), run: run as string, owner: field(owner), started: Number.isFinite(s) && field(started) !== undefined ? s : undefined });
  }
  return found;
}

const CONTAINER_FORMAT = `{{.Name}}|{{index .Config.Labels "${LABEL_RUN}"}}|{{index .Config.Labels "${LABEL_OWNER}"}}|{{index .Config.Labels "${LABEL_STARTED}"}}`;
const NETWORK_FORMAT = `{{.Name}}|{{index .Labels "${LABEL_RUN}"}}|{{index .Labels "${LABEL_OWNER}"}}|{{index .Labels "${LABEL_STARTED}"}}`;

export interface SweepResult {
  removedContainers: string[];
  removedNetworks: string[];
  kept: Array<{ run: string; reason: string }>;
  problems: string[];
}

export const rmArgs = (engine: Engine, names: readonly string[]): string[] =>
  engine.runtime === "podman" ? ["rm", "-f", "-t", "0", ...names] : ["rm", "-f", ...names];

async function ids(engine: Engine, args: string[]): Promise<string[]> {
  const r = await engine.run(args);
  return r.exitCode === 0 ? r.output.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/**
 * Removes stale ratchet resources: containers before networks. `ps -a` also finds containers that were left attached
 * to a stale network without labels (a sandbox container). Never throws; problems are reported.
 */
export async function sweepStale(engine: Engine, ctx: Partial<SweepContext> = {}): Promise<SweepResult> {
  const context: SweepContext = { host: ctx.host ?? hostname(), nowSeconds: ctx.nowSeconds ?? Math.floor(Date.now() / 1000), isPidAlive: ctx.isPidAlive ?? isPidAlive, maxAgeSeconds: ctx.maxAgeSeconds };
  const result: SweepResult = { removedContainers: [], removedNetworks: [], kept: [], problems: [] };

  const cIds = await ids(engine, ["ps", "-a", "-q", "--filter", `label=${LABEL_RUN}`]);
  const nIds = await ids(engine, ["network", "ls", "-q", "--filter", `label=${LABEL_RUN}`]);
  const items: Found[] = [];
  if (cIds.length > 0) {
    const r = await engine.run(["inspect", "--type", "container", "--format", CONTAINER_FORMAT, ...cIds]);
    if (r.exitCode === 0) items.push(...parseInventory("container", r.output));
    else result.problems.push(`container inspect failed: ${r.output.trim().slice(0, 200)}`);
  }
  if (nIds.length > 0) {
    const r = await engine.run(["network", "inspect", "--format", NETWORK_FORMAT, ...nIds]);
    if (r.exitCode === 0) items.push(...parseInventory("network", r.output));
    else result.problems.push(`network inspect failed: ${r.output.trim().slice(0, 200)}`);
  }

  const runs = new Map<string, Found[]>();
  for (const it of items) runs.set(it.run, [...(runs.get(it.run) ?? []), it]);
  const stale = new Set<string>();
  for (const [run, group] of runs) {
    const decisions = group.map((g) => decideSweep(g.owner, g.started, context));
    const verdict = decisions.find((d) => d.sweep) ?? decisions[0]!;
    if (verdict.sweep) stale.add(run);
    else result.kept.push({ run, reason: verdict.reason });
  }

  const staleContainers = items.filter((i) => i.kind === "container" && stale.has(i.run)).map((i) => i.name);
  const staleNetworks = items.filter((i) => i.kind === "network" && stale.has(i.run)).map((i) => i.name);
  const attached = new Set(staleContainers);
  for (const net of staleNetworks) for (const c of await ids(engine, ["ps", "-a", "--format", "{{.Names}}", "--filter", `network=${net}`])) attached.add(c);

  if (attached.size > 0) {
    const r = await engine.run(rmArgs(engine, [...attached]));
    if (r.exitCode === 0) result.removedContainers.push(...attached);
    else result.problems.push(`container removal failed: ${r.output.trim().slice(0, 200)}`);
  }
  for (const net of staleNetworks) {
    const r = await engine.run(["network", "rm", net]);
    if (r.exitCode === 0) result.removedNetworks.push(net);
    else result.problems.push(`network removal failed (${net}): ${r.output.trim().slice(0, 200)}`);
  }
  return result;
}
