import { groupVerdicts, overallLabel } from "../report/group.js";
import { describeIsolation } from "../report/isolation.js";
import type { DependencyVerdict, Evidence, Report } from "../report/index.js";

/** Lets the action find and update its own comment instead of posting a new one per push. */
export const COMMENT_MARKER = "<!-- ratchet-verdict -->";

/** GitHub rejects comments over 65536 characters. */
const MAX_COMMENT_CHARS = 60_000;
const ICON = { safe: "✅", risky: "⚠️", broken: "❌" } as const;

export function renderMarkdown(report: Report): string {
  const lines = [COMMENT_MARKER, `## ratchet: ${ICON[report.overall]} ${overallLabel(report)}`, ""];

  const isolationLine = report.isolation ? ["", `<sub>isolation: ${escapeHtml(describeIsolation(report.isolation))}</sub>`] : [];

  if (report.verdicts.length === 0) {
    lines.push("No dependency changes to verify.", ...isolationLine);
    return lines.join("\n");
  }

  lines.push("| | Dependency | Change | Verdict |", "|---|---|---|---|");
  const groups = groupVerdicts(report.verdicts);
  for (const { members } of groups) {
    const v = members[0]!;
    if (members.length > 1) {
      lines.push(`| ${ICON[v.status]} | ${members.length} transitive dependencies | | ${cell(label(v))} |`);
    } else {
      lines.push(`| ${ICON[v.status]} | \`${v.name}\`${v.direct ? "" : " (transitive)"} | ${range(v)} | ${cell(label(v))} |`);
    }
  }
  for (const { members } of groups) {
    const v = members[0]!;
    if (members.length > 1) lines.push("", ...groupDetails(members));
    else if (needsDetail(v)) lines.push("", ...details(v));
  }

  lines.push(...isolationLine);
  return clamp(lines.join("\n"));
}

/** Clean, fully-evaluated "safe" rows need no expansion; everything else shows its evidence. */
function needsDetail(v: DependencyVerdict): boolean {
  return v.status !== "safe" || v.confidence === "reduced";
}

function label(v: DependencyVerdict): string {
  return v.status === "safe" && v.confidence === "reduced" ? "safe (partial)" : v.status;
}

function range(v: DependencyVerdict): string {
  return [v.oldVersion, v.newVersion].filter(Boolean).map((x) => `\`${x}\``).join(" → ");
}

function groupDetails(members: DependencyVerdict[]): string[] {
  const names = members.map((v) => `\`${v.name}\``).join(", ");
  return [`<details><summary><b>${members.length} transitive dependencies</b>: ${escapeHtml(members[0]!.summary)}</summary>`, "", names, "", "</details>"];
}

function details(v: DependencyVerdict): string[] {
  const out = [`<details><summary><b>${escapeHtml(v.name)}</b>: ${escapeHtml(v.summary)}</summary>`, ""];
  for (const e of v.evidence) out.push(...evidence(e));
  for (const c of v.caveats) out.push(`- **caveat:** ${escapeHtml(c)}`);
  for (const n of v.notes) out.push(`- note: ${escapeHtml(n)}`);
  out.push("", "</details>");
  return out;
}

function evidence(e: Evidence): string[] {
  switch (e.kind) {
    case "call-site":
      return [
        `- \`${e.file}:${e.line}\` \`${inline(e.snippet)}\``,
        `  - changelog ${e.changelogVersion} (${e.matchConfidence} confidence): ${escapeHtml(e.changelogExcerpt)}`,
      ];
    case "bisect":
      return [
        `- bisected in ${e.installs} install${e.installs === 1 ? "" : "s"}: last good \`${e.lastGood}\`, ${e.exact ? "first bad" : "still failing at"} \`${e.firstBad}\``,
        ...(e.ambiguousWith.length ? [`  - untestable versions in that window: ${e.ambiguousWith.map((v) => `\`${v}\``).join(", ")}`] : []),
        ...codeBlock(e.failingOutput),
      ];
    case "test-failure":
      return [`- ${e.outcome}${e.bisectSkippedReason ? ` (${escapeHtml(e.bisectSkippedReason)})` : ""}`, ...codeBlock(e.output)];
    case "no-tests":
      return [`- ${escapeHtml(e.reason)}`];
  }
}

/** Fenced with more backticks than the longest run inside, so test output can't break out of it. */
function codeBlock(text: string): string[] {
  if (!text) return [];
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return ["", fence, text, fence];
}

function inline(text: string): string {
  return text.replace(/`/g, "'");
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clamp(markdown: string): string {
  if (markdown.length <= MAX_COMMENT_CHARS) return markdown;
  return `${markdown.slice(0, MAX_COMMENT_CHARS)}\n\n_(comment truncated; run ratchet with --report-dir for the full report)_`;
}
