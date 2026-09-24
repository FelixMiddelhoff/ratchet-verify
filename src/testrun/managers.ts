import { detectYarnFlavor } from "../lockfile/yarn.js";

export type PackageManager = "npm" | "yarn" | "pnpm";

/**
 * What ratchet needs from a package manager. Adding one means one more entry in
 * MANAGERS; the pipeline, sandbox and test runner only talk to this interface.
 */
/** Where a dependency is declared, so a single-dependency move edits the right manifest of a workspace project. */
export interface PinScope {
  /** The project has workspaces: root-level add commands need the manager's "workspace root" flag. */
  workspaceProject?: boolean;
  /** The one workspace declaring the dependency; unset = the root manifest declares it. */
  workspace?: { name: string; dir: string; /** No `name` in its package.json: `name` is only the directory. */ unnamed?: boolean };
  /** Several manifests declare it: one command cannot move them all consistently, so it is not tested alone. */
  ambiguous?: boolean;
}

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
  pinDependency(name: string, version: string, lockfileText: string, scope?: PinScope): string[] | undefined;
}

export const MANAGERS: ManagerSpec[] = [
  {
    name: "pnpm",
    lockfile: "pnpm-lock.yaml",
    supported: true,
    frozenInstall: () => ["install", "--frozen-lockfile"],
    // Rewrites just the lockfile (no node_modules, no scripts); pnpm re-resolves the named package's subtree
    // and keeps the other locked entries. The real install afterwards runs with --frozen-lockfile.
    // In a workspace project the target manifest is named: `--filter <pkg>` or `-w` (root).
    pinDependency: (name, version, _text, scope) => {
      if (scope?.ambiguous) return undefined;
      // An unnamed workspace is selected by path (`./dir`), which pnpm's --filter accepts.
      const target = scope?.workspace ? ["--filter", scope.workspace.unnamed ? `./${scope.workspace.dir}` : scope.workspace.name] : scope?.workspaceProject ? ["-w"] : [];
      return ["add", `${name}@${version}`, ...target, "--lockfile-only", "--ignore-scripts"];
    },
  },
  {
    name: "yarn",
    lockfile: "yarn.lock",
    supported: true,
    frozenInstall: (text) => (detectYarnFlavor(text) === "berry" ? ["install", "--immutable"] : ["install", "--frozen-lockfile"]),
    // `yarn add` re-resolves only the named package (its own subtree) and keeps other locked entries.
    // Workspace projects: `yarn workspace <pkg> add`; classic needs `-W` to add to the root manifest.
    pinDependency: (name, version, text, scope) => {
      if (scope?.ambiguous) return undefined;
      const berry = detectYarnFlavor(text) === "berry";
      const flags = berry ? ["--mode=skip-build"] : ["--ignore-scripts"];
      // `yarn workspace` takes a package name only: an unnamed workspace cannot be targeted, so it is not tested alone.
      if (scope?.workspace?.unnamed) return undefined;
      if (scope?.workspace) return ["workspace", scope.workspace.name, "add", `${name}@${version}`, ...flags];
      return ["add", `${name}@${version}`, ...(scope?.workspaceProject && !berry ? ["-W"] : []), ...flags];
    },
  },
  {
    name: "npm",
    lockfile: "package-lock.json",
    supported: true,
    frozenInstall: () => ["ci"],
    // Lock-file-only so npm resolves the dependency's own subtree; scripts stay off until the real install.
    pinDependency: (name, version, _text, scope) => {
      if (scope?.ambiguous) return undefined;
      return ["install", `${name}@${version}`, ...(scope?.workspace ? ["-w", scope.workspace.dir] : []), "--package-lock-only", "--ignore-scripts"];
    },
  },
];

export function managerByName(name: PackageManager): ManagerSpec {
  return MANAGERS.find((m) => m.name === name)!;
}
