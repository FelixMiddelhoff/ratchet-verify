/**
 * Phase 6 of #15: bisection over PyPI versions. Same binary-search shape and outcome types as
 * src/bisect/index.ts (Probe injection, confirmation re-runs, ambiguousWith, exact/narrowed/
 * unstable status) — duplicated rather than imported because the core's `bisect` hard-codes
 * semver `compareVersions`/`versionsInRange` internally (not injectable), and PyPI versions
 * are PEP 440, not semver. Everything else about the algorithm is identical on purpose.
 */
import { compareVersions, versionsInRange } from "./version.js";

/** "unknown": the version couldn't be judged (install failed), so it says nothing either way. */
export type PythonProbeOutcome = "pass" | "fail" | "unknown";

/** Installs one version in a sandbox and runs the tests; a hang counts as "fail". */
export type PythonProbe = (version: string) => Promise<PythonProbeOutcome>;

export interface PythonBisectStep {
  version: string;
  outcome: PythonProbeOutcome;
  /** True for a boundary re-run rather than a search step. */
  confirmation?: boolean;
}

export interface PythonBisectRequest {
  /** Every version PyPI lists for the package; the range is derived from it. */
  availableVersions: string[];
  /** Known good: tests passed here. */
  oldVersion: string;
  /** Known bad: tests failed here. */
  newVersion: string;
  probe: PythonProbe;
  /** Cap on installs; past it the result is a narrowed range, not an exact version. */
  maxInstalls?: number;
  /**
   * Re-run the reported first-bad and last-good once each to check the boundary reproduces.
   * Default true. These re-runs count against maxInstalls (the search gets what is left).
   */
  confirm?: boolean;
}

/**
 * confirmed: both boundary re-runs agreed. unconfirmed: a re-run was unknown or the budget had no room.
 * flaky: a boundary re-run flipped. disabled: confirm was off.
 */
export type PythonConfirmation = "confirmed" | "unconfirmed" | "flaky" | "disabled";

export interface PythonBisectResult {
  /** "unstable": a boundary flipped on re-run, so no exact culprit can be claimed. */
  status: "exact" | "narrowed" | "unstable";
  confirmation: PythonConfirmation;
  lastGood: string;
  /** Exact: the first failing version. Narrowed: the earliest version still known to fail. */
  firstBad: string;
  /** Untestable versions between lastGood and firstBad; any of them could be the real culprit. */
  ambiguousWith: string[];
  log: PythonBisectStep[];
  installs: number;
}

const DEFAULT_MAX_INSTALLS = 10;
const CONFIRM_RUNS = 2;

/**
 * Binary search assuming failures are monotonic (once broken, stays broken). A flaky suite
 * breaks that assumption; the log is kept so a reviewer can see what each version returned.
 */
export async function bisectPython(request: PythonBisectRequest): Promise<PythonBisectResult> {
  const maxInstalls = request.maxInstalls ?? DEFAULT_MAX_INSTALLS;
  const confirm = request.confirm ?? true;
  // Two confirmation runs are reserved out of the same budget, so total installs never exceed maxInstalls.
  const searchBudget = confirm ? Math.max(0, maxInstalls - CONFIRM_RUNS) : maxInstalls;
  const candidates = candidateVersions(request);
  const log: PythonBisectStep[] = [];
  const skipped: string[] = [];

  // Invariant: candidates[lo] is good (or the old version when lo < 0), candidates[hi] is bad.
  let lo = -1;
  let hi = candidates.length - 1;
  while (hi - lo > 1 && log.length < searchBudget) {
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
  let confirmation: PythonConfirmation = "disabled";
  if (confirm) {
    confirmation = "confirmed";
    // firstBad first: the failure is the claim that blames a version. lastGood is skipped when it is
    // just the caller's known-good old version and no budget is left.
    const checks: [string, PythonProbeOutcome][] = [
      [firstBad, "fail"],
      [lastGood, "pass"],
    ];
    for (const [version, expected] of checks) {
      if (log.length >= maxInstalls) {
        confirmation = confirmation === "flaky" ? "flaky" : "unconfirmed";
        break;
      }
      const outcome = await request.probe(version);
      log.push({ version, outcome, confirmation: true });
      if (outcome === "unknown") confirmation = confirmation === "flaky" ? "flaky" : "unconfirmed";
      else if (outcome !== expected) confirmation = "flaky";
    }
  }

  return {
    status: confirmation === "flaky" ? "unstable" : hi - lo === 1 ? "exact" : "narrowed",
    confirmation,
    lastGood,
    firstBad,
    ambiguousWith: skipped.filter((v) => compareVersions(v, lastGood) > 0 && compareVersions(v, firstBad) < 0).sort(compareVersions),
    log,
    installs: log.length,
  };
}

/** (old, new] in ascending order, always ending with the version known to fail. */
function candidateVersions(request: PythonBisectRequest): string[] {
  const inRange = versionsInRange(request.availableVersions, request.oldVersion, request.newVersion);
  return inRange.includes(request.newVersion) ? inRange : [...inRange, request.newVersion];
}
