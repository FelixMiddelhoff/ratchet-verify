import { randomBytes } from "node:crypto";
import { packageManagerHomes } from "./env.js";
import { runCommand, type RunOptions, type RunResult } from "./exec.js";

export type ContainerRuntime = "docker" | "podman";
export type ContainerNetwork = "tests-offline" | "open";

export interface ContainerSettings {
  runtime: ContainerRuntime;
  image: string;
  /** "tests-offline" (default): the test phase runs with `--network none`; "open" keeps the network everywhere. */
  network?: ContainerNetwork;
  /** Rootless engines map the container's root to the invoking user, so no `--user` is wanted. */
  rootless: boolean;
}

/** Injectable so the argument building and detection can be tested without a container engine. */
export type Exec = (options: RunOptions) => Promise<RunResult>;

export const DEFAULT_IMAGE = "node:24";
/** Where the sandbox root (project, home, tmp) is mounted; the only host path the container sees. */
export const MOUNT_POINT = "/sandbox";

const PROBE_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;

/** The container engine's own client runs on the host and needs the real environment (PATH, DOCKER_HOST). */
const hostEnv = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

const probe = (runtime: ContainerRuntime, args: string[], exec: Exec, timeoutMs = PROBE_TIMEOUT_MS) =>
  exec({ command: runtime, args, cwd: process.cwd(), env: hostEnv(), timeoutMs });

export interface EngineDetection {
  /** First engine that runs LINUX containers. */
  usable?: { runtime: ContainerRuntime; rootless: boolean };
  /** An engine that answered but is not in Linux-containers mode (e.g. docker on Windows runners). */
  nonLinux?: ContainerRuntime;
}

/**
 * First working engine: docker, then podman (or only the preferred one). Only engines running
 * Linux containers count: the sandbox mounts /sandbox and pulls a Linux image. Docker must report
 * OSType "linux" (missing or other value = rejected, conservatively); podman is always Linux.
 */
export async function detectEngine(preferred: ContainerRuntime | "auto" = "auto", exec: Exec = runCommand): Promise<EngineDetection> {
  const candidates: ContainerRuntime[] = preferred === "auto" ? ["docker", "podman"] : [preferred];
  const result: EngineDetection = {};
  for (const runtime of candidates) {
    const format = runtime === "docker" ? "{{.OSType}}|{{.SecurityOptions}}" : "{{.Host.Security.Rootless}}";
    const info = await probe(runtime, ["info", "--format", format], exec);
    if (info.exitCode !== 0) continue; // not installed, or the daemon isn't running
    if (runtime === "docker") {
      const [osType = "", ...rest] = info.output.trim().split("|");
      if (osType.trim().toLowerCase() !== "linux") {
        result.nonLinux ??= runtime;
        continue;
      }
      result.usable = { runtime, rootless: /rootless/i.test(rest.join("|")) };
    } else {
      result.usable = { runtime, rootless: /true/i.test(info.output) };
    }
    return result;
  }
  return result;
}

export async function detectRuntime(
  preferred: ContainerRuntime | "auto" = "auto",
  exec: Exec = runCommand,
): Promise<{ runtime: ContainerRuntime; rootless: boolean } | undefined> {
  return (await detectEngine(preferred, exec)).usable;
}

/** Pulls the image once, up front, so a slow first download isn't charged to an install timeout. */
export async function ensureImage(settings: ContainerSettings, exec: Exec = runCommand): Promise<void> {
  const present = await probe(settings.runtime, ["image", "inspect", settings.image], exec);
  if (present.exitCode === 0) return;
  const pulled = await probe(settings.runtime, ["pull", settings.image], exec, PULL_TIMEOUT_MS);
  if (pulled.exitCode !== 0) {
    throw new Error(`could not pull container image ${settings.image} with ${settings.runtime}:\n${pulled.output.trim()}`);
  }
}

