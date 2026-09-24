import type { DependencyChange, InstalledPackages, RootManifest } from "./types.js";

export function diffLockfiles(
  oldPackages: InstalledPackages,
  newPackages: InstalledPackages,
  manifest: RootManifest = {},
): DependencyChange[] {
  const directNames = collectDirectNames(manifest);
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
      direct: isDirect(path, next.name, directNames, next.aliases),
    });
  }
  for (const [path, previous] of oldPackages) {
    if (newPackages.has(path)) continue;
    changes.push({
      name: previous.name,
      path,
      kind: "removed",
      oldVersion: previous.version,
      direct: isDirect(path, previous.name, directNames, previous.aliases),
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function collectDirectNames(manifest: RootManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

/**
 * A nested copy (a/node_modules/b) is transitive even when the root also depends on `b`.
 * Yarn's flat lockfile has several versions of one name as `node_modules/b@<range>`; any of them
 * counts as direct when the root names `b` (over-flags rather than under-flags).
 */
function isDirect(path: string, name: string, directNames: Set<string>, aliases: string[] = []): boolean {
  if (![name, ...aliases].some((n) => directNames.has(n))) return false;
  return path === `node_modules/${name}` || path.startsWith(`node_modules/${name}@`);
}
