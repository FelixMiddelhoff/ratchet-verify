import { bisect, type BisectResult, type ProbeOutcome } from "../bisect/index.js";
import type { ChangelogRequest, ChangelogResult } from "../changelog/index.js";
import type { Config } from "../config.js";
import { diffLockfileTexts, type DependencyChange, type RootManifest } from "../lockfile/index.js";
import { matchBreakingChanges } from "../match/index.js";
import { buildReport, type DependencyAssessment, type Report } from "../report/index.js";
import type { TestOutcome } from "../testrun/index.js";
import type { UsageScan } from "../usage/index.js";

export interface PipelineInput {
  oldLockfile: string;
  newLockfile: string;
  manifest: RootManifest;
  /** package.json as of the old lockfile; `npm ci` refuses a lockfile that disagrees with its manifest. */
  oldPackageJson?: string;
  config: Config;
}

/** Everything that touches the network, disk or a sandbox; faked in tests. */
export interface PipelineDeps {
  /** Installs the given lockfile in a sandbox and runs the project's tests. */
  testLockfile(lockfileText: string, packageJson?: string): Promise<TestOutcome>;
  /** Old lockfile with only `name` moved to `version`, installed and tested in a sandbox. */
  testDependencyAt(name: string, version: string): Promise<TestOutcome>;
  fetchChangelog(request: ChangelogRequest): Promise<ChangelogResult>;
  scanUsage(packageName: string): Promise<UsageScan>;
}

const EMPTY_CHANGELOG: ChangelogResult = { source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] };
const FAILURES = new Set(["failed", "timed-out", "install-failed"]);

interface Signals {
  change: DependencyChange;
  usage: UsageScan;
  changelog: ChangelogResult;
  match: ReturnType<typeof matchBreakingChanges>;
}

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<Report> {
  const changes = diffLockfileTexts(input.oldLockfile, input.newLockfile, input.manifest).filter(
    (c) => !input.config.ignore.includes(c.name),
  );
  if (changes.length === 0) return buildReport([]);

  const overall = await deps.testLockfile(input.newLockfile);
  const signals = await Promise.all(changes.map((change) => gatherSignals(change, deps)));
  const outcomes = FAILURES.has(overall.status)
    ? await explainFailure(input, deps, overall, signals)
    : new Map(signals.map((s) => [s.change.path, { test: overall }]));

  return buildReport(
    signals.map((s) => ({ ...s, ...outcomes.get(s.change.path)! }) satisfies DependencyAssessment),
  );
}

async function gatherSignals(change: DependencyChange, deps: PipelineDeps): Promise<Signals> {
  const usage = await deps.scanUsage(change.name);
  const bumped = change.kind === "changed" && change.oldVersion && change.newVersion;
  const changelog = bumped
    ? await deps.fetchChangelog({ name: change.name, oldVersion: change.oldVersion!, newVersion: change.newVersion! })
    : EMPTY_CHANGELOG;
  const match = matchBreakingChanges({
    entries: changelog.entries,
    sites: usage.sites,
    oldVersion: change.oldVersion ?? "0.0.0",
    newVersion: change.newVersion ?? "0.0.0",
  });
  return { change, usage, changelog, match };
}

type Outcome = Pick<DependencyAssessment, "test" | "bisect">;

/**
 * The suite runs once for the whole bump, so a failure alone can't say which dependency did it.
 * First rule out a suite that was already red, then test each direct bump on its own and
 * bisect the ones that reproduce the failure.
 */
async function explainFailure(
  input: PipelineInput,
  deps: PipelineDeps,
  overall: TestOutcome,
  signals: Signals[],
): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  const baseline = await deps.testLockfile(input.oldLockfile, input.oldPackageJson);
  if (baseline.status !== "passed" && "result" in baseline) {
    for (const s of signals) outcomes.set(s.change.path, { test: { status: "baseline-failing", result: baseline.result } });
    return outcomes;
  }

  const candidates = signals.filter((s) => s.change.direct && s.change.kind === "changed");
  const lone = signals.length === 1 && candidates.length === 1;
  const culprits: string[] = [];

  for (const s of candidates) {
    const test = lone ? overall : await deps.testDependencyAt(s.change.name, s.change.newVersion!);
    if (test.status === "passed") {
      outcomes.set(s.change.path, { test });
    } else if (FAILURES.has(test.status) && test.status !== "install-failed") {
      culprits.push(s.change.name);
      outcomes.set(s.change.path, { test, bisect: await bisectDependency(s, deps, input.config) });
    }
  }

  // Each direct bump passed alone yet the suite fails together: an interaction. Clearing any
  // single dependency here would be a false "all clear", so nobody is cleared.
  if (culprits.length === 0) return new Map(signals.map((s) => [s.change.path, { test: overall }]));

  for (const s of signals) {
    if (outcomes.has(s.change.path)) continue;
    // Not proven guilty and not exonerated: say so instead of blaming or clearing it.
    outcomes.set(s.change.path, { test: { status: "blamed-elsewhere", culprits } });
  }
  return outcomes;
}

async function bisectDependency(
  s: Signals,
  deps: PipelineDeps,
  config: Config,
): Promise<BisectResult | undefined> {
  if (s.changelog.availableVersions.length === 0) return undefined; // registry unreachable: nothing to search
  return bisect({
    availableVersions: s.changelog.availableVersions,
    oldVersion: s.change.oldVersion!,
    newVersion: s.change.newVersion!,
    maxInstalls: config.maxInstalls,
    probe: async (version) => toProbeOutcome((await deps.testDependencyAt(s.change.name, version)).status),
  });
}

function toProbeOutcome(status: TestOutcome["status"]): ProbeOutcome {
  if (status === "passed") return "pass";
  if (status === "failed" || status === "timed-out") return "fail";
  return "unknown";
}
