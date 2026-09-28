import type { PythonDependencyVerdict, PythonReport } from "./report.js";

export function renderPythonJson(report: PythonReport): string {
  return JSON.stringify(report, null, 2);
}

/** The SARIF 2.1.0 subset GitHub code scanning reads: tool.driver, rules, results with locations. Ported from src/report/sarif.ts (same rule set, "package.json" fallback location swapped for "pyproject.toml"). */
interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[];
}

const SARIF_RULES = [
  { id: "ratchet/broken", name: "BrokenDependencyBump", shortDescription: { text: "Tests fail after this dependency bump" } },
  { id: "ratchet/risky", name: "RiskyDependencyBump", shortDescription: { text: "Changelog names a breaking change that touches your code, or the bump could not be verified" } },
  { id: "ratchet/partial", name: "PartialSafeVerdict", shortDescription: { text: "Tests pass, but some signals could not be evaluated" } },
];

export function renderPythonSarif(report: PythonReport): string {
  const results = report.verdicts.flatMap(sarifResultsFor);
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "ratchet-python", rules: SARIF_RULES } }, results }],
  };
  return JSON.stringify(sarif, null, 2);
}

function sarifResultsFor(v: PythonDependencyVerdict): SarifResult[] {
  const title = `${v.name} ${[v.oldVersion, v.newVersion].filter(Boolean).join(" -> ")}`;
  if (v.status === "broken") return [sarifResult("ratchet/broken", "error", `${title}: ${v.summary}`, "pyproject.toml", 1)];

  if (v.status === "risky") {
    const sites = v.evidence.flatMap((e) => (e.kind === "call-site" ? [e] : []));
    if (sites.length === 0) return [sarifResult("ratchet/risky", "warning", `${title}: ${v.summary}`, "pyproject.toml", 1)];
    return sites.map((s) => sarifResult("ratchet/risky", "warning", `${title}: ${s.symbol} — changelog ${s.changelogVersion}: ${s.changelogExcerpt}`, s.file, s.line));
  }
  return v.confidence === "reduced" ? [sarifResult("ratchet/partial", "note", `${title}: ${v.summary}`, "pyproject.toml", 1)] : [];
}

function sarifResult(ruleId: string, level: SarifResult["level"], text: string, uri: string, startLine: number): SarifResult {
  return { ruleId, level, message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }] };
}

/** Text renderer for a PythonReport. */
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
      else if (e.kind === "call-site") lines.push(`  evidence: ${e.file}:${e.line} ${e.symbol} — ${e.reason} (${e.changelogVersion})`);
      else lines.push(`  evidence: ${e.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
