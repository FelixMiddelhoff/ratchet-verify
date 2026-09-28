/**
 * Phase 2 of #15: parse and diff `uv.lock` / `poetry.lock`. Both are TOML files built from a
 * flat list of `[[package]]` tables, each carrying at least `name` and `version` — this is the
 * only shape both formats share and the only one v1 needs, so parsing stays a narrow scan for
 * those two keys rather than a general TOML parser (same style as src/lockfile/yarn.ts, which
 * hand-parses YAML-shaped text instead of pulling in a YAML library).
 */

export interface PythonPackage {
  name: string;
  version: string;
}

/** Installed packages keyed by normalized name (PEP 503: case-insensitive, `-`/`_`/`.` equivalent). */
export type PythonPackages = Map<string, PythonPackage>;

export type PythonChangeKind = "added" | "removed" | "changed";

export interface PythonDependencyChange {
  name: string;
  kind: PythonChangeKind;
  oldVersion?: string;
  newVersion?: string;
}

/** PEP 503 normalization: `Foo_Bar.Baz` and `foo-bar-baz` name the same project. */
export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function parsePythonLock(text: string): PythonPackages {
  const result: PythonPackages = new Map();
  let inPackageTable = false;
  let name: string | undefined;
  let version: string | undefined;

  const flush = (): void => {
    if (name !== undefined && version !== undefined) result.set(normalizePackageName(name), { name, version });
    name = undefined;
    version = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[[")) {
      if (inPackageTable) flush();
      inPackageTable = line === "[[package]]";
      continue;
    }
    if (line.startsWith("[")) {
      // Any other table (e.g. a package's own `[package.source]`) ends the fields we care about for it.
      if (inPackageTable) flush();
      inPackageTable = false;
      continue;
    }
    if (!inPackageTable) continue;
    const match = /^(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (!match) continue;
    if (match[1] === "name") name = match[2];
    else version = match[2];
  }
  if (inPackageTable) flush();
  return result;
}

export function diffPythonLockfiles(oldPackages: PythonPackages, newPackages: PythonPackages): PythonDependencyChange[] {
  const changes: PythonDependencyChange[] = [];
  for (const [key, next] of newPackages) {
    const previous = oldPackages.get(key);
    if (previous?.version === next.version) continue;
    changes.push({ name: next.name, kind: previous ? "changed" : "added", oldVersion: previous?.version, newVersion: next.version });
  }
  for (const [key, previous] of oldPackages) {
    if (newPackages.has(key)) continue;
    changes.push({ name: previous.name, kind: "removed", oldVersion: previous.version });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}
