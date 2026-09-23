import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult, Sandbox } from "../sandbox/index.js";

export type PackageManager = "npm" | "yarn" | "pnpm";

const LOCKFILES: [file: string, manager: PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const FROZEN_INSTALL: Record<PackageManager, string[]> = {
  npm: ["ci"],
  yarn: ["install", "--frozen-lockfile"],
  pnpm: ["install", "--frozen-lockfile"],
};

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export function detectPackageManager(dir: string): PackageManager | undefined {
  return LOCKFILES.find(([file]) => existsSync(join(dir, file)))?.[1];
}

/** `scripts.test` is the convention shared by all three managers. */
export async function detectTestScript(dir: string): Promise<string | undefined> {
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts?.test;
}

export type TestOutcome =
  | { status: "passed" | "failed" | "timed-out"; result: RunResult }
  | { status: "install-failed"; result: RunResult }
  /** The suite already fails on the old lockfile, so a failure on the new one proves nothing about the bump. */
  | { status: "baseline-failing"; result: RunResult }
  /** The suite fails, but other dependencies reproduce it on their own; this one was not tested alone. */
  | { status: "blamed-elsewhere"; culprits: string[] }
  | { status: "no-test-script" | "no-lockfile" };

export interface TestRunOptions {
  testTimeoutMs?: number;
  installTimeoutMs?: number;
}

/** Installs the sandbox's lockfile state, then runs the project's own test script. */
export async function installAndTest(sandbox: Sandbox, options: TestRunOptions = {}): Promise<TestOutcome> {
  const manager = detectPackageManager(sandbox.dir);
  if (!manager) return { status: "no-lockfile" };
  if ((await detectTestScript(sandbox.dir)) === undefined) return { status: "no-test-script" };

  const install = await sandbox.run(manager, FROZEN_INSTALL[manager], options.installTimeoutMs ?? INSTALL_TIMEOUT_MS);
  if (install.exitCode !== 0) return { status: "install-failed", result: install };

  const result = await sandbox.run(manager, ["test"], options.testTimeoutMs ?? TEST_TIMEOUT_MS);
  if (result.timedOut) return { status: "timed-out", result };
  return { status: result.exitCode === 0 ? "passed" : "failed", result };
}
