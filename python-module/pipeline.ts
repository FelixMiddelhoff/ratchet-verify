/**
 * Phase 7 of #15 + v2 item 1: wires lockfile diff (phase 2) + changelog fetch (phase 3) +
 * usage scan (phase 4, first wired here) + sandboxed install/test (phase 5) + bisection
 * (phase 6) + breaking-change matcher (v2 item 1, match.ts) into one report. Trimmed from
 * src/pipeline/index.ts: no workspaces in python-module's scope.
 */
import { bisectPython, type PythonBisectResult, type PythonProbeOutcome } from "./bisect.js";
import type { PythonChangelogRequest, PythonChangelogResult } from "./changelog.js";
import { diffPythonLockfiles, parsePythonLock, type PythonDependencyChange } from "./lockfile.js";
import { matchPythonBreakingChanges, type PythonMatchResult } from "./match.js";
import { buildPythonReport, type PythonDependencyAssessment, type PythonReport } from "./report.js";
import type { PythonTestOutcome } from "./testrun.js";
import type { PythonUsageScan } from "./usage.js";

export interface PythonPipelineInput {
  oldLockfileText: string;
  newLockfileText: string;
  maxInstalls?: number;
}

/** Everything that touches the network, disk or a sandbox; faked in tests. */
export interface PythonPipelineDeps {
  /** Installs the given lockfile text in a sandbox and runs the project's tests. */
  testLockfile(lockfileText: string): Promise<PythonTestOutcome>;
  /** Same lockfile, with just `name` pinned to `version`, installed and tested in a sandbox. */
  testDependencyAt(name: string, version: string): Promise<PythonTestOutcome>;
  fetchChangelog(request: PythonChangelogRequest): Promise<PythonChangelogResult>;
  /** Import sites of `packageName` across the project's own .py files. */
  scanUsage(packageName: string): Promise<PythonUsageScan>;
}

const EMPTY_CHANGELOG: PythonChangelogResult = { source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] };
const FAILURES = new Set(["failed", "timed-out", "install-failed"]);

interface Signals {
  change: PythonDependencyChange;
  changelog: PythonChangelogResult;
  usage: PythonUsageScan;
  match: PythonMatchResult;
}

export async function runPythonPipeline(input: PythonPipelineInput, deps: PythonPipelineDeps): Promise<PythonReport> {
  const changes = diffPythonLockfiles(parsePythonLock(input.oldLockfileText), parsePythonLock(input.newLockfileText));
  if (changes.length === 0) return buildPythonReport([]);

  const signals = new Map(await Promise.all(changes.map(async (c): Promise<[string, Signals]> => [c.name, await gatherSignals(c, deps)])));

  const overall = await deps.testLockfile(input.newLockfileText);
  const outcomes = FAILURES.has(overall.status)
    ? await explainFailure(input, deps, overall, changes, signals)
    : new Map(changes.map((c) => [c.name, { test: overall }]));

  return buildPythonReport(
    changes.map((c) => ({ ...signals.get(c.name)!, ...outcomes.get(c.name)! }) satisfies PythonDependencyAssessment),
  );
}

async function gatherSignals(c: PythonDependencyChange, deps: PythonPipelineDeps): Promise<Signals> {
  const usage = await deps.scanUsage(c.name);
  const changelog = c.kind === "changed" ? await deps.fetchChangelog({ name: c.name, oldVersion: c.oldVersion!, newVersion: c.newVersion! }) : EMPTY_CHANGELOG;
  const match = matchPythonBreakingChanges({ entries: changelog.entries, sites: usage.sites, oldVersion: c.oldVersion ?? "0.0.0", newVersion: c.newVersion ?? "0.0.0" });
  return { change: c, changelog, usage, match };
}

type Outcome = Pick<PythonDependencyAssessment, "test" | "bisect">;

/**
 * The suite runs once for the whole bump, so a failure alone can't say which dependency did it.
 * First rule out a suite that was already red, then test each changed dependency on its own and
 * bisect the ones that reproduce the failure.
 */
async function explainFailure(
  input: PythonPipelineInput,
  deps: PythonPipelineDeps,
  overall: PythonTestOutcome,
  changes: PythonDependencyChange[],
  signals: Map<string, Signals>,
): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  const baseline = await deps.testLockfile(input.oldLockfileText);
  if (baseline.status !== "passed" && "result" in baseline) {
    for (const c of changes) outcomes.set(c.name, { test: { status: "baseline-failing", result: baseline.result } });
    return outcomes;
  }

  const candidates = changes.filter((c) => c.kind === "changed");
  const lone = changes.length === 1 && candidates.length === 1;
  const culprits: string[] = [];

  for (const c of candidates) {
    const test = lone ? overall : await deps.testDependencyAt(c.name, c.newVersion!);
    if (test.status === "passed") {
      outcomes.set(c.name, { test });
    } else if (FAILURES.has(test.status) && test.status !== "install-failed") {
      culprits.push(c.name);
      outcomes.set(c.name, { test, bisect: await bisectDependency(c, signals.get(c.name)!.changelog, deps, input.maxInstalls) });
    }
  }

  // Each changed dependency passed alone yet the suite fails together: an interaction. Clearing any
  // single dependency here would be a false "all clear", so nobody is cleared.
  if (culprits.length === 0) return new Map(changes.map((c) => [c.name, { test: overall }]));

  for (const c of changes) {
    if (outcomes.has(c.name)) continue;
    outcomes.set(c.name, { test: { status: "blamed-elsewhere", culprits } });
  }
  return outcomes;
}

async function bisectDependency(
  c: PythonDependencyChange,
  changelog: PythonChangelogResult,
  deps: PythonPipelineDeps,
  maxInstalls: number | undefined,
): Promise<PythonBisectResult | undefined> {
  if (changelog.availableVersions.length === 0) return undefined; // PyPI unreachable: nothing to search
  return bisectPython({
    availableVersions: changelog.availableVersions,
    oldVersion: c.oldVersion!,
    newVersion: c.newVersion!,
    maxInstalls,
    probe: async (version) => toProbeOutcome((await deps.testDependencyAt(c.name, version)).status),
  });
}

function toProbeOutcome(status: PythonTestOutcome["status"]): PythonProbeOutcome {
  if (status === "passed") return "pass";
  if (status === "failed" || status === "timed-out") return "fail";
  return "unknown";
}
