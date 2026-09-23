const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  core: [number, number, number];
  prerelease: string[];
}

function parse(version: string): Parsed | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function isSemver(version: string): boolean {
  return parse(version) !== undefined;
}

export function isPrerelease(version: string): boolean {
  return (parse(version)?.prerelease.length ?? 0) > 0;
}

/** Semver precedence: negative when a < b. Throws on non-semver input. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) throw new Error(`Not a semver version: ${left ? b : a}`);
  for (let i = 0; i < 3; i++) {
    const diff = left.core[i]! - right.core[i]!;
    if (diff !== 0) return diff;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version without a prerelease tag outranks one with it.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = compareIdentifier(a[i]!, b[i]!);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function compareIdentifier(a: string, b: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Versions v with oldVersion < v <= newVersion, ascending. Prereleases are skipped unless
 * the range endpoint itself is a prerelease, since users rarely upgrade through them.
 */
export function versionsInRange(all: string[], oldVersion: string, newVersion: string): string[] {
  const allowPrerelease = isPrerelease(oldVersion) || isPrerelease(newVersion);
  return all
    .filter((v) => isSemver(v) && (allowPrerelease || !isPrerelease(v)))
    .filter((v) => compareVersions(v, oldVersion) > 0 && compareVersions(v, newVersion) <= 0)
    .sort(compareVersions);
}

const LISTED_VERSIONS = 6;

/** "1.2.0, 1.3.0" for a few; "58 versions (25.0.0 to 26.6.2)" when listing them all would bury the message. */
export function describeVersions(versions: string[]): string {
  if (versions.length <= LISTED_VERSIONS) return versions.join(", ");
  return `${versions.length} versions (${versions[0]} to ${versions[versions.length - 1]})`;
}
