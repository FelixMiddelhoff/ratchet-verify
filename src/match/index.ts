import type { ChangelogEntry } from "../changelog/index.js";
import { compareVersions } from "../changelog/semver.js";
import type { UsageSite } from "../usage/index.js";
import { classifyLines, type ClassifiedLine } from "./classify.js";

export type Confidence = "high" | "medium" | "low";

export interface BreakingHit {
  confidence: Confidence;
  /** Why this was flagged, in words a reviewer can check against the excerpt. */
  reason: string;
  version: string;
  /** The changelog line that mentions the symbol. */
  excerpt: string;
  site: UsageSite;
}

export interface MatchResult {
  hits: BreakingHit[];
  /** The bump crosses a major version: breaking changes are allowed by semver even if unlisted. */
  majorBoundary: boolean;
  /** Any entry contained an explicit breaking-change section or marker. */
  hasBreakingSections: boolean;
}

export interface MatchInput {
  entries: ChangelogEntry[];
  sites: UsageSite[];
  oldVersion: string;
  newVersion: string;
}

const CONFIDENCE_ORDER: Confidence[] = ["high", "medium", "low"];
const SHORT_SYMBOL = 2;

/**
 * Silence is not a safety claim: an empty hit list only means nothing in the changelog text
 * named a symbol this codebase uses. Callers must also weigh `majorBoundary` and missing notes.
 */
export function matchBreakingChanges(input: MatchInput): MatchResult {
  const majorBoundary = majorOf(input.newVersion) > majorOf(input.oldVersion);
  const hits: BreakingHit[] = [];
  let hasBreakingSections = false;

  for (const entry of input.entries) {
    const lines = classifyLines(entry.body);
    if (lines.some((l) => l.explicit)) hasBreakingSections = true;
    const majorRelease = isMajorRelease(entry.version, input.oldVersion);

    for (const site of input.sites) {
      if (site.symbol === "*" || site.symbol === "default") continue;
      const hit = findMention(lines, site.symbol, majorRelease);
      if (hit) hits.push({ ...hit, version: entry.version, site });
    }
  }

  if (hasBreakingSections) hits.push(...wholeModuleHits(input, majorBoundary));
  hits.sort(byConfidenceThenVersion);
  return { hits, majorBoundary, hasBreakingSections };
}

function findMention(
  lines: ClassifiedLine[],
  symbol: string,
  majorRelease: boolean,
): Pick<BreakingHit, "confidence" | "reason" | "excerpt"> | undefined {
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
      weakMatch ??= line; // never dropped: a breaking line may really be about this symbol
    } else if (line.soft) softMatch ??= line;
    else if (!weak) majorMatch ??= line;
  }
  if (weakMatch) {
    return { confidence: "medium", reason: `common word "${symbol}" named in a breaking-change section without code-style evidence; may be about something else`, excerpt: weakMatch.text };
  }
  if (softMatch) return { confidence: "medium", reason: "named in a removal/rename/deprecation note", excerpt: softMatch.text };
  if (majorRelease && majorMatch) {
    return { confidence: "medium", reason: "named in a semver-major release", excerpt: majorMatch.text };
  }
  return undefined;
}

/** Sites that use the whole module can't be matched by name; flag them when breaking changes exist. */
function wholeModuleHits(input: MatchInput, majorBoundary: boolean): BreakingHit[] {
  const version = latest(input.entries);
  return input.sites
    .filter((s) => s.symbol === "*" || s.symbol === "default")
    .map((site) => ({
      confidence: "low" as const,
      reason: `${site.symbol === "*" ? "whole module" : "default export"} is used and the changelog lists breaking changes${majorBoundary ? " (major bump)" : ""}`,
      version,
      excerpt: "",
      site,
    }));
}

/** Identifier boundaries, not \b: `$` and `_` are word-ish in JS but not for \b. Short names need backticks. */
function mentionPattern(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (symbol.length <= SHORT_SYMBOL) return new RegExp("`[^`]*(?<![\\w$])" + escaped + "(?![\\w$])[^`]*`");
  return new RegExp("(?<![\\w$])" + escaped + "(?![\\w$])");
}

/**
 * Words so common in prose that a bare mention is weak evidence. Code-style evidence (backticks,
 * `.word`, `word(`) keeps full strength; without it confidence is capped, never dropped.
 */
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

/** x.0.0 releases past the old major carry the deliberate breaking changes. */
function isMajorRelease(version: string, oldVersion: string): boolean {
  return /^\d+\.0\.0/.test(version) && majorOf(version) > majorOf(oldVersion);
}

function latest(entries: ChangelogEntry[]): string {
  return entries.map((e) => e.version).sort(compareVersions).at(-1) ?? "";
}

function byConfidenceThenVersion(a: BreakingHit, b: BreakingHit): number {
  const byConfidence = CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence);
  return byConfidence || compareVersions(b.version, a.version);
}
