import { parseLockfile } from "../../lockfile/index.js";

/**
 * Package names the proxy may serve: every package already in the BASE lockfile/manifest (the reviewed, merged state —
 * not the PR's own working tree) plus the exact packages under test (the changed dependencies ratchet is bisecting).
 *
 * This is not a boundary against whoever authored the PR: they can already introduce any package name as a "changed
 * dependency", since that is the thing ratchet is asked to verify. It only stops an UNRELATED name — one a hostile
 * version's packument declares but that nothing under test asked for (LOW-1, security-review-0.7.md) — from being
 * fetched with the token. That extra name would previously slip in simply by appearing anywhere in the new lockfile.
 */
export function allowedPackageNames(baseLockfileText: string, baseManifestDependencyNames: readonly string[], candidateNames: readonly string[]): string[] {
  const names = new Set<string>(baseManifestDependencyNames);
  for (const pkg of parseLockfile(baseLockfileText).values()) names.add(pkg.name);
  for (const n of candidateNames) names.add(n);
  return [...names].filter((n) => n !== "").sort();
}
