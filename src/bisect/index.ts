import { compareVersions, versionsInRange } from "../changelog/semver.js";

/** "unknown": the version couldn't be judged (install failed, no test script), so it says nothing either way. */
export type ProbeOutcome = "pass" | "fail" | "unknown";

/** Installs one version in a sandbox and runs the tests; a hang counts as "fail". */
export type Probe = (version: string) => Promise<ProbeOutcome>;

export interface BisectStep {
  version: string;
  outcome: ProbeOutcome;
}

export interface BisectRequest {
  /** Every published version of the package; the range is derived from it. */
  availableVersions: string[];
  /** Known good: tests passed here. */
  oldVersion: string;
  /** Known bad: tests failed here. */
  newVersion: string;
  probe: Probe;
  /** Cap on installs; past it the result is a narrowed range, not an exact version. */
  maxInstalls?: number;
}

export interface BisectResult {
  status: "exact" | "narrowed";
  lastGood: string;
  /** Exact: the first failing version. Narrowed: the earliest version still known to fail. */
  firstBad: string;
  /** Untestable versions between lastGood and firstBad; any of them could be the real culprit. */
  ambiguousWith: string[];
  log: BisectStep[];
  installs: number;
}

const DEFAULT_MAX_INSTALLS = 10;

/**
 * Binary search assuming failures are monotonic (once broken, stays broken). A flaky suite
 * breaks that assumption; the log is kept so a reviewer can see what each version returned.
 */
export async function bisect(request: BisectRequest): Promise<BisectResult> {
  const maxInstalls = request.maxInstalls ?? DEFAULT_MAX_INSTALLS;
  const candidates = candidateVersions(request);
  const log: BisectStep[] = [];
  const skipped: string[] = [];

  // Invariant: candidates[lo] is good (or the old version when lo < 0), candidates[hi] is bad.
  let lo = -1;
  let hi = candidates.length - 1;
  while (hi - lo > 1 && log.length < maxInstalls) {
    const mid = Math.floor((lo + hi) / 2);
    const version = candidates[mid]!;
    const outcome = await request.probe(version);
    log.push({ version, outcome });

    if (outcome === "pass") {
      lo = mid;
    } else if (outcome === "fail") {
      hi = mid;
    } else {
      skipped.push(version);
      candidates.splice(mid, 1);
      hi -= 1; // the removed slot was below hi
    }
  }

  const lastGood = lo < 0 ? request.oldVersion : candidates[lo]!;
  const firstBad = candidates[hi]!;
  return {
    status: hi - lo === 1 ? "exact" : "narrowed",
    lastGood,
    firstBad,
    ambiguousWith: skipped.filter((v) => compareVersions(v, lastGood) > 0 && compareVersions(v, firstBad) < 0).sort(compareVersions),
    log,
    installs: log.length,
  };
}

/** (old, new] in ascending order, always ending with the version known to fail. */
function candidateVersions(request: BisectRequest): string[] {
  const inRange = versionsInRange(request.availableVersions, request.oldVersion, request.newVersion);
  return inRange.includes(request.newVersion) ? inRange : [...inRange, request.newVersion];
}
