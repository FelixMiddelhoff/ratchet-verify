import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { discoverWorkspaces } from "../workspaces/index.js";
import type { WorkspaceManifest } from "../lockfile/types.js";
import { resolveModuleFile, SpecifierResolver } from "./resolve.js";
import { analyzeSource, hasSyntaxErrors, scanSource, type Forward, type SourceAnalysis } from "./scan-source.js";
import type { UsageScan } from "./types.js";

export { scanSource };
export type * from "./types.js";

const SOURCE_FILE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
/** Vue/Svelte/Astro single-file components and MDX import packages too, but ratchet has no parser for them. */
const NOT_SCANNED_FILE = /\.(vue|svelte|astro|mdx)$/;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const CONFIG_FILE = /^(tsconfig[\w.-]*|jsconfig)\.json$/;

/**
 * Scans every source file under the project (all workspace packages included; only node_modules and .git are
 * skipped). Non-relative specifiers are resolved through tsconfig `paths`/`baseUrl` and workspace package names.
 */
export async function scanUsage(projectDir: string, packageName: string, workspaces?: WorkspaceManifest[]): Promise<UsageScan> {
  const scan: UsageScan = { sites: [], unparsed: [] };
  const unresolved: { file: string; reason: string }[] = [];
  const texts = new Map<string, string>();
  const listing = await listFiles(projectDir);
  for (const path of listing.sources) {
    const file = relative(projectDir, path).split(sep).join("/");
    const text = await readFile(path, "utf8");
    texts.set(file, text);
    if (hasSyntaxErrors(file, text)) scan.unparsed.push({ file });
  }
  const resolver = await SpecifierResolver.create(
    projectDir,
    texts,
    listing.configs.map((c) => relative(projectDir, c).split(sep).join("/")),
    workspaces ?? (await discoverWorkspaces(projectDir)),
  );
  unresolved.push(...resolver.configProblems());
  for (const path of listing.notScanned) unresolved.push({ file: relative(projectDir, path).split(sep).join("/"), reason: "file type not scanned" });
  for (const path of listing.links) unresolved.push({ file: relative(projectDir, path).split(sep).join("/"), reason: "symlinked directory not followed" });

  // Files that re-export the package (directly or via other project files) make their importers package users.
  // Iterate to a fixpoint so chains of own modules resolve; forwards only grow, so this terminates quickly.
  const forwards = new Map<string, Forward>();
  let results = new Map<string, SourceAnalysis>();
  let stable = false;
  for (let round = 0; round <= texts.size && !stable; round++) {
    stable = true;
    results = new Map();
    for (const [file, text] of texts) {
      const result = analyzeSource(file, text, packageName, {
        resolve: (specifier) => {
          const targets = resolveTargets(resolver, file, specifier, texts);
          return mergeForwards(targets.map((t) => forwards.get(t)));
        },
        unresolvable: (specifier) => {
          const r = resolver.resolve(file, specifier);
          return r && "unresolved" in r ? r.unresolved : undefined;
        },
        hasForwarders: forwards.size > 0,
      });
      results.set(file, result);
      if (serialize(forwards.get(file)) !== serialize(result.forward)) {
        stable = false;
        if (result.forward) forwards.set(file, result.forward);
        else forwards.delete(file);
      }
    }
  }

  for (const [file, result] of results) {
    scan.sites.push(...result.sites);
    for (const reason of result.unresolved) unresolved.push({ file, reason });
    if (!stable && result.forward) unresolved.push({ file, reason: "re-export chain did not stabilise" });
  }
  if (unresolved.length > 0) scan.unresolved = unresolved;
  scan.sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol));
  return scan;
}

function serialize(forward: Forward | undefined): string {
  return forward ? JSON.stringify([[...forward.exports].sort(), [...new Set(forward.stars)].sort()]) : "";
}

/** Project files a specifier loads: relative paths, then aliases/workspace packages. */
function resolveTargets(resolver: SpecifierResolver, fromFile: string, specifier: string, files: Map<string, string>): string[] {
  if (specifier.startsWith(".")) {
    const own = resolveModuleFile(posix.normalize(posix.join(posix.dirname(fromFile), specifier)), files);
    return own ? [own] : [];
  }
  const r = resolver.resolve(fromFile, specifier);
  return r && "files" in r ? r.files : [];
}

/** Union of what several candidate files forward (an alias can map to several targets). */
function mergeForwards(candidates: (Forward | undefined)[]): Forward | undefined {
  const present = candidates.filter((f): f is Forward => f !== undefined);
  if (present.length <= 1) return present[0];
  const merged: Forward = { exports: new Map(), stars: [] };
  for (const f of present) {
    for (const [k, v] of f.exports) if (!merged.exports.has(k)) merged.exports.set(k, v);
    merged.stars.push(...f.stars);
  }
  return merged;
}

interface Listing {
  sources: string[];
  configs: string[];
  /** Files that can import packages but are never parsed (single-file components, MDX). */
  notScanned: string[];
  /** Directory links (symlinks/junctions): not followed, so what is behind them was not scanned. */
  links: string[];
}

async function listFiles(dir: string): Promise<Listing> {
  const out: Listing = { sources: [], configs: [], notScanned: [], links: [] };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SKIPPED_DIRS.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) continue;
    if (entry.isSymbolicLink() && (await isDirectoryLink(path))) {
      out.links.push(path);
      continue;
    }
    if (entry.isDirectory()) {
      const inner = await listFiles(path);
      out.sources.push(...inner.sources);
      out.configs.push(...inner.configs);
      out.notScanned.push(...inner.notScanned);
      out.links.push(...inner.links);
    } else if (CONFIG_FILE.test(entry.name)) out.configs.push(path);
    else if (SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) out.sources.push(path);
    else if (NOT_SCANNED_FILE.test(entry.name)) out.notScanned.push(path);
  }
  return out;
}

async function isDirectoryLink(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false; // dangling link: nothing behind it
  }
}
