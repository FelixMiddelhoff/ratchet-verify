import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildSandboxEnv, sandboxPaths } from "./env.js";
import { runCommand, type RunResult } from "./exec.js";

/**
 * "temp-dir" hides credentials via a scrubbed environment and redirected home, but it does
 * not stop an install script from reading absolute paths on the host. A container/VM mode
 * is the stronger level; callers should surface this level in reports.
 */
export type IsolationLevel = "temp-dir";

export interface Sandbox {
  readonly dir: string;
  readonly isolation: IsolationLevel;
  run(command: string, args: string[], timeoutMs: number): Promise<RunResult>;
}

export interface SandboxOptions {
  projectDir: string;
  /** Replaces the project's lockfile: the candidate state to install. */
  lockfile?: { name: string; content: string };
  /** Environment to filter; defaults to the real one. Exposed for tests. */
  sourceEnv?: NodeJS.ProcessEnv;
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
    if (options.lockfile) await writeFile(join(dir, options.lockfile.name), options.lockfile.content);

    const env = buildSandboxEnv(paths, options.sourceEnv);
    return await work({
      dir,
      isolation: "temp-dir",
      run: (command, args, timeoutMs) => runCommand({ command, args, cwd: dir, env, timeoutMs }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
