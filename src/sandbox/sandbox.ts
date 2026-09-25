import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { confinedPath } from "./confine.js";
import { runInContainer, type ContainerSettings } from "./container.js";
import { buildSandboxEnv, sandboxPaths } from "./env.js";
import { runCommand, type RunResult } from "./exec.js";
import { applyProxyClient, type SandboxProxy } from "./proxy-client.js";

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
  /** Project-relative files to overwrite (string) or delete (null) after the copy: the old state of workspace manifests. */
  files?: Record<string, string | null>;
  /** Environment to filter; defaults to the real one. Exposed for tests. */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Run installs and tests in a container instead of directly on the host. */
  container?: ContainerSettings;
  /** Registry proxy topology (container mode only): installs join its internal network and the project's rc files/lockfile URLs point at the proxy. */
  proxy?: SandboxProxy;
}

const NOT_COPIED = new Set(["node_modules", ".git"]);

/** Teardown is a `finally`, so the temp dir is removed even when `work` throws. */
export async function withSandbox<T>(options: SandboxOptions, work: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  for (const key of Object.keys(options.files ?? {})) confinedPath(join(tmpdir(), "x"), key); // refuse bad keys before creating anything
  const root = await mkdtemp(join(tmpdir(), "ratchet-sandbox-"));
  try {
    const dir = join(root, "project");
    const paths = sandboxPaths(root);
    await mkdir(paths.home, { recursive: true });
    await mkdir(paths.tmp, { recursive: true });
    await cp(options.projectDir, dir, { recursive: true, filter: (src) => !NOT_COPIED.has(basename(src)) });
    if (options.packageJson !== undefined) await writeFile(join(dir, "package.json"), options.packageJson);
    for (const [file, content] of Object.entries(options.files ?? {})) await applyFile(dir, file, content);
    if (options.lockfile) await writeFile(join(dir, options.lockfile.name), options.lockfile.content);

    if (options.proxy) {
      if (!options.container) throw new Error("the registry proxy needs container isolation: a temp-dir sandbox cannot be confined to it");
      await applyProxyClient(dir, options.proxy, options.lockfile?.name ?? defaultLockfileName(dir));
    }
    return await work(options.container ? containerSandbox(dir, root, options.container, options.proxy) : hostSandbox(dir, paths, options));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Overwrites (string) or deletes (null) one project-relative file inside the sandbox copy. The key must stay
 * inside the sandbox lexically AND after resolving links: the copy can contain symlinks/junctions to host paths.
 */
async function applyFile(dir: string, key: string, content: string | null): Promise<void> {
  const target = confinedPath(dir, key);
  const realDir = await realpath(dir);
  const inside = (p: string): boolean => {
    const rel = relative(realDir, p);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (content === null) {
    if (await isLink(target)) return void (await rm(target, { force: true })); // removes the link itself only
    const parent = await nearestExisting(dirname(target));
    if (parent && !inside(await realpath(parent))) throw new Error(`sandbox file key "${key}" resolves outside the sandbox through a link: refusing to touch it`);
    await rm(target, { force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  if (!inside(await realpath(dirname(target))) || (await isLink(target))) throw new Error(`sandbox file key "${key}" resolves outside the sandbox through a link: refusing to write it`);
  await writeFile(target, content);
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function nearestExisting(path: string): Promise<string | undefined> {
  for (let p = path; ; p = dirname(p)) {
    try {
      await lstat(p);
      return p;
    } catch {
      if (dirname(p) === p) return undefined;
    }
  }
}

function hostSandbox(dir: string, paths: ReturnType<typeof sandboxPaths>, options: SandboxOptions): Sandbox {
  const env = buildSandboxEnv(paths, options.sourceEnv);
  return { dir, isolation: "temp-dir", run: (command, args, timeoutMs) => runCommand({ command, args, cwd: dir, env, timeoutMs }) };
}

function containerSandbox(dir: string, root: string, settings: ContainerSettings, proxy?: SandboxProxy): Sandbox {
  return { dir, isolation: "container", run: (command, args, timeoutMs, phase) => runInContainer(settings, root, command, args, timeoutMs, undefined, { ...phase, network: proxy?.network }) };
}

const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];
function defaultLockfileName(dir: string): string | undefined {
  return LOCKFILES.find((f) => existsSync(join(dir, f)));
}
