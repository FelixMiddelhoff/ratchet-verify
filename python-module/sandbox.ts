/**
 * Phase 5 of #15 + v2 item 2: isolated environment to install a candidate lockfile state and
 * run tests, without touching the working tree. Reuses the npm core's generic (not
 * npm-specific) pieces directly: `runCommand`/`RunResult` (src/sandbox/exec.ts),
 * `buildSandboxEnv`/`sandboxPaths` (src/sandbox/env.ts — HOME/XDG redirection already
 * isolates pip/poetry/uv config lookup, no python-specific change needed), and
 * `confinedPath` (src/sandbox/confine.ts). Container mode (v2) uses `container.ts`'s
 * Python-flavored run-argument builder, since the npm core's `buildRunArgs` hard-codes
 * npm's own environment with no injection point.
 */
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { confinedPath } from "../src/sandbox/confine.js";
import { buildSandboxEnv, sandboxPaths } from "../src/sandbox/env.js";
import { runCommand, type RunResult } from "../src/sandbox/exec.js";
import { runPythonInContainer, type PythonContainerSettings } from "./container.js";

export type PythonIsolationLevel = "temp-dir" | "container";

export interface PythonSandbox {
  readonly dir: string;
  readonly isolation: PythonIsolationLevel;
  run(command: string, args: string[], timeoutMs: number, phase?: { offline?: boolean }): Promise<RunResult>;
}

export interface PythonSandboxOptions {
  projectDir: string;
  /** Replaces the project's lockfile: the candidate state to install (name: "uv.lock" or "poetry.lock"). */
  lockfile?: { name: string; content: string };
  /** Project-relative files to overwrite (string) or delete (null) after the copy. */
  files?: Record<string, string | null>;
  /** Environment to filter; defaults to the real one. Exposed for tests. */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Run installs and tests in a container instead of directly on the host. */
  container?: PythonContainerSettings;
}

const NOT_COPIED = new Set([".git", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"]);
/** Files ratchet reads, rewrites or replaces inside the copy. `cp` keeps symlinks, and a write through one lands on the host. */
const WRITTEN_NAMES = new Set(["pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt"]);
const MAX_LINK_SCAN_DIRS = 5000;

/** Teardown is a `finally`, so the temp dir is removed even when `work` throws. */
export async function withPythonSandbox<T>(options: PythonSandboxOptions, work: (sandbox: PythonSandbox) => Promise<T>): Promise<T> {
  for (const key of Object.keys(options.files ?? {})) confinedPath(join(tmpdir(), "x"), key); // refuse bad keys before creating anything
  const root = await mkdtemp(join(tmpdir(), "ratchet-python-sandbox-"));
  try {
    const dir = join(root, "project");
    const paths = sandboxPaths(root);
    await mkdir(paths.home, { recursive: true });
    await mkdir(paths.tmp, { recursive: true });
    await cp(options.projectDir, dir, { recursive: true, filter: (src) => !NOT_COPIED.has(basename(src)) });
    await dropSymlinksToWrittenNames(dir);
    for (const [file, content] of Object.entries(options.files ?? {})) await applyFile(dir, file, content);
    if (options.lockfile) await writeFile(join(dir, options.lockfile.name), options.lockfile.content);

    const sandbox = options.container ? containerSandbox(dir, root, options.container) : hostSandbox(dir, paths, options);
    return await work(sandbox);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hostSandbox(dir: string, paths: ReturnType<typeof sandboxPaths>, options: PythonSandboxOptions): PythonSandbox {
  const env = buildSandboxEnv(paths, options.sourceEnv);
  return { dir, isolation: "temp-dir", run: (command, args, timeoutMs) => runCommand({ command, args, cwd: dir, env, timeoutMs }) };
}

function containerSandbox(dir: string, root: string, settings: PythonContainerSettings): PythonSandbox {
  return { dir, isolation: "container", run: (command, args, timeoutMs, phase) => runPythonInContainer(settings, root, command, args, timeoutMs, undefined, phase) };
}

/**
 * A pull request can commit `pyproject.toml -> ~/.bashrc` or similar. Such a link is deleted from the
 * sandbox copy (never followed) before anything is read or written, so a rewrite or a replaced lockfile
 * can only touch the copy. Directories that are links are not entered. Mirrors
 * `dropSymlinksRatchetWrites` in src/sandbox/sandbox.ts, with the Python-specific file set.
 */
async function dropSymlinksToWrittenNames(root: string): Promise<void> {
  let visited = 0;
  const walk = async (dir: string): Promise<void> => {
    if (visited++ >= MAX_LINK_SCAN_DIRS) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (WRITTEN_NAMES.has(entry.name)) await rm(path, { force: true });
      } else if (entry.isDirectory() && !NOT_COPIED.has(entry.name)) await walk(path);
    }
  };
  await walk(root);
}

async function applyFile(dir: string, key: string, content: string | null): Promise<void> {
  const target = confinedPath(dir, key);
  if (content === null) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  if (await isLink(target)) throw new Error(`sandbox file key "${key}" is a link: refusing to write through it`);
  const realDir = await realpath(dirname(target));
  const realRoot = await realpath(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new Error(`sandbox file key "${key}" resolves outside the sandbox through a link: refusing to write it`);
  }
  await writeFile(target, content);
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}
