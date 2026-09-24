import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { analyzeSource, hasSyntaxErrors, scanSource, type Forward, type SourceAnalysis } from "./scan-source.js";
import type { UsageScan } from "./types.js";

export { scanSource };
export type * from "./types.js";

const SOURCE_FILE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export async function scanUsage(projectDir: string, packageName: string): Promise<UsageScan> {
  const scan: UsageScan = { sites: [], unparsed: [] };
  const unresolved: { file: string; reason: string }[] = [];
  const texts = new Map<string, string>();
  for (const path of await listSourceFiles(projectDir)) {
    const file = relative(projectDir, path).split(sep).join("/");
    const text = await readFile(path, "utf8");
    texts.set(file, text);
    if (hasSyntaxErrors(file, text)) scan.unparsed.push({ file });
  }

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
          const target = resolveOwnModule(file, specifier, texts);
          return target ? forwards.get(target) : undefined;
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

/** Project file a relative specifier points at (extension/index/ESM-`.js`-for-`.ts` conventions), if any. */
function resolveOwnModule(fromFile: string, specifier: string, files: Map<string, string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const stem = base.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => stem + e), ...EXTENSIONS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => files.has(c));
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...(await listSourceFiles(path)));
    } else if (SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}
