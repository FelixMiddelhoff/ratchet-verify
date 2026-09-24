import type { InstalledPackages } from "./types.js";
import { isPnpmLock, parsePnpmLock } from "./pnpm.js";
import { parseYarnLock } from "./yarn.js";

const NODE_MODULES = "node_modules/";

interface LockfileV1Entry {
  version?: string;
  dependencies?: Record<string, LockfileV1Entry>;
}

interface RawLockfile {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string; link?: boolean }>;
  dependencies?: Record<string, LockfileV1Entry>;
}

export function parseLockfile(text: string): InstalledPackages {
  // pnpm (YAML with `lockfileVersion:`) and yarn lockfiles are not JSON; npm's always start with an object.
  if (!text.trimStart().startsWith("{")) return isPnpmLock(text) ? parsePnpmLock(text) : parseYarnLock(text);
  const lock = JSON.parse(text) as RawLockfile;
  // v2 carries both trees; the flat `packages` map is authoritative when present.
  if (lock.packages) return fromPackagesMap(lock.packages);
  if (lock.dependencies) return fromNestedTree(lock.dependencies);
  throw new Error("Unsupported lockfile: neither `packages` nor `dependencies` found");
}

/** Last `node_modules/` segment of an install path is the package name (scoped names included). */
export function packageNameFromPath(path: string): string | undefined {
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return undefined;
  return path.slice(at + NODE_MODULES.length);
}

function fromPackagesMap(packages: NonNullable<RawLockfile["packages"]>): InstalledPackages {
  const result: InstalledPackages = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    const name = packageNameFromPath(path);
    // Skips the root entry and workspace sources; links carry no version of their own.
    if (name === undefined || entry.version === undefined || entry.link) continue;
    result.set(path, { name, version: entry.version });
  }
  return result;
}

function fromNestedTree(
  tree: Record<string, LockfileV1Entry>,
  prefix = "",
  result: InstalledPackages = new Map(),
): InstalledPackages {
  for (const [name, entry] of Object.entries(tree)) {
    const path = `${prefix}${NODE_MODULES}${name}`;
    if (entry.version !== undefined) result.set(path, { name, version: entry.version });
    if (entry.dependencies) fromNestedTree(entry.dependencies, `${path}/`, result);
  }
  return result;
}
