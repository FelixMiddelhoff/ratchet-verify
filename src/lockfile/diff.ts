import type { DependencyChange, InstalledPackages, RootManifest, WorkspaceManifest } from "./types.js";

const ROOT_LABEL = "(root)";

/**
 * A dependency is direct when ANY manifest (root or workspace) names it: the root lockfile is shared, so a
 * bump reaches every workspace that declares the package. A nested copy stays transitive, except a copy
 * under `<workspace dir>/node_modules/<name>` (npm) when that workspace itself names the package.
 */
export function diffLockfiles(
  oldPackages: InstalledPackages,
  newPackages: InstalledPackages,
  manifest: RootManifest = {},
  workspaces: WorkspaceManifest[] = [],
): DependencyChange[] {
  const declarers = collectDeclarers(manifest, workspaces);
  const changes: DependencyChange[] = [];

  for (const [path, next] of newPackages) {
    const previous = oldPackages.get(path);
    if (previous?.version === next.version) continue;
    changes.push({
      name: next.name,
      path,
      kind: previous ? "changed" : "added",
      oldVersion: previous?.version,
      newVersion: next.version,
      ...attribute(path, next.name, declarers, workspaces, next.aliases),
    });
  }
  for (const [path, previous] of oldPackages) {
    if (newPackages.has(path)) continue;
    changes.push({
      name: previous.name,
      path,
      kind: "removed",
      oldVersion: previous.version,
      ...attribute(path, previous.name, declarers, workspaces, previous.aliases),
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** dependency name -> labels of the manifests naming it. */
function collectDeclarers(root: RootManifest, workspaces: WorkspaceManifest[]): Map<string, string[]> {
  const declarers = new Map<string, string[]>();
  const add = (label: string, m: RootManifest): void => {
    for (const name of manifestNames(m)) declarers.set(name, [...(declarers.get(name) ?? []), label]);
  };
  add(ROOT_LABEL, root);
  for (const w of workspaces) add(w.name, w.manifest);
  return declarers;
}

function manifestNames(m: RootManifest): Set<string> {
  return new Set([
    ...Object.keys(m.dependencies ?? {}),
    ...Object.keys(m.devDependencies ?? {}),
    ...Object.keys(m.optionalDependencies ?? {}),
    ...Object.keys(m.peerDependencies ?? {}),
  ]);
}

function attribute(
  path: string,
  name: string,
  declarers: Map<string, string[]>,
  workspaces: WorkspaceManifest[],
  aliases: string[] = [],
): { direct: boolean; declaredIn?: string[] } {
  const names = [name, ...aliases];
  const labels = new Set<string>();
  let direct = false;
  // Yarn's flat lockfile has several versions of one name as `node_modules/b@<range>`; any of them counts as
  // direct when a manifest names `b` (over-flags rather than under-flags).
  if (path === `node_modules/${name}` || path.startsWith(`node_modules/${name}@`)) {
    for (const n of names) for (const l of declarers.get(n) ?? []) labels.add(l);
    direct = labels.size > 0;
  } else {
    const owner = workspaces.find((w) => path.startsWith(`${w.dir}/node_modules/`) && path.slice(w.dir.length + 1) === `node_modules/${name}`);
    if (owner && names.some((n) => manifestNames(owner.manifest).has(n))) {
      labels.add(owner.name);
      direct = true;
    }
  }
  return workspaces.length > 0 && direct ? { direct, declaredIn: [...labels] } : { direct };
}
