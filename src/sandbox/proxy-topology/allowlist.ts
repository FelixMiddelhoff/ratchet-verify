import { parseLockfile } from "../../lockfile/index.js";

/**
 * Package names the proxy may serve: every package in the lockfiles under test (old and new state) plus the names the
 * project's manifests declare. Transitive dependencies of a bisected version are not known in advance; the proxy's
 * `discovery: "audit"` mode lets those through and reports them, so the report can list them.
 */
export function allowedPackageNames(lockfileTexts: readonly string[], manifestDependencyNames: readonly string[] = []): string[] {
  const names = new Set<string>(manifestDependencyNames);
  for (const text of lockfileTexts) for (const pkg of parseLockfile(text).values()) names.add(pkg.name);
  return [...names].filter((n) => n !== "").sort();
}
