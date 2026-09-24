export interface InstalledPackage {
  name: string;
  version: string;
  /** Names the root manifest may use for this package (yarn/npm `alias@npm:real`). */
  aliases?: string[];
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
}

export interface RootManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
