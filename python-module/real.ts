/**
 * Phase 7 of #15 + v2 item 1: real (non-faked) PythonPipelineDeps, wiring the sandbox
 * (phase 5), changelog fetch (phase 3) and usage scan (phase 4) into the pipeline. Mirrors
 * src/pipeline/real.ts's role at reduced scope (no workspace pinning).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fetchPythonChangelog, type PythonChangelogRequest, type PythonChangelogResult } from "./changelog.js";
import type { PythonPipelineDeps } from "./pipeline.js";
import type { PythonContainerSettings } from "./container.js";
import { withPythonSandbox, type PythonSandbox } from "./sandbox.js";
import { detectPythonManager, installAndTestPython, type PythonManager, type PythonTestOutcome } from "./testrun.js";
import { scanPythonUsage, type PythonUsageScan } from "./usage.js";

export interface RealPythonDepsOptions {
  projectDir: string;
  lockfileName: "uv.lock" | "poetry.lock";
  testCommand?: string[];
  testTimeoutMs?: number;
  installTimeoutMs?: number;
  githubToken?: string;
  pythonPath?: string;
  /** Run installs and tests in a container instead of directly on the host. */
  container?: PythonContainerSettings;
}

const NOT_SCANNED = new Set([".git", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", "node_modules"]);

export function realPythonDeps(options: RealPythonDepsOptions): PythonPipelineDeps {
  return {
    testLockfile: (lockfileText) => runInSandbox(options, lockfileText, (sandbox) => installAndTestPython(sandbox, options)),
    testDependencyAt: (name, version) =>
      runInSandbox(options, undefined, async (sandbox) => {
        const manager = detectPythonManager(sandbox.dir);
        if (!manager) return { status: "no-manager" };
        const install = await sandbox.run(...installArgs(manager), options.installTimeoutMs ?? 600_000);
        if (install.exitCode !== 0) return { status: "install-failed", result: install };
        const pin = await sandbox.run(...pinArgs(manager, name, version), options.installTimeoutMs ?? 600_000);
        if (pin.exitCode !== 0) return { status: "install-failed", result: pin };
        const [cmd, ...args] = runVia(manager, options.testCommand ?? ["pytest"]);
        const result = await sandbox.run(cmd!, args, options.testTimeoutMs ?? 600_000);
        if (result.timedOut) return { status: "timed-out", result };
        return { status: result.exitCode === 0 ? "passed" : "failed", result };
      }),
    fetchChangelog: (request: PythonChangelogRequest): Promise<PythonChangelogResult> => fetchPythonChangelog({ ...request, githubToken: options.githubToken }),
    scanUsage: async (packageName: string): Promise<PythonUsageScan> => {
      const files = await readPythonFiles(options.projectDir);
      return scanPythonUsage(packageName, files, { pythonPath: options.pythonPath });
    },
  };
}

async function readPythonFiles(root: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_SCANNED.has(entry.name)) await walk(full);
      } else if (entry.name.endsWith(".py")) {
        files.push({ path: relative(root, full).replaceAll("\\", "/"), text: await readFile(full, "utf8") });
      }
    }
  };
  await walk(root);
  return files;
}

async function runInSandbox(
  options: RealPythonDepsOptions,
  lockfileText: string | undefined,
  work: (sandbox: PythonSandbox) => Promise<PythonTestOutcome>,
): Promise<PythonTestOutcome> {
  return withPythonSandbox(
    { projectDir: options.projectDir, lockfile: lockfileText !== undefined ? { name: options.lockfileName, content: lockfileText } : undefined, container: options.container },
    work,
  );
}

function installArgs(manager: PythonManager): [string, string[]] {
  return manager === "uv" ? ["uv", ["sync", "--frozen"]] : ["poetry", ["install", "--no-interaction"]];
}

/** Pins one package to an exact version on top of the frozen install, for a single-dependency probe. */
function pinArgs(manager: PythonManager, name: string, version: string): [string, string[]] {
  return manager === "uv" ? ["uv", ["pip", "install", `${name}==${version}`]] : ["poetry", ["run", "pip", "install", `${name}==${version}`]];
}

function runVia(manager: PythonManager, command: string[]): string[] {
  return manager === "uv" ? ["uv", "run", ...command] : ["poetry", "run", ...command];
}
