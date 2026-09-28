import type { PythonReport } from "./report.js";

/** Text renderer for a PythonReport. JSON/SARIF renderers are a documented follow-up (python-module/README.md). */
export function renderPythonText(report: PythonReport): string {
  if (report.verdicts.length === 0) return "ratchet: no dependency changes between the two lockfiles.";
  const lines = [`ratchet: overall ${report.overall}`, ""];
  for (const v of report.verdicts) {
    const range = v.oldVersion && v.newVersion ? `${v.oldVersion} -> ${v.newVersion}` : (v.newVersion ?? v.oldVersion ?? "");
    lines.push(`${v.name} (${range}): ${v.status.toUpperCase()} — ${v.summary}`);
    for (const c of v.caveats) lines.push(`  caveat: ${c}`);
    for (const n of v.notes) lines.push(`  note: ${n}`);
    for (const e of v.evidence) {
      if (e.kind === "bisect") lines.push(`  evidence: broke between ${e.lastGood} and ${e.firstBad}${e.exact ? " (exact)" : " (narrowed)"}${e.unconfirmed ? ", unconfirmed" : ""}`);
      else if (e.kind === "test-failure") lines.push(`  evidence: ${e.outcome}`);
      else lines.push(`  evidence: ${e.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
