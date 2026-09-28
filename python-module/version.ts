/**
 * Minimal PEP 440 version comparison — enough of the spec for the common case (release segments,
 * optional pre/post/dev). Not a full implementation (no local versions `+build`, no implicit
 * zero-padding beyond release segments); good enough to order real PyPI release lists for v1.
 */

const PEP440 = /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?$/i;

interface Parsed {
  epoch: number;
  release: number[];
  pre?: { phase: "a" | "b" | "rc"; n: number };
  post?: number;
  dev?: number;
}

function parse(version: string): Parsed | undefined {
  const match = PEP440.exec(version.trim());
  if (!match) return undefined;
  return {
    epoch: match[1] ? Number(match[1]) : 0,
    release: match[2]!.split(".").map(Number),
    pre: match[3] ? { phase: match[3].toLowerCase() as "a" | "b" | "rc", n: Number(match[4]) } : undefined,
    post: match[5] ? Number(match[5]) : undefined,
    dev: match[6] ? Number(match[6]) : undefined,
  };
}

export function isPep440(version: string): boolean {
  return parse(version) !== undefined;
}

/** A dev or pre-release: users rarely upgrade through these unless the range endpoint itself is one. */
export function isPrerelease(version: string): boolean {
  const p = parse(version);
  return p !== undefined && (p.dev !== undefined || p.pre !== undefined);
}

const PRE_RANK: Record<"a" | "b" | "rc", number> = { a: 0, b: 1, rc: 2 };

/** PEP 440 precedence: dev < {a,b,rc} < release < post. Throws on unparseable input. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) throw new Error(`Not a PEP 440 version: ${left ? b : a}`);
  if (left.epoch !== right.epoch) return left.epoch - right.epoch;
  const len = Math.max(left.release.length, right.release.length);
  for (let i = 0; i < len; i++) {
    const diff = (left.release[i] ?? 0) - (right.release[i] ?? 0);
    if (diff !== 0) return diff;
  }
  const leftStage = stage(left);
  const rightStage = stage(right);
  if (leftStage !== rightStage) return leftStage - rightStage;
  if (left.dev !== undefined && right.dev !== undefined && left.dev !== right.dev) return left.dev - right.dev;
  if (left.pre && right.pre) {
    if (PRE_RANK[left.pre.phase] !== PRE_RANK[right.pre.phase]) return PRE_RANK[left.pre.phase] - PRE_RANK[right.pre.phase];
    if (left.pre.n !== right.pre.n) return left.pre.n - right.pre.n;
  }
  if (left.post !== undefined && right.post !== undefined) return left.post - right.post;
  return 0;
}

/** dev < pre-release < final release < post-release. */
function stage(v: Parsed): number {
  if (v.dev !== undefined) return 0;
  if (v.pre) return 1;
  if (v.post !== undefined) return 3;
  return 2;
}

/**
 * Versions v with oldVersion < v <= newVersion, ascending. Prereleases are skipped unless
 * the range endpoint itself is one (same policy as the npm core's changelog fetcher).
 */
export function versionsInRange(all: string[], oldVersion: string, newVersion: string): string[] {
  const allowPrerelease = isPrerelease(oldVersion) || isPrerelease(newVersion);
  return all
    .filter((v) => isPep440(v) && (allowPrerelease || !isPrerelease(v)))
    .filter((v) => compareVersions(v, oldVersion) > 0 && compareVersions(v, newVersion) <= 0)
    .sort(compareVersions);
}

const LISTED_VERSIONS = 6;

/** "1.2.0, 1.3.0" for a few; "58 versions (25.0.0 to 26.6.2)" when listing them all would bury the message. */
export function describeVersions(versions: string[]): string {
  if (versions.length <= LISTED_VERSIONS) return versions.join(", ");
  return `${versions.length} versions (${versions[0]} to ${versions[versions.length - 1]})`;
}
