/**
 * Phase 5 (cont.) of #15: install the sandbox's lockfile state and run the project's test
 * suite. Mirrors the shape of src/testrun/index.ts (installAndTest, TestOutcome), but Python
 * has no single shared "run the tests" convention like npm's `scripts.test`, so the test
 * command is a v1 default (`pytest`) overridable via options — documented limitation, not
 * silently guessed at differently per project.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PythonSandbox } from "./sandbox.js";
import type { RunResult } from "../src/sandbox/exec.js";

export type PythonManager = "uv" | "poetry";

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TEST_COMMAND = ["pytest"];

export function detectPythonManager(dir: string): PythonManager | undefined {
  if (existsSync(join(dir, "uv.lock"))) return "uv";
  if (existsSync(join(dir, "poetry.lock"))) return "poetry";
  return undefined;
}

export type PythonTestOutcome =
  | { status: "passed" | "failed" | "timed-out"; result: RunResult }
  | { status: "install-failed"; result: RunResult }
  /** The suite already fails on the old lockfile, so a failure on the new one proves nothing about the bump. */
  | { status: "baseline-failing"; result: RunResult }
  /** The suite fails, but other dependencies reproduce it on their own; this one was not tested alone. */
  | { status: "blamed-elsewhere"; culprits: string[] }
  | { status: "no-manager" };

export interface PythonTestRunOptions {
  testTimeoutMs?: number;
  installTimeoutMs?: number;
  /** Overrides the v1 default of `["pytest"]`. */
  testCommand?: string[];
}

/** Installs the sandbox's lockfile state (frozen: refuses to silently re-resolve), then runs the test command. */
export async function installAndTestPython(sandbox: PythonSandbox, options: PythonTestRunOptions = {}): Promise<PythonTestOutcome> {
  const manager = detectPythonManager(sandbox.dir);
  if (!manager) return { status: "no-manager" };

  const install = await sandbox.run(...installCommand(manager), options.installTimeoutMs ?? INSTALL_TIMEOUT_MS);
  if (install.exitCode !== 0) return { status: "install-failed", result: install };

  const [cmd, ...args] = runVia(manager, options.testCommand ?? DEFAULT_TEST_COMMAND);
  const result = await sandbox.run(cmd!, args, options.testTimeoutMs ?? TEST_TIMEOUT_MS);
  if (result.timedOut) return { status: "timed-out", result };
  return { status: result.exitCode === 0 ? "passed" : "failed", result };
}

function installCommand(manager: PythonManager): [string, string[]] {
  // uv sync --frozen / poetry install refuse to proceed when the lockfile is out of sync with pyproject.toml,
  // the same "frozen, do not silently re-resolve" guarantee npm ci gives the core pipeline.
  return manager === "uv" ? ["uv", ["sync", "--frozen"]] : ["poetry", ["install", "--no-interaction"]];
}

function runVia(manager: PythonManager, command: string[]): string[] {
  return manager === "uv" ? ["uv", "run", ...command] : ["poetry", "run", ...command];
}
