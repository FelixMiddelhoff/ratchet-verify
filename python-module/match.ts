/**
 * v2 item 1: breaking-change matcher, cross-referencing changelog text against usage sites
 * (phase 4's usage.ts, wired into the pipeline for the first time here). Reuses
 * `classifyLines`/`ClassifiedLine` from src/match/classify.ts directly — that module is pure
 * markdown-text classification with no npm-specific types, so no fork was needed there. The
 * symbol-matching logic below (mentionPattern, COMMON_WORDS, confidence rules) is ported from
 * src/match/index.ts: identical text-matching behavior, adapted to PythonUsageSite's shape
 * (kind: "import" | "from-import", no JS-style default-export/subpath-masking concepts).
 * "import pkg" sites carry no member info (the scanner doesn't follow attribute access), so
 * they are treated the same way JS's whole-module (`import * as x`) sites are: low-confidence,
 * flagged only when the changelog has an explicit breaking section.
 */
import type { PythonChangelogEntry } from "./changelog.js";
import { classifyLines, type ClassifiedLine } from "../src/match/classify.js";
import { compareVersions } from "./version.js";
import type { PythonUsageSite } from "./usage.js";

export type PythonConfidence = "high" | "medium" | "low";

export interface PythonBreakingHit {
  confidence: PythonConfidence;
  reason: string;
  version: string;
  excerpt: string;
  site: PythonUsageSite;
}

export interface PythonMatchResult {
  hits: PythonBreakingHit[];
  /** The bump crosses a major version: breaking changes are allowed even if unlisted. */
  majorBoundary: boolean;
  hasBreakingSections: boolean;
}

export interface PythonMatchInput {
  entries: PythonChangelogEntry[];
  sites: PythonUsageSite[];
  oldVersion: string;
  newVersion: string;
}

const CONFIDENCE_ORDER: PythonConfidence[] = ["high", "medium", "low"];
const SHORT_SYMBOL = 2;

/**
 * Silence is not a safety claim: an empty hit list only means nothing in the changelog text
 * named a symbol this codebase imports. Callers must also weigh `majorBoundary` and missing notes.
 */
export function matchPythonBreakingChanges(input: PythonMatchInput): PythonMatchResult {
  const majorBoundary = majorOf(input.newVersion) > majorOf(input.oldVersion);
  const hits: PythonBreakingHit[] = [];
  let hasBreakingSections = false;

  for (const entry of input.entries) {
    const lines = classifyLines(entry.body);
    if (lines.some((l) => l.explicit)) hasBreakingSections = true;
    const majorRelease = isMajorRelease(entry.version, input.oldVersion);

    for (const site of input.sites) {
      if (site.kind !== "from-import") continue; // "import pkg" sites carry no symbol to match by name
      const hit = findMention(lines, site.symbol, majorRelease);
      if (hit) hits.push({ ...hit, version: entry.version, site });
    }
  }

  if (hasBreakingSections) hits.push(...wholeModuleHits(input, majorBoundary));
  hits.sort(byConfidenceThenVersion);
  return { hits, majorBoundary, hasBreakingSections };
}

function findMention(lines: ClassifiedLine[], symbol: string, majorRelease: boolean): Pick<PythonBreakingHit, "confidence" | "reason" | "excerpt"> | undefined {
  const mention = mentionPattern(symbol);
  const common = COMMON_WORDS.has(symbol.toLowerCase());
  const strong = common ? strongPattern(symbol) : undefined;
  let softMatch: ClassifiedLine | undefined;
  let majorMatch: ClassifiedLine | undefined;
  let weakMatch: ClassifiedLine | undefined;

  for (const line of lines) {
    if (!mention.test(line.text)) continue;
    const weak = strong !== undefined && !strong.test(line.text);
    if (line.explicit && !weak) return { confidence: "high", reason: "named in a breaking-change section", excerpt: line.text };
    if (line.explicit) {
      weakMatch ??= line;
    } else if (line.soft) softMatch ??= line;
    else if (!weak) majorMatch ??= line;
  }
  if (weakMatch) {
    return { confidence: "medium", reason: `common word "${symbol}" named in a breaking-change section without code-style evidence; may be about something else`, excerpt: weakMatch.text };
  }
  if (softMatch) return { confidence: "medium", reason: "named in a removal/rename/deprecation note", excerpt: softMatch.text };
  if (majorRelease && majorMatch) return { confidence: "medium", reason: "named in a semver-major release", excerpt: majorMatch.text };
  return undefined;
}

/** "import pkg" sites use the whole module; can't be matched by name, so flag them when breaking changes exist. */
function wholeModuleHits(input: PythonMatchInput, majorBoundary: boolean): PythonBreakingHit[] {
  const version = latest(input.entries);
  return input.sites
    .filter((s) => s.kind === "import")
    .map((site) => ({
      confidence: "low" as const,
      reason: `whole module is imported and the changelog lists breaking changes${majorBoundary ? " (major bump)" : ""}`,
      version,
      excerpt: "",
      site,
    }));
}

function mentionPattern(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (symbol.length <= SHORT_SYMBOL) return new RegExp("`[^`]*(?<![\\w$])" + escaped + "(?![\\w$])[^`]*`");
  return new RegExp("(?<![\\w$])" + escaped + "(?![\\w$])");
}

const COMMON_WORDS = new Set([
  "option", "options", "parse", "get", "set", "add", "remove", "use", "run", "create", "default", "value",
  "name", "type", "help", "action", "command", "error", "format", "load", "read", "write", "start", "stop",
  "then", "map", "filter", "list", "key", "keys", "data", "config", "version", "path", "file", "init", "on", "emit",
]);

function strongPattern(symbol: string): RegExp {
  const e = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const id = "(?<![\\w$])" + e + "(?![\\w$])";
  return new RegExp("`[^`]*" + id + "[^`]*`|\\." + e + "(?![\\w$])|(?<![\\w$])" + e + "\\(");
}

function majorOf(version: string): number {
  return Number(version.split(".")[0]!.replace(/\D/g, ""));
}

function isMajorRelease(version: string, oldVersion: string): boolean {
  return /^\d+\.0\.0/.test(version) && majorOf(version) > majorOf(oldVersion);
}

function latest(entries: PythonChangelogEntry[]): string {
  return entries.map((e) => e.version).sort(compareVersions).at(-1) ?? "";
}

function byConfidenceThenVersion(a: PythonBreakingHit, b: PythonBreakingHit): number {
  const byConfidence = CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence);
  return byConfidence || compareVersions(b.version, a.version);
}