/**
 * Environment inside the container: only redirected locations and npm switches. Nothing is
 * inherited from the host (the host's PATH, tokens and paths mean nothing there).
 */
export function buildContainerEnv(): Record<string, string> {
  const home = `${MOUNT_POINT}/.home`;
  const tmp = `${MOUNT_POINT}/.tmp`;
  return {
    HOME: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    npm_config_cache: `${home}/.npm`,
    npm_config_userconfig: `${home}/.npmrc`,
    npm_config_globalconfig: `${home}/.npmrc-global`,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    ...packageManagerHomes(home),
  };
}

export interface RunArgsInput {
  settings: ContainerSettings;
  /** Host path of the sandbox root: the single bind mount. */
  root: string;
  name: string;
  command: string;
  args: string[];
  /** Host uid:gid for engines that need `--user` so files stay removable; omitted where not applicable. */
  user?: string;
  /** No network at all inside the container (`--network none`): nothing can be sent or fetched. */
  offline?: boolean;
  /** Attach to this named (internal) network instead of the default one (registry-proxy topology). Exclusive with `offline`. */
  network?: string;
}

const NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Engine network modes that are not a user network: `host` would hand the sandbox the host's stack. */
const RESERVED_NETWORKS = new Set(["host", "bridge", "none", "default", "private", "pasta", "slirp4netns", "container", "ns"]);

/**
 * `docker|podman run` arguments. Filesystem: one bind mount, nothing else from the host.
 * Privileges: all capabilities dropped, no privilege escalation, bounded process count.
 */
export function buildRunArgs(input: RunArgsInput): string[] {
  const { settings, root } = input;
  if (input.network !== undefined && input.offline) throw new Error("buildRunArgs: network and offline are mutually exclusive");
  if (input.network !== undefined && (!NETWORK_NAME_RE.test(input.network) || RESERVED_NETWORKS.has(input.network.toLowerCase()))) {
    throw new Error(`buildRunArgs: refusing network ${JSON.stringify(input.network)}: it must be a plain user-network name, not an option or an engine network mode`);
  }
  if (root.includes(",")) throw new Error(`sandbox path contains a comma, which container mounts cannot express: ${root}`);
  const relabel = settings.runtime === "podman" ? ",relabel=private" : ""; // SELinux hosts need it for bind mounts
  const env = Object.entries(buildContainerEnv()).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return [
    "run", "--rm", "--init",
    "--name", input.name,
    "--mount", `type=bind,source=${root},target=${MOUNT_POINT}${relabel}`,
    "--workdir", `${MOUNT_POINT}/project`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "1024",
    ...(input.offline ? ["--network", "none"] : []),
    ...(input.network !== undefined ? ["--network", input.network] : []),
    ...(input.user ? ["--user", input.user] : []),
    ...env,
    settings.image,
    input.command,
    ...input.args,
  ];
}

/** uid:gid of the current user on POSIX hosts running a rootful engine; undefined elsewhere. */
export function hostUser(settings: ContainerSettings): string | undefined {
  if (settings.rootless || settings.runtime === "podman") return undefined;
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
  return `${process.getuid()}:${process.getgid()}`;
}

/** Runs `command args` inside a fresh container; a timeout also kills the container, not just the client. */
export async function runInContainer(
  settings: ContainerSettings,
  root: string,
  command: string,
  args: string[],
  timeoutMs: number,
  exec: Exec = runCommand,
  phase: { offline?: boolean } = {},
): Promise<RunResult> {
  const name = `ratchet-${randomBytes(6).toString("hex")}`;
  const offline = phase.offline === true && (settings.network ?? "tests-offline") === "tests-offline";
  const runArgs = buildRunArgs({ settings, root, name, command, args, user: hostUser(settings), offline });
  const result = await exec({ command: settings.runtime, args: runArgs, cwd: process.cwd(), env: hostEnv(), timeoutMs });
  if (result.timedOut) await probe(settings.runtime, ["kill", name], exec).catch(() => undefined);
  return result;
}
