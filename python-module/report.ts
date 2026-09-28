/**
 * Phase 7 of #15: verdict + report, trimmed npm-core shape. No breaking-change matcher and no
 * workspaces in v1 scope (python-module/README.md), so this is tests + bisection only — no
 * `match`/`usage` evidence, no `workspaces` field. Mirrors src/report/verdict.ts's judge()
 * rules (a "safe" claim only covers signals actually evaluated; "broken" always carries the
 * evidence that justified it) at that reduced scope.
 */
import type { PythonBisectResult } from "./bisect.js";
import type { PythonChangelogResult } from "./changelog.js";
import type { PythonMatchResult } from "./match.js";
import { describeVersions } from "./version.js";
import type { PythonDependencyChange } from "./lockfile.js";
import type { PythonTestOutcome } from "./testrun.js";
import type { PythonUsageScan } from "./usage.js";

export type PythonVerdictStatus = "safe" | "risky" | "broken";

export type PythonEvidence =
  | { kind: "no-tests"; reason: string }
  | { kind: "test-failure"; outcome: string; output: string }
  | { kind: "bisect"; exact: boolean; unstable: boolean; unconfirmed: boolean; lastGood: string; firstBad: string; ambiguousWith: string[]; installs: number; failingOutput: string }
  | { kind: "call-site"; symbol: string; file: string; line: number; snippet: string; changelogVersion: string; changelogExcerpt: string; matchConfidence: "high" | "medium"; reason: string };

export interface PythonDependencyVerdict {
  name: string;
  oldVersion?: string;
  newVersion?: string;
  status: PythonVerdictStatus;
  confidence: "full" | "reduced";
  summary: string;
  evidence: PythonEvidence[];
  caveats: string[];
  notes: string[];
}

export interface PythonReport {
  schemaVersion: 1;
  overall: PythonVerdictStatus;
  verdicts: PythonDependencyVerdict[];
}

export interface PythonDependencyAssessment {
  change: PythonDependencyChange;
  /** Shared by every dependency in one bump: the project's suite runs once. */
  test: PythonTestOutcome;
  changelog: PythonChangelogResult;
  usage: PythonUsageScan;
  match: PythonMatchResult;
  /** Present only when this dependency was bisected. */
  bisect?: PythonBisectResult;
}

const SEVERITY: PythonVerdictStatus[] = ["safe", "risky", "broken"];
const OUTPUT_TAIL_LINES = 40;

export function buildPythonReport(assessments: PythonDependencyAssessment[]): PythonReport {
  const verdicts = assessments.map(judgePython);
  const overall = verdicts.reduce<PythonVerdictStatus>((w, v) => (SEVERITY.indexOf(v.status) > SEVERITY.indexOf(w) ? v.status : w), "safe");
  return { schemaVersion: 1, overall, verdicts };
}

export function judgePython(a: PythonDependencyAssessment): PythonDependencyVerdict {
  const base = { name: a.change.name, oldVersion: a.change.oldVersion, newVersion: a.change.newVersion, caveats: [] as string[], notes: [] as string[] };
  const isNew = a.change.kind === "added";
  const isRemoved = a.change.kind === "removed";

  const test = a.test;
  if (test.status === "no-manager") return unverified(base, "no uv.lock or poetry.lock found for the sandbox install, so nothing ran against this bump");
  if (test.status === "baseline-failing") return unverified(base, "the test suite already fails on the old lockfile, so this bump cannot be verified");
  if (test.status === "blamed-elsewhere") return unverified(base, `the suite fails because of ${test.culprits.join(", ")}; this dependency was not tested on its own`);
  if (test.status !== "passed") return broken(base, a, test);

  const evidence = callSiteEvidence(a.match);
  if (evidence.length > 0) {
    const count = evidence.length;
    return {
      ...base,
      status: "risky",
      confidence: "full",
      summary: `tests pass, but the changelog names ${count} symbol use${count === 1 ? "" : "s"} in your code as breaking`,
      evidence,
    };
  }

  const caveats = [...base.caveats];
  const notes = [...base.notes];
  if (!isNew && !isRemoved) {
    if (a.changelog.source === "none") caveats.push("no changelog was found; this is a tests-only verdict");
    else if (a.changelog.missingVersions.length > 0) caveats.push(`no changelog notes for ${describeVersions(a.changelog.missingVersions)}`);
    if (a.match.majorBoundary) caveats.push("major version bump: breaking changes are allowed even if the changelog does not list them");
  }
  if (a.usage.unparsed.length > 0) caveats.push(`usage scan incomplete: could not parse ${a.usage.unparsed.map((f) => f.file).join(", ")}`);
  if (isNew) notes.push("new dependency: no earlier version to compare against");
  notes.push(...a.changelog.notes);

  const tested = isRemoved ? "removed" : "tests pass";
  return {
    ...base,
    status: "safe",
    confidence: caveats.length === 0 ? "full" : "reduced",
    summary: caveats.length === 0 ? `${tested}, no breaking change detected` : `${tested}; verdict is partial: ${caveats[0]}`,
    evidence: [],
    caveats,
    notes,
  };
}

function callSiteEvidence(match: PythonMatchResult): PythonEvidence[] {
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

type PartialBase = Pick<PythonDependencyVerdict, "name" | "oldVersion" | "newVersion" | "caveats" | "notes">;

function unverified(base: PartialBase, text: string): PythonDependencyVerdict {
  return { ...base, status: "risky", confidence: "reduced", summary: `unverified: ${text}`, evidence: [{ kind: "no-tests", reason: text }] };
}

function broken(base: PartialBase, a: PythonDependencyAssessment, test: Exclude<PythonTestOutcome, { status: "passed" | "no-manager" | "baseline-failing" | "blamed-elsewhere" }>): PythonDependencyVerdict {
  const output = tail(test.result.output);
  const evidence: PythonEvidence[] = [];
  let summary: string;

  if (a.bisect) {
    const { firstBad, lastGood, status, ambiguousWith, installs, confirmation } = a.bisect;
    const unstable = status === "unstable";
    evidence.push({ kind: "bisect", exact: status === "exact", unstable, unconfirmed: confirmation === "unconfirmed", lastGood, firstBad, ambiguousWith, installs, failingOutput: output });
    summary = unstable
      ? `broken, but flaky suite: result not reliable (boundary ${lastGood} / ${firstBad} flipped on re-run); no exact version claimed`
      : status === "exact"
        ? `broken by ${firstBad} (${lastGood} still passed)`
        : `broken somewhere in ${lastGood} < v <= ${firstBad} (bisection bound reached)`;
  } else {
    evidence.push({ kind: "test-failure", outcome: test.status, output });
    summary = `${describeFailure(test.status)}; not isolated to a single version`;
  }
  return { ...base, status: "broken", confidence: "full", summary, evidence };
}

function describeFailure(status: string): string {
  const wording: Record<string, string> = { "timed-out": "tests hung and were killed at the timeout", "install-failed": "install fails" };
  return wording[status] ?? "tests fail";
}

function tail(output: string): string {
  return output.split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join("\n").trim();
}
