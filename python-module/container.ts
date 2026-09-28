/**
 * v2 item 2: container isolation for the Python sandbox, stronger than the temp-dir-only mode
 * phase 5 shipped with. Reuses the npm core's engine-detection and generic run-argument pieces
 * directly (src/sandbox/container.ts): `detectEngine`/`detectRuntime` (docker/podman
 * detection, Linux-containers check), `ensureImage` (pull-once), `hostUser`, `MOUNT_POINT`,
 * the `ContainerRuntime`/`ContainerNetwork`/`Exec` types — none of those are npm-specific.
 * `buildRunArgs`/`buildContainerEnv` are NOT reused: they hard-code npm's env vars
 * (npm_config_*) with no injection point, so this file has its own Python-flavored versions
 * (pip/uv/poetry cache and config redirected via HOME/XDG instead).
 */
import { randomBytes } from "node:crypto";
import { detectEngine, detectRuntime, ensureImage, hostUser, MOUNT_POINT, type ContainerNetwork, type ContainerRuntime, type Exec } from "../src/sandbox/container.js";
import { runCommand, type RunResult } from "../src/sandbox/exec.js";

export { detectEngine, detectRuntime, ensureImage, hostUser, MOUNT_POINT };
export type { ContainerNetwork, ContainerRuntime, Exec };

export interface PythonContainerSettings {
  runtime: ContainerRuntime;
  image: string;
  /** "tests-offline" (default): the test phase runs with `--network none`; "open" keeps the network everywhere. */
  network?: ContainerNetwork;
  rootless: boolean;
}

const PROBE_TIMEOUT_MS = 20_000;
const hostEnv = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
const probe = (runtime: ContainerRuntime, args: string[], exec: Exec, timeoutMs = PROBE_TIMEOUT_MS) =>
  exec({ command: runtime, args, cwd: process.cwd(), env: hostEnv(), timeoutMs });

/**
 * Fails early, with the fix, when the image lacks the manager the project's lockfile needs
 * (a stock python:*-slim image ships pip but not uv or poetry).
 */
export async function ensurePythonManagerInImage(settings: PythonContainerSettings, manager: "uv" | "poetry", exec: Exec = runCommand): Promise<void> {
  const found = await probe(settings.runtime, ["run", "--rm", "--entrypoint", "sh", settings.image, "-c", `command -v ${manager}`], exec);
  if (found.exitCode === 0) return;
  throw new Error(
    `container image ${settings.image} does not ship ${manager}, which this project's lockfile needs. ` +
      `Use an image that has it preinstalled, or pass a temp-dir sandbox (withPythonSandbox without \`container\`) to accept weaker isolation.`,
  );
}

/** Environment inside the container: only redirected locations. Nothing is inherited from the host. */
export function buildPythonContainerEnv(): Record<string, string> {
  const home = `${MOUNT_POINT}/.home`;
  const tmp = `${MOUNT_POINT}/.tmp`;
  return {
    HOME: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_STATE_HOME: `${home}/.local/state`,
    PIP_CACHE_DIR: `${home}/.cache/pip`,
    PIP_NO_INPUT: "1",
    UV_CACHE_DIR: `${home}/.cache/uv`,
    POETRY_CACHE_DIR: `${home}/.cache/pypoetry`,
  };
}

export interface PythonRunArgsInput {
  settings: PythonContainerSettings;
  root: string;
  name: string;
  command: string;
  args: string[];
  user?: string;
  offline?: boolean;
  network?: string;
}

const NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RESERVED_NETWORKS = new Set(["host", "bridge", "none", "default", "private", "pasta", "slirp4netns", "container", "ns"]);

/** `docker|podman run` arguments. Filesystem: one bind mount, nothing else from the host. */
export function buildPythonRunArgs(input: PythonRunArgsInput): string[] {
  const { settings, root } = input;
  if (input.network !== undefined && input.offline) throw new Error("buildPythonRunArgs: network and offline are mutually exclusive");
  if (input.network !== undefined && (!NETWORK_NAME_RE.test(input.network) || RESERVED_NETWORKS.has(input.network.toLowerCase()))) {
    throw new Error(`buildPythonRunArgs: refusing network ${JSON.stringify(input.network)}: it must be a plain user-network name, not an option or an engine network mode`);
  }
  if (root.includes(",")) throw new Error(`sandbox path contains a comma, which container mounts cannot express: ${root}`);
  const relabel = settings.runtime === "podman" ? ",relabel=private" : "";
  const env = Object.entries(buildPythonContainerEnv()).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
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

/** Runs `command args` inside a fresh container; a timeout also kills the container, not just the client. */
export async function runPythonInContainer(
  settings: PythonContainerSettings,
  root: string,
  command: string,
  args: string[],
  timeoutMs: number,
  exec: Exec = runCommand,
  phase: { offline?: boolean; network?: string } = {},
): Promise<RunResult> {
  const name = `ratchet-py-${randomBytes(6).toString("hex")}`;
  const offline = phase.offline === true && (settings.network ?? "tests-offline") === "tests-offline";
  const runArgs = buildPythonRunArgs({ settings, root, name, command, args, user: hostUser(settings), offline, network: offline ? undefined : phase.network });
  const result = await exec({ command: settings.runtime, args: runArgs, cwd: process.cwd(), env: hostEnv(), timeoutMs });
  if (result.timedOut) await probe(settings.runtime, ["kill", name], exec).catch(() => undefined);
  return result;
}
