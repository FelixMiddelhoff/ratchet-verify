import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInContainer, type ContainerSettings } from "./container.js";
import { buildSandboxEnv, sandboxPaths } from "./env.js";
import { runCommand, type RunResult } from "./exec.js";

/**
 * "temp-dir" hides credentials via a scrubbed environment and redirected home, but it does
 * not stop an install script from reading absolute paths on the host. "container" runs every
 * install and test inside a container that can only see the sandbox directory.
 */
export type IsolationLevel = "temp-dir" | "container";

/** What ran the installs: reported with every verdict so the strength of the isolation is never implicit. */
export interface IsolationInfo {
  level: IsolationLevel;
  runtime?: string;
  image?: string;
}

export interface Sandbox {
  readonly dir: string;
  readonly isolation: IsolationLevel;
  /** `offline` marks a phase that needs no network (the test run); container mode then drops it. Temp-dir cannot. */
  run(command: string, args: string[], timeoutMs: number, phase?: { offline?: boolean }): Promise<RunResult>;
}

export interface SandboxOptions {
  projectDir: string;
  /** Replaces the project's lockfile: the candidate state to install. */
  lockfile?: { name: string; content: string };
  /** Replaces the project's package.json, so an old lockfile is installed against its matching manifest. */
  packageJson?: string;
  /** Environment to filter; defaults to the real one. Exposed for tests. */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Run installs and tests in a container instead of directly on the host. */
  container?: ContainerSettings;
}

const NOT_COPIED = new Set(["node_modules", ".git"]);

/** Teardown is a `finally`, so the temp dir is removed even when `work` throws. */
export async function withSandbox<T>(options: SandboxOptions, work: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ratchet-sandbox-"));
  try {
    const dir = join(root, "project");
    const paths = sandboxPaths(root);
    await mkdir(paths.home, { recursive: true });
    await mkdir(paths.tmp, { recursive: true });
    await cp(options.projectDir, dir, { recursive: true, filter: (src) => !NOT_COPIED.has(basename(src)) });
    if (options.packageJson !== undefined) await writeFile(join(dir, "package.json"), options.packageJson);
    if (options.lockfile) await writeFile(join(dir, options.lockfile.name), options.lockfile.content);

    return await work(options.container ? containerSandbox(dir, root, options.container) : hostSandbox(dir, paths, options));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hostSandbox(dir: string, paths: ReturnType<typeof sandboxPaths>, options: SandboxOptions): Sandbox {
  const env = buildSandboxEnv(paths, options.sourceEnv);
  return { dir, isolation: "temp-dir", run: (command, args, timeoutMs) => runCommand({ command, args, cwd: dir, env, timeoutMs }) };
}

function containerSandbox(dir: string, root: string, settings: ContainerSettings): Sandbox {
  return { dir, isolation: "container", run: (command, args, timeoutMs, phase) => runInContainer(settings, root, command, args, timeoutMs, undefined, phase) };
}
