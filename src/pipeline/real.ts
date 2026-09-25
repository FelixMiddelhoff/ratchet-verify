import { fetchChangelog } from "../changelog/index.js";
import type { Config } from "../config.js";
import type { RegistryProxyInfo } from "../report/index.js";
import { withSandbox, type ResolvedIsolation } from "../sandbox/index.js";
import type { SandboxProxy } from "../sandbox/proxy-client.js";
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
  /** Old state of the workspace package.json files (project-relative path -> text, null = did not exist). */
  oldFiles?: Record<string, string | null>;
  config: Config;
  githubToken?: string;
  /** Resolved isolation; temp-dir when omitted. */
  isolation?: ResolvedIsolation;
  /** Registry proxy of this run (container isolation only): every sandbox joins its network and talks to registries through it. */
  proxy?: SandboxProxy;
  /** Report snapshot of the proxy's activity (see `withRegistryProxy`). */
  registryProxyInfo?: () => RegistryProxyInfo;
}

/** The old workspace manifests belong to the old lockfile only: applying them to the new lockfile's install would test the wrong state. */
export function oldFilesFor(options: Pick<RealDepsOptions, "oldLockfile" | "oldFiles">, lockfileContent: string): Record<string, string | null> | undefined {
  return lockfileContent === options.oldLockfile ? options.oldFiles : undefined;
}

/** Sandbox-backed implementations of the pipeline's side effects. */
export function realDeps(options: RealDepsOptions): PipelineDeps {
  const { projectDir, config } = options;
  const manager = managerByName(options.manager ?? "npm");
  const container = options.isolation?.container;
  const proxy = options.proxy;
  return {
    testLockfile: (content, packageJson) =>
      withSandbox({ projectDir, packageJson, container, proxy, files: oldFilesFor(options, content), lockfile: { name: manager.lockfile, content } }, (sandbox) =>
        installAndTest(sandbox, { testTimeoutMs: config.testTimeoutMs }),
      ),

    testDependencyAt: (name, version, scope) =>
      withSandbox({ projectDir, container, proxy, files: options.oldFiles, packageJson: options.oldPackageJson, lockfile: { name: manager.lockfile, content: options.oldLockfile } }, async (sandbox): Promise<TestOutcome> => {
        const args = manager.pinDependency(name, version, options.oldLockfile, scope);
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
    registryProxy: options.registryProxyInfo,
  };
}
