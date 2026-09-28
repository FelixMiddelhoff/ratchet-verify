/**
 * Phase 5 (cont.) of #15 + v2 item 5: install the sandbox's lockfile state and run the
 * project's test suite. Mirrors the shape of src/testrun/index.ts (installAndTest,
 * TestOutcome), but Python has no single shared "run the tests" convention like npm's
 * `scripts.test`. v2 adds `detectPythonTestCommand`: a small set of real, unambiguous
 * conventions (pytest config files/sections, a Django `manage.py`) checked before falling
 * back to the v1 default of `["pytest"]` — still an explicit default, not a silent guess,
 * when none of those signals are present.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PythonSandbox } from "./sandbox.js";
import type { RunResult } from "../src/sandbox/exec.js";

export type PythonManager = "uv" | "poetry" | "pip";

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TEST_COMMAND = ["pytest"];

export function detectPythonManager(dir: string): PythonManager | undefined {
  if (existsSync(join(dir, "uv.lock"))) return "uv";
  if (existsSync(join(dir, "poetry.lock"))) return "poetry";
  if (existsSync(join(dir, "requirements.txt"))) return "pip";
  return undefined;
}

const PYTEST_SECTION = /^\[(tool\.pytest\.ini_options|tool:pytest|pytest)\]/m;

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Real, unambiguous conventions only: pytest's own config file/section names it explicitly
 * ships (never a guess about intent), and Django's `manage.py test` (the one command every
 * Django project's own docs point at). Returns undefined when none apply — the caller's own
 * `["pytest"]` default takes over, unchanged.
 */
export function detectPythonTestCommand(dir: string): string[] | undefined {
  if (existsSync(join(dir, "pytest.ini"))) return ["pytest"];
  const pyproject = readIfExists(join(dir, "pyproject.toml"));
  if (pyproject && PYTEST_SECTION.test(pyproject)) return ["pytest"];
  const setupCfg = readIfExists(join(dir, "setup.cfg"));
  if (setupCfg && PYTEST_SECTION.test(setupCfg)) return ["pytest"];
  const toxIni = readIfExists(join(dir, "tox.ini"));
  if (toxIni && PYTEST_SECTION.test(toxIni)) return ["pytest"];
  if (existsSync(join(dir, "manage.py"))) return ["python", "manage.py", "test"];
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
  /** Skips auto-detection (`detectPythonTestCommand`) entirely; otherwise falls back to `["pytest"]`. */
  testCommand?: string[];
}

/** Installs the sandbox's lockfile state (frozen: refuses to silently re-resolve), then runs the test command. */
export async function installAndTestPython(sandbox: PythonSandbox, options: PythonTestRunOptions = {}): Promise<PythonTestOutcome> {
  const manager = detectPythonManager(sandbox.dir);
  if (!manager) return { status: "no-manager" };

  const install = await sandbox.run(...installCommand(manager), options.installTimeoutMs ?? INSTALL_TIMEOUT_MS);
  if (install.exitCode !== 0) return { status: "install-failed", result: install };

  const [cmd, ...args] = runVia(manager, options.testCommand ?? detectPythonTestCommand(sandbox.dir) ?? DEFAULT_TEST_COMMAND);
  const result = await sandbox.run(cmd!, args, options.testTimeoutMs ?? TEST_TIMEOUT_MS);
  if (result.timedOut) return { status: "timed-out", result };
  return { status: result.exitCode === 0 ? "passed" : "failed", result };
}

function installCommand(manager: PythonManager): [string, string[]] {
  // uv sync --frozen / poetry install refuse to proceed when the lockfile is out of sync with pyproject.toml;
  // pip --require-hashes refuses any requirement without a hash. Same "frozen, do not silently
  // re-resolve" guarantee npm ci gives the core pipeline, three different flags for it.
  if (manager === "uv") return ["uv", ["sync", "--frozen"]];
  if (manager === "poetry") return ["poetry", ["install", "--no-interaction"]];
  return ["pip", ["install", "--require-hashes", "-r", "requirements.txt"]];
}

function runVia(manager: PythonManager, command: string[]): string[] {
  // pip installs into whatever `python`/`pytest` etc. already resolve on PATH; no wrapper subcommand exists.
  if (manager === "uv") return ["uv", "run", ...command];
  if (manager === "poetry") return ["poetry", "run", ...command];
  return command;
}
