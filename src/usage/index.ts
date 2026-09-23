import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { hasSyntaxErrors, scanSource } from "./scan-source.js";
import type { UsageScan } from "./types.js";

export { scanSource };
export type * from "./types.js";

const SOURCE_FILE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

export async function scanUsage(projectDir: string, packageName: string): Promise<UsageScan> {
  const scan: UsageScan = { sites: [], unparsed: [] };
  for (const path of await listSourceFiles(projectDir)) {
    const file = relative(projectDir, path).split(sep).join("/");
    const text = await readFile(path, "utf8");
    if (hasSyntaxErrors(file, text)) scan.unparsed.push({ file });
    scan.sites.push(...scanSource(file, text, packageName));
  }
  scan.sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol));
  return scan;
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
