export interface InstalledPackage {
  name: string;
  version: string;
  /** Names the root manifest may use for this package (yarn/npm `alias@npm:real`). */
  aliases?: string[];
  /** pnpm: importer directories (`.` = root) whose manifest resolves the name to this exact copy. */
  importers?: string[];
}

/** Installed packages keyed by install path, e.g. "node_modules/a/node_modules/b". */
export type InstalledPackages = Map<string, InstalledPackage>;

export type ChangeKind = "added" | "removed" | "changed";

export interface DependencyChange {
  name: string;
  path: string;
  kind: ChangeKind;
  oldVersion?: string;
  newVersion?: string;
  direct: boolean;
  /** Workspaces (package names, `(root)` for the root manifest) whose manifest names this dependency; set only for workspace projects. */
  declaredIn?: string[];
}

export interface RootManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** One workspace package's manifest, for per-workspace direct/transitive attribution. */
export interface WorkspaceManifest {
  /** Package name from its package.json (directory when unnamed). */
  name: string;
  /** The package.json has no `name`: `name` is the directory, which no manager accepts as a package selector. */
  unnamed?: boolean;
  /** Project-relative directory, forward slashes. */
  dir: string;
  manifest: RootManifest;
}
