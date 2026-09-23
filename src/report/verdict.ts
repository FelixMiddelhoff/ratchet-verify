import type { BisectResult } from "../bisect/index.js";
import type { ChangelogResult } from "../changelog/index.js";
import type { DependencyChange } from "../lockfile/index.js";
import type { MatchResult } from "../match/index.js";
import type { TestOutcome } from "../testrun/index.js";
import type { UsageScan } from "../usage/index.js";
import type { DependencyVerdict, Evidence, Report, VerdictStatus } from "./types.js";

export interface DependencyAssessment {
  change: DependencyChange;
  /** Shared by every dependency in one bump: the project's suite runs once. */
  test: TestOutcome;
  usage: UsageScan;
  changelog: ChangelogResult;
  match: MatchResult;
  /** Present only when this dependency was bisected. */
  bisect?: BisectResult;
}

const OUTPUT_TAIL_LINES = 40;
const SEVERITY: VerdictStatus[] = ["safe", "risky", "broken"];

export function buildReport(assessments: DependencyAssessment[]): Report {
  const verdicts = assessments.map(judge);
  const overall = verdicts.reduce<VerdictStatus>((worst, v) => (SEVERITY.indexOf(v.status) > SEVERITY.indexOf(worst) ? v.status : worst), "safe");
  return { schemaVersion: 1, overall, verdicts };
}

/**
 * Rules from ratchet-quality-policy.md: "safe" is only ever a claim about signals that were
 * actually evaluated, and "risky"/"broken" always carry the evidence that justified them.
 */
export function judge(a: DependencyAssessment): DependencyVerdict {
  const base = {
    name: a.change.name,
    oldVersion: a.change.oldVersion,
    newVersion: a.change.newVersion,
    direct: a.change.direct,
    caveats: [] as string[],
    notes: [] as string[],
  };

  const test = a.test;
  if (test.status === "blamed-elsewhere") {
    return unverified(base, `the suite fails because of ${test.culprits.join(", ")}; this dependency was not tested on its own`);
  }
  if (test.status === "no-test-script" || test.status === "no-lockfile" || test.status === "baseline-failing") {
    return unverified(base, UNVERIFIED_REASON[test.status]);
  }
  if (test.status !== "passed" && "result" in test) return broken(base, a, test);

  const evidence = callSiteEvidence(a.match);
  if (evidence.length > 0) {
    const count = evidence.length;
    return {
      ...base,
      status: "risky",
      confidence: "full",
      summary: `tests pass, but the changelog names ${count} symbol use${count === 1 ? "" : "s"} in your code as breaking`,
      evidence,
      ...gatherGaps(a, base),
    };
  }

  const gaps = gatherGaps(a, base);
  const tested = a.change.kind === "removed" ? "removed" : "tests pass";
  return {
    ...base,
    status: "safe",
    confidence: gaps.caveats.length === 0 ? "full" : "reduced",
    summary: gaps.caveats.length === 0 ? `${tested}, no breaking change touches your code` : `${tested}; verdict is partial: ${gaps.caveats[0]}`,
    evidence: [],
    ...gaps,
  };
}

const UNVERIFIED_REASON = {
  "no-test-script": "package.json has no scripts.test, so nothing ran against this bump",
  "no-lockfile": "no lockfile found for the sandbox install, so nothing ran against this bump",
  "baseline-failing": "the test suite already fails on the old lockfile, so this bump cannot be verified",
};

function unverified(base: PartialBase, text: string): DependencyVerdict {
  return {
    ...base,
    status: "risky",
    confidence: "reduced",
    summary: `unverified: ${text}`,
    evidence: [{ kind: "no-tests", reason: text }],
  };
}

function broken(base: PartialBase, a: DependencyAssessment, test: Extract<TestOutcome, { result: unknown }>): DependencyVerdict {
  const output = tail(test.result.output);
  const evidence: Evidence[] = [];
  let summary: string;

  if (a.bisect) {
    const { firstBad, lastGood, status, ambiguousWith, installs } = a.bisect;
    evidence.push({ kind: "bisect", exact: status === "exact", lastGood, firstBad, ambiguousWith, installs, failingOutput: output });
    summary =
      status === "exact"
        ? `broken by ${firstBad} (${lastGood} still passed)`
        : `broken somewhere in ${lastGood} < v <= ${firstBad} (bisection bound reached)`;
  } else {
    evidence.push({ kind: "test-failure", outcome: test.status, output, bisectSkippedReason: bisectSkippedReason(a) });
    summary = `${describeFailure(test.status)}; not isolated to a single version`;
  }
  return { ...base, status: "broken", confidence: "full", summary, evidence };
}

type PartialBase = Pick<DependencyVerdict, "name" | "oldVersion" | "newVersion" | "direct" | "caveats" | "notes">;

function describeFailure(status: string): string {
  const wording: Record<string, string> = {
    "timed-out": "tests hung and were killed at the timeout",
    "install-failed": "install fails",
  };
  return wording[status] ?? "tests fail";
}

function bisectSkippedReason(a: DependencyAssessment): string {
  if (a.change.kind === "added") return "new dependency: no earlier version to bisect against";
  return "bisection was not run for this dependency";
}

function callSiteEvidence(match: MatchResult): Evidence[] {
  return match.hits
    .filter((h) => h.confidence !== "low")
    .map((h) => ({
      kind: "call-site" as const,
      symbol: h.site.symbol,
      file: h.site.file,
      line: h.site.line,
      snippet: h.site.snippet,
      changelogVersion: h.version,
      changelogExcerpt: h.excerpt,
      matchConfidence: h.confidence as "high" | "medium",
      reason: h.reason,
    }));
}

/** Every signal ratchet could not fully evaluate becomes an explicit caveat (policy rule 1). */
function gatherGaps(a: DependencyAssessment, base: PartialBase): { caveats: string[]; notes: string[] } {
  const caveats = [...base.caveats];
  const notes = [...base.notes];
  const isNew = a.change.kind === "added";
  const isRemoved = a.change.kind === "removed";

  if (!isNew && !isRemoved) {
    if (a.changelog.source === "none") caveats.push("no changelog was found; this is a tests-only verdict");
    else if (a.changelog.missingVersions.length > 0) caveats.push(`no changelog notes for: ${a.changelog.missingVersions.join(", ")}`);
    if (a.match.majorBoundary) caveats.push("major version bump: breaking changes are allowed even if the changelog does not list them");
    if (a.match.hits.some((h) => h.confidence === "low")) {
      caveats.push("code uses the whole module or its default export, so listed breaking changes cannot be ruled out");
    }
  }
  if (a.usage.unparsed.length > 0) {
    caveats.push(`usage scan incomplete: could not parse ${a.usage.unparsed.map((f) => f.file).join(", ")}`);
  }
  if (a.change.direct && a.usage.sites.length === 0 && !isRemoved) {
    notes.push("no import sites found in source; the package may be used through config or the CLI");
  }
  if (isNew) notes.push("new dependency: no earlier version to compare against");
  notes.push(...a.changelog.notes);
  return { caveats, notes };
}

function tail(output: string): string {
  return output.split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join("\n").trim();
}
