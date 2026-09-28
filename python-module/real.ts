/**
 * Phase 7 of #15: real (non-faked) PythonPipelineDeps, wiring the sandbox (phase 5) and
 * changelog fetch (phase 3) into the pipeline (this phase). Mirrors src/pipeline/real.ts's
 * role at reduced scope (no workspace pinning).
 */
import { fetchPythonChangelog, type PythonChangelogRequest, type PythonChangelogResult } from "./changelog.js";
import type { PythonPipelineDeps } from "./pipeline.js";
import { withPythonSandbox } from "./sandbox.js";
import { detectPythonManager, installAndTestPython, type PythonManager, type PythonTestOutcome } from "./testrun.js";

export interface RealPythonDepsOptions {
  projectDir: string;
  lockfileName: "uv.lock" | "poetry.lock";
  testCommand?: string[];
  testTimeoutMs?: number;
  installTimeoutMs?: number;
  githubToken?: string;
}

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
  };
}

async function runInSandbox(
  options: RealPythonDepsOptions,
  lockfileText: string | undefined,
  work: (sandbox: { dir: string; run: (cmd: string, args: string[], timeoutMs: number) => Promise<import("../src/sandbox/exec.js").RunResult> }) => Promise<PythonTestOutcome>,
): Promise<PythonTestOutcome> {
  return withPythonSandbox({ projectDir: options.projectDir, lockfile: lockfileText !== undefined ? { name: options.lockfileName, content: lockfileText } : undefined }, work);
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
