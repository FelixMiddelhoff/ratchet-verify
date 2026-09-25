import { bisect, type BisectResult, type ProbeOutcome } from "../bisect/index.js";
import type { ChangelogRequest, ChangelogResult } from "../changelog/index.js";
import type { Config } from "../config.js";
import { diffLockfileTexts, type DependencyChange, type RootManifest, type WorkspaceManifest } from "../lockfile/index.js";
import { matchBreakingChanges } from "../match/index.js";
import { buildReport, type DependencyAssessment, type RegistryProxyInfo, type Report } from "../report/index.js";
import type { IsolationInfo } from "../sandbox/index.js";
import type { PinScope } from "../testrun/managers.js";
import type { TestOutcome } from "../testrun/index.js";
import { ROOT_LABEL, workspaceLabel } from "../lockfile/labels.js";
import { workspaceOfFile } from "../workspaces/index.js";
import type { UsageScan } from "../usage/index.js";

export interface PipelineInput {
  oldLockfile: string;
  newLockfile: string;
  manifest: RootManifest;
  /** Workspace packages (empty/absent = single package): a dependency is direct if any manifest names it. */
  workspaces?: WorkspaceManifest[];
  /** package.json as of the old lockfile; `npm ci` refuses a lockfile that disagrees with its manifest. */
  oldPackageJson?: string;
  config: Config;
}

/** Everything that touches the network, disk or a sandbox; faked in tests. */
export interface PipelineDeps {
  /** Installs the given lockfile in a sandbox and runs the project's tests. */
  testLockfile(lockfileText: string, packageJson?: string): Promise<TestOutcome>;
  /** Old lockfile with only `name` moved to `version`, installed and tested in a sandbox. */
  testDependencyAt(name: string, version: string, scope?: PinScope): Promise<TestOutcome>;
  fetchChangelog(request: ChangelogRequest): Promise<ChangelogResult>;
  scanUsage(packageName: string): Promise<UsageScan>;
  /** What isolated the installs and tests; shown in every report. */
  isolation?: IsolationInfo;
  /** Read after all work is done (the proxy's counters grow during the run); absent when no proxy was used. */
  registryProxy?: () => RegistryProxyInfo | undefined;
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
  const changes = diffLockfileTexts(input.oldLockfile, input.newLockfile, input.manifest, input.workspaces).filter(
    (c) => !input.config.ignore.includes(c.name),
  );
  if (changes.length === 0) return buildReport([], deps.isolation, deps.registryProxy?.());

  const overall = await deps.testLockfile(input.newLockfile);
  const signals = await Promise.all(changes.map((change) => gatherSignals(change, deps)));
  const outcomes = FAILURES.has(overall.status)
    ? await explainFailure(input, deps, overall, signals)
    : new Map(signals.map((s) => [s.change.path, { test: overall }]));

  return buildReport(
    signals.map((s) => ({ ...s, ...outcomes.get(s.change.path)!, ...workspaceInfo(s, input.workspaces) }) satisfies DependencyAssessment),
    deps.isolation,
    deps.registryProxy?.(),
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
    packageName: change.name,
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
    const test = lone ? overall : await deps.testDependencyAt(s.change.name, s.change.newVersion!, pinScope(s.change, input.workspaces));
    if (test.status === "passed") {
      outcomes.set(s.change.path, { test });
    } else if (FAILURES.has(test.status) && test.status !== "install-failed") {
      culprits.push(s.change.name);
      outcomes.set(s.change.path, { test, bisect: await bisectDependency(s, deps, input.config, input.workspaces) });
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
  workspaces?: WorkspaceManifest[],
): Promise<BisectResult | undefined> {
  if (s.changelog.availableVersions.length === 0) return undefined; // registry unreachable: nothing to search
  return bisect({
    availableVersions: s.changelog.availableVersions,
    oldVersion: s.change.oldVersion!,
    newVersion: s.change.newVersion!,
    maxInstalls: config.maxInstalls,
    probe: async (version) => toProbeOutcome((await deps.testDependencyAt(s.change.name, version, pinScope(s.change, workspaces))).status),
  });
}

function toProbeOutcome(status: TestOutcome["status"]): ProbeOutcome {
  if (status === "passed") return "pass";
  if (status === "failed" || status === "timed-out") return "fail";
  return "unknown";
}

/** Which manifest a single-dependency move must edit. */
function pinScope(change: DependencyChange, workspaces: WorkspaceManifest[] = []): PinScope | undefined {
  if (workspaces.length === 0) return undefined;
  const declared = change.declaredIn ?? [];
  if (declared.length > 1) return { workspaceProject: true, ambiguous: true };
  const owner = workspaces.find((w) => workspaceLabel(w) === declared[0]);
  return owner ? { workspaceProject: true, workspace: { name: owner.name, dir: owner.dir, ...(owner.unnamed ? { unnamed: true } : {}) } } : { workspaceProject: true };
}

/** Which workspaces declare the dependency and which contain its call sites (workspace projects only). */
function workspaceInfo(s: Signals, workspaces: WorkspaceManifest[] = []): Pick<DependencyAssessment, "workspaces"> {
  if (workspaces.length === 0) return {};
  const used = new Set<string>();
  for (const site of s.usage.sites) {
    const owner = workspaceOfFile(site.file, workspaces);
    used.add(owner ? workspaceLabel(owner) : ROOT_LABEL);
  }
  return { workspaces: { declared: s.change.declaredIn ?? [], used: [...used].sort() } };
}
