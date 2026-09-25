import { hostname } from "node:os";
import type { Engine } from "./engine.js";

export const LABEL_RUN = "ratchet.run";
export const LABEL_OWNER = "ratchet.owner";
export const LABEL_STARTED = "ratchet.started";
/** Resources older than this are swept even when their owner pid looks alive (pid reuse, hung runs). */
export const MAX_AGE_SECONDS = 12 * 60 * 60;
/** Resources younger than this are never swept: a run that just started (or a pid namespace we cannot see into) is not provably dead. */
export const MIN_AGE_SECONDS = 10 * 60;

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
 *  - younger than 10 min                       -> keep
 *  - same host, owner pid dead                 -> sweep
 *  - same host, owner pid alive                -> keep
 *  - other host, younger than 12 h             -> keep (its pid means nothing here)
 *  - labels unreadable                         -> keep (cannot prove it is stale)
 */
export function decideSweep(owner: string | undefined, started: number | undefined, ctx: SweepContext): SweepDecision {
  const maxAge = ctx.maxAgeSeconds ?? MAX_AGE_SECONDS;
  if (started !== undefined && Number.isFinite(started) && ctx.nowSeconds - started > maxAge) return { sweep: true, reason: "too-old" };
  if (started !== undefined && Number.isFinite(started) && ctx.nowSeconds - started < MIN_AGE_SECONDS) return { sweep: false, reason: "young" };
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

const RUN_RE = /^[0-9a-f-]{16,64}$/;
const OWNER_RE = /^[A-Za-z0-9._-]{1,255}:[0-9]{1,10}$/;
const STARTED_RE = /^[0-9]{1,12}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * Parses `inspect` / `network inspect` JSON (both engines print an array). JSON, not a text template: a label value
 * with a newline or a separator cannot forge a second record. Every field is validated; a record whose run label is
 * malformed is skipped and reported, one whose owner or start time is malformed is kept as "unreadable" (never swept).
 */
export function parseInventory(kind: Found["kind"], output: string, problems: string[] = []): Found[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    problems.push(`${kind} inspect output is not JSON`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    problems.push(`${kind} inspect output is not a list`);
    return [];
  }
  const found: Found[] = [];
  for (const entry of parsed) {
    const rec = asRecord(entry);
    const rawName = rec?.Name ?? rec?.name;
    const name = typeof rawName === "string" ? rawName.replace(/^[/]/, "") : undefined;
    const labels = asRecord(kind === "container" ? asRecord(rec?.Config)?.Labels : (rec?.Labels ?? rec?.labels));
    if (!name || !NAME_RE.test(name)) {
      problems.push(`skipped a ${kind} record with a malformed name`);
      continue;
    }
    const run = labels?.[LABEL_RUN];
    if (typeof run !== "string" || !RUN_RE.test(run)) {
      if (run !== undefined) problems.push(`skipped ${kind} ${name}: malformed ${LABEL_RUN} label`);
      continue;
    }
    const owner = labels?.[LABEL_OWNER];
    const started = labels?.[LABEL_STARTED];
    found.push({
      kind,
      name,
      run,
      owner: typeof owner === "string" && OWNER_RE.test(owner) ? owner : undefined,
      started: typeof started === "string" && STARTED_RE.test(started) ? Number(started) : undefined,
    });
  }
  return found;
}

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
    const r = await engine.run(["inspect", "--type", "container", ...cIds]);
    if (r.exitCode === 0) items.push(...parseInventory("container", r.output, result.problems));
    else result.problems.push(`container inspect failed: ${r.output.trim().slice(0, 200)}`);
  }
  if (nIds.length > 0) {
    const r = await engine.run(["network", "inspect", ...nIds]);
    if (r.exitCode === 0) items.push(...parseInventory("network", r.output, result.problems));
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
