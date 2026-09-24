import { fetchChangelog } from "../changelog/index.js";
import type { Config } from "../config.js";
import { withSandbox, type ResolvedIsolation } from "../sandbox/index.js";
import { managerByName, installAndTest, type PackageManager, type TestOutcome } from "../testrun/index.js";
import { scanUsage } from "../usage/index.js";
import type { PipelineDeps } from "./index.js";

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface RealDepsOptions {
  projectDir: string;
  oldLockfile: string;
  /** Which manager owns the lockfile; npm when omitted. */
  manager?: PackageManager;
  oldPackageJson?: string;
  config: Config;
  githubToken?: string;
  /** Resolved isolation; temp-dir when omitted. */
  isolation?: ResolvedIsolation;
}

/** Sandbox-backed implementations of the pipeline's side effects. */
export function realDeps(options: RealDepsOptions): PipelineDeps {
  const { projectDir, config } = options;
  const manager = managerByName(options.manager ?? "npm");
  const container = options.isolation?.container;
  return {
    testLockfile: (content, packageJson) =>
      withSandbox({ projectDir, packageJson, container, lockfile: { name: manager.lockfile, content } }, (sandbox) =>
        installAndTest(sandbox, { testTimeoutMs: config.testTimeoutMs }),
      ),

    testDependencyAt: (name, version) =>
      withSandbox({ projectDir, container, packageJson: options.oldPackageJson, lockfile: { name: manager.lockfile, content: options.oldLockfile } }, async (sandbox): Promise<TestOutcome> => {
        const args = manager.pinDependency(name, version, options.oldLockfile);
        // No safe single-dependency move for this manager: report it instead of guessing a verdict.
        // (install-failed makes the pipeline skip it: never cleared, never blamed on this dependency alone.)
        if (!args) {
          const output = `ratchet: ${manager.name} has no way to move one dependency in isolation; not tested on its own`;
          return { status: "install-failed", result: { exitCode: 1, timedOut: false, output, truncated: false } };
        }
        const pin = await sandbox.run(manager.name, args, INSTALL_TIMEOUT_MS);
        if (pin.exitCode !== 0) return { status: "install-failed", result: pin };
        return installAndTest(sandbox, { testTimeoutMs: config.testTimeoutMs });
      }),

    fetchChangelog: (request) => fetchChangelog({ ...request, githubToken: options.githubToken }),
    scanUsage: (packageName) => scanUsage(projectDir, packageName),
    isolation: options.isolation?.info ?? { level: "temp-dir" },
  };
}
