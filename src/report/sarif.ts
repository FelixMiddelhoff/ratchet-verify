import type { DependencyVerdict, Report } from "./types.js";

/** The SARIF 2.1.0 subset GitHub code scanning reads: tool.driver, rules, results with locations. */
interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[];
}

const RULES = [
  { id: "ratchet/broken", name: "BrokenDependencyBump", shortDescription: { text: "Tests fail after this dependency bump" } },
  { id: "ratchet/risky", name: "RiskyDependencyBump", shortDescription: { text: "Changelog names a breaking change that touches your code, or the bump could not be verified" } },
  { id: "ratchet/partial", name: "PartialSafeVerdict", shortDescription: { text: "Tests pass, but some signals could not be evaluated" } },
];

export function renderSarif(report: Report): string {
  const results = report.verdicts.flatMap(resultsFor);
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "ratchet", rules: RULES } }, results }],
  };
  return JSON.stringify(sarif, null, 2);
}

function resultsFor(v: DependencyVerdict): SarifResult[] {
  const title = `${v.name} ${[v.oldVersion, v.newVersion].filter(Boolean).join(" -> ")}`;
  if (v.status === "broken") return [result("ratchet/broken", "error", `${title}: ${v.summary}`, "package.json", 1)];

  if (v.status === "risky") {
    const sites = v.evidence.flatMap((e) => (e.kind === "call-site" ? [e] : []));
    if (sites.length === 0) return [result("ratchet/risky", "warning", `${title}: ${v.summary}`, "package.json", 1)];
    // One result per call site so code scanning annotates the exact line.
    return sites.map((s) =>
      result("ratchet/risky", "warning", `${title}: ${s.symbol} — changelog ${s.changelogVersion}: ${s.changelogExcerpt}`, s.file, s.line),
    );
  }
  return v.confidence === "reduced" ? [result("ratchet/partial", "note", `${title}: ${v.summary}`, "package.json", 1)] : [];
}

function result(ruleId: string, level: SarifResult["level"], text: string, uri: string, startLine: number): SarifResult {
  return { ruleId, level, message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }] };
}
