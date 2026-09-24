import { groupVerdicts, overallLabel, type VerdictGroup } from "./group.js";
import { describeIsolation } from "./isolation.js";
import type { DependencyVerdict, Evidence, Report } from "./types.js";

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

export function renderText(report: Report): string {
  const blocks = groupVerdicts(report.verdicts).map((g) => (g.members.length > 1 ? renderGroup(g) : renderVerdict(g.members[0]!)));
  const footer = [`overall: ${overallLabel(report)}`, ...(report.isolation ? [`isolation: ${describeIsolation(report.isolation)}`] : [])];
  return [...blocks, footer.join("\n")].join("\n\n");
}

function renderGroup(group: VerdictGroup): string {
  const names = nameList(group.members.map((v) => v.name));
  const first = group.members[0]!;
  return [`${first.status.toUpperCase()}  ${group.members.length} transitive dependencies (${names})`, `  ${first.summary}`].join("\n");
}

function renderVerdict(v: DependencyVerdict): string {
  const label = v.status === "safe" && v.confidence === "reduced" ? "safe (partial)" : v.status;
  const range = [v.oldVersion, v.newVersion].filter(Boolean).join(" -> ");
  const lines = [`${label.toUpperCase()}  ${v.name} ${range} (${v.direct ? "direct" : "transitive"})`, `  ${v.summary}`];
  if (v.workspaces) lines.push(`  workspaces: ${describeWorkspaces(v.workspaces)}`);
  for (const evidence of v.evidence) lines.push(...renderEvidence(evidence));
  if (v.suggestion) lines.push(...suggestionText(v.suggestion));
  for (const caveat of v.caveats) lines.push(`  caveat: ${caveat}`);
  for (const note of v.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

function renderEvidence(e: Evidence): string[] {
  switch (e.kind) {
    case "call-site":
      return [
        `  - ${e.file}:${e.line}  ${e.snippet}`,
        `    changelog ${e.changelogVersion} (${e.matchConfidence}): ${e.changelogExcerpt}`,
      ];
    case "bisect":
      return [
        `  - bisected in ${e.installs} install${e.installs === 1 ? "" : "s"}: last good ${e.lastGood}, ${e.unstable ? "flaky, unreliable boundary" : e.exact ? "first bad" : "still failing at"} ${e.firstBad}`,
        ...(e.unstable ? ["    flaky suite: a boundary result flipped on re-run, so this is NOT an exact culprit"] : []),
        ...(e.unconfirmed ? ["    boundary not re-run to confirm (budget or inconclusive)"] : []),
        ...(e.ambiguousWith.length ? [`    untestable versions in that window: ${e.ambiguousWith.join(", ")}`] : []),
        ...indent(e.failingOutput),
      ];
    case "test-failure":
      return [`  - ${e.outcome}${e.bisectSkippedReason ? ` (${e.bisectSkippedReason})` : ""}`, ...indent(e.output)];
    case "no-tests":
      return [`  - ${e.reason}`];
  }
}

function indent(text: string): string[] {
  return text ? text.split("\n").map((l) => `    | ${l}`) : [];
}

const MAX_LISTED_NAMES = 6;

/** A failing bump can drag in dozens of transitive changes; the first few say enough, JSON has the rest. */
function nameList(names: string[]): string {
  if (names.length <= MAX_LISTED_NAMES) return names.join(", ");
  return `${names.slice(0, MAX_LISTED_NAMES).join(", ")} and ${names.length - MAX_LISTED_NAMES} more`;
}

function suggestionText(s: NonNullable<DependencyVerdict["suggestion"]>): string[] {
  return [`  last known good: ${s.version} (tested passing in this run)${s.command ? `; pin with: ${s.command}` : ""}`, "  later versions were not tested; they are not claimed broken"];
}

export function describeWorkspaces(w: NonNullable<DependencyVerdict["workspaces"]>): string {
  const declared = w.declared.length > 0 ? `declared in ${w.declared.join(", ")}` : "not declared in any manifest (transitive)";
  return `${declared}; ${w.used.length > 0 ? `used in ${w.used.join(", ")}` : "no usage found in source"}`;
}
