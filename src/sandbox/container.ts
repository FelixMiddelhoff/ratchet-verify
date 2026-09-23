import { randomBytes } from "node:crypto";
import { runCommand, type RunOptions, type RunResult } from "./exec.js";

export type ContainerRuntime = "docker" | "podman";

export interface ContainerSettings {
  runtime: ContainerRuntime;
  image: string;
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

/** First working engine: docker, then podman (or only the preferred one). */
export async function detectRuntime(
  preferred: ContainerRuntime | "auto" = "auto",
  exec: Exec = runCommand,
): Promise<{ runtime: ContainerRuntime; rootless: boolean } | undefined> {
  const candidates: ContainerRuntime[] = preferred === "auto" ? ["docker", "podman"] : [preferred];
  for (const runtime of candidates) {
    const format = runtime === "docker" ? "{{.SecurityOptions}}" : "{{.Host.Security.Rootless}}";
    const info = await probe(runtime, ["info", "--format", format], exec);
    if (info.exitCode !== 0) continue; // not installed, or the daemon isn't running
    const rootless = runtime === "docker" ? /rootless/i.test(info.output) : /true/i.test(info.output);
    return { runtime, rootless };
  }
  return undefined;
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
}

/**
 * `docker|podman run` arguments. Filesystem: one bind mount, nothing else from the host.
 * Privileges: all capabilities dropped, no privilege escalation, bounded process count.
 */
export function buildRunArgs(input: RunArgsInput): string[] {
  const { settings, root } = input;
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
): Promise<RunResult> {
  const name = `ratchet-${randomBytes(6).toString("hex")}`;
  const runArgs = buildRunArgs({ settings, root, name, command, args, user: hostUser(settings) });
  const result = await exec({ command: settings.runtime, args: runArgs, cwd: process.cwd(), env: hostEnv(), timeoutMs });
  if (result.timedOut) await probe(settings.runtime, ["kill", name], exec).catch(() => undefined);
  return result;
}
