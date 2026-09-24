import { ROOT_LABEL, workspaceLabel } from "./labels.js";
import type { DependencyChange, InstalledPackage, InstalledPackages, RootManifest, WorkspaceManifest } from "./types.js";

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
      ...attribute(path, next, declarers, workspaces),
    });
  }
  for (const [path, previous] of oldPackages) {
    if (newPackages.has(path)) continue;
    changes.push({
      name: previous.name,
      path,
      kind: "removed",
      oldVersion: previous.version,
      ...attribute(path, previous, declarers, workspaces),
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
  for (const w of workspaces) add(workspaceLabel(w), w.manifest);
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

/** Install path without the `#<version>` tie-breaker pnpm adds when two copies would share a path. */
function pathWithoutTieBreaker(path: string): string {
  return path.replace(/#[^/]*$/, "");
}

function attribute(
  fullPath: string,
  pkg: InstalledPackage,
  declarers: Map<string, string[]>,
  workspaces: WorkspaceManifest[],
): { direct: boolean; declaredIn?: string[] } {
  const path = pathWithoutTieBreaker(fullPath);
  const name = pkg.name;
  const names = [name, ...(pkg.aliases ?? [])];
  let labels = new Set<string>();
  let direct = false;
  // Yarn's flat lockfile has several versions of one name as `node_modules/b@<range>` (pnpm: `@<major>`); any of
  // them counts as direct when a manifest names `b` (over-flags rather than under-flags).
  if (path === `node_modules/${name}` || path.startsWith(`node_modules/${name}@`)) {
    for (const n of names) for (const l of declarers.get(n) ?? []) labels.add(l);
    direct = labels.size > 0;
    labels = narrowToImporters(labels, pkg.importers, workspaces);
  } else {
    const owner = workspaces.find((w) => path.startsWith(`${w.dir}/node_modules/`) && path.slice(w.dir.length + 1) === `node_modules/${name}`);
    if (owner && names.some((n) => manifestNames(owner.manifest).has(n))) {
      labels.add(workspaceLabel(owner));
      direct = true;
    }
  }
  return workspaces.length > 0 && direct ? { direct, declaredIn: [...labels] } : { direct };
}

/**
 * pnpm records which importers resolve a name to which copy: when several importers declare the name on
 * different versions, only the ones on THIS copy are its declarers. Falls back to all declarers if the
 * lockfile's importers cannot be matched to manifests.
 */
function narrowToImporters(labels: Set<string>, importers: string[] | undefined, workspaces: WorkspaceManifest[]): Set<string> {
  if (!importers || importers.length === 0) return labels;
  const wanted = new Set(importers.map((i) => (i === "." ? ROOT_LABEL : workspaces.find((w) => w.dir === i) ? workspaceLabel(workspaces.find((w) => w.dir === i)!) : i)));
  const narrowed = new Set([...labels].filter((l) => wanted.has(l)));
  return narrowed.size > 0 ? narrowed : labels;
}
