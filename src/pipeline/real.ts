import { fetchChangelog } from "../changelog/index.js";
import type { Config } from "../config.js";
import { withSandbox, type ResolvedIsolation } from "../sandbox/index.js";
import { installAndTest, type TestOutcome } from "../testrun/index.js";
import { scanUsage } from "../usage/index.js";
import type { PipelineDeps } from "./index.js";

const LOCKFILE = "package-lock.json";
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface RealDepsOptions {
  projectDir: string;
  oldLockfile: string;
  oldPackageJson?: string;
  config: Config;
  githubToken?: string;
  /** Resolved isolation; temp-dir when omitted. */
  isolation?: ResolvedIsolation;
}

/** Sandbox-backed implementations of the pipeline's side effects. */
export function realDeps(options: RealDepsOptions): PipelineDeps {
  const { projectDir, config } = options;
  const container = options.isolation?.container;
  return {
    testLockfile: (content, packageJson) =>
      withSandbox({ projectDir, packageJson, container, lockfile: { name: LOCKFILE, content } }, (sandbox) =>
        installAndTest(sandbox, { testTimeoutMs: config.testTimeoutMs }),
      ),

    testDependencyAt: (name, version) =>
      withSandbox({ projectDir, container, packageJson: options.oldPackageJson, lockfile: { name: LOCKFILE, content: options.oldLockfile } }, async (sandbox): Promise<TestOutcome> => {
        // Lock-file-only so npm resolves the dependency's own subtree; scripts stay off until the real install below.
        const pin = await sandbox.run("npm", ["install", `${name}@${version}`, "--package-lock-only", "--ignore-scripts"], INSTALL_TIMEOUT_MS);
        if (pin.exitCode !== 0) return { status: "install-failed", result: pin };
        return installAndTest(sandbox, { testTimeoutMs: config.testTimeoutMs });
      }),

    fetchChangelog: (request) => fetchChangelog({ ...request, githubToken: options.githubToken }),
    scanUsage: (packageName) => scanUsage(projectDir, packageName),
    isolation: options.isolation?.info ?? { level: "temp-dir" },
  };
}
