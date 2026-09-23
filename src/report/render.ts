import { groupVerdicts, overallLabel, type VerdictGroup } from "./group.js";
import type { DependencyVerdict, Evidence, Report } from "./types.js";

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

export function renderText(report: Report): string {
  const blocks = groupVerdicts(report.verdicts).map((g) => (g.members.length > 1 ? renderGroup(g) : renderVerdict(g.members[0]!)));
  return [...blocks, `overall: ${overallLabel(report)}`].join("\n\n");
}

function renderGroup(group: VerdictGroup): string {
  const names = group.members.map((v) => v.name).join(", ");
  const first = group.members[0]!;
  return [`${first.status.toUpperCase()}  ${group.members.length} transitive dependencies (${names})`, `  ${first.summary}`].join("\n");
}

function renderVerdict(v: DependencyVerdict): string {
  const label = v.status === "safe" && v.confidence === "reduced" ? "safe (partial)" : v.status;
  const range = [v.oldVersion, v.newVersion].filter(Boolean).join(" -> ");
  const lines = [`${label.toUpperCase()}  ${v.name} ${range} (${v.direct ? "direct" : "transitive"})`, `  ${v.summary}`];
  for (const evidence of v.evidence) lines.push(...renderEvidence(evidence));
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
        `  - bisected in ${e.installs} install${e.installs === 1 ? "" : "s"}: last good ${e.lastGood}, ${e.exact ? "first bad" : "still failing at"} ${e.firstBad}`,
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
