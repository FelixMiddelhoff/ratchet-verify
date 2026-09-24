import { detectYarnFlavor } from "../lockfile/yarn.js";

export type PackageManager = "npm" | "yarn" | "pnpm";

/**
 * What ratchet needs from a package manager. Adding one (pnpm, #3) means one more entry in
 * MANAGERS; the pipeline, sandbox and test runner only talk to this interface.
 */
export interface ManagerSpec {
  name: PackageManager;
  lockfile: string;
  /** Whether ratchet can diff this lockfile (parse.ts) and probe with it. */
  supported: boolean;
  /** Install exactly what the lockfile says; fails if lockfile and package.json disagree. */
  frozenInstall(lockfileText: string): string[];
  /**
   * Args that move ONE dependency to `version` in the lockfile already in the sandbox, leaving the rest
   * pinned, without running install scripts. `undefined` = this manager has no way to do that, and the
   * caller must report "not tested on its own" instead of guessing.
   */
  pinDependency(name: string, version: string, lockfileText: string): string[] | undefined;
}

export const MANAGERS: ManagerSpec[] = [
  {
    name: "pnpm",
    lockfile: "pnpm-lock.yaml",
    supported: false,
    frozenInstall: () => ["install", "--frozen-lockfile"],
    pinDependency: () => undefined,
  },
  {
    name: "yarn",
    lockfile: "yarn.lock",
    supported: true,
    frozenInstall: (text) => (detectYarnFlavor(text) === "berry" ? ["install", "--immutable"] : ["install", "--frozen-lockfile"]),
    // `yarn add` re-resolves only the named package (its own subtree) and keeps other locked entries.
    pinDependency: (name, version, text) =>
      detectYarnFlavor(text) === "berry" ? ["add", `${name}@${version}`, "--mode=skip-build"] : ["add", `${name}@${version}`, "--ignore-scripts"],
  },
  {
    name: "npm",
    lockfile: "package-lock.json",
    supported: true,
    frozenInstall: () => ["ci"],
    // Lock-file-only so npm resolves the dependency's own subtree; scripts stay off until the real install.
    pinDependency: (name, version) => ["install", `${name}@${version}`, "--package-lock-only", "--ignore-scripts"],
  },
];

export function managerByName(name: PackageManager): ManagerSpec {
  return MANAGERS.find((m) => m.name === name)!;
}
