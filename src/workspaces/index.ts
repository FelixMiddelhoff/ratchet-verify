import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { RootManifest, WorkspaceManifest } from "../lockfile/types.js";

export type { WorkspaceManifest };

export interface Discovery {
  workspaces: WorkspaceManifest[];
  /** Things a human should know: ignored patterns, an empty pnpm-workspace.yaml. */
  notes: string[];
}

/** Workspace patterns split into includes and excludes, already normalised; `notes` explains every dropped pattern. */
export interface PatternSet {
  include: string[];
  exclude: string[];
  notes: string[];
}

/**
 * Workspace packages of a project: package.json `workspaces` (npm, yarn classic and berry; array or
 * `{ packages }`) and `pnpm-workspace.yaml` `packages:`. Patterns support literal directories, `*` inside a
 * segment and `**`; `!pattern` excludes. Directories without a package.json are not workspaces. Patterns that
 * leave the project (`..`, absolute paths, drive letters) and directories whose real path is outside it
 * are ignored: a manifest ratchet reads (and later copies into a sandbox) must belong to the project.
 */
export async function discoverWorkspaces(projectDir: string): Promise<WorkspaceManifest[]> {
  return (await discoverWorkspacesDetailed(projectDir)).workspaces;
}

export async function discoverWorkspacesDetailed(projectDir: string): Promise<Discovery> {
  const rootManifest = await readManifest(projectDir);
  const pnpm = await readPnpmYaml(projectDir);
  const set = buildPatternSet([...manifestPatternsOf(rootManifest), ...(pnpm?.patterns ?? [])]);
  const notes = [...set.notes];
  if (pnpm && !pnpm.explicitEmpty && pnpm.patterns.length === 0) notes.push("pnpm-workspace.yaml lists no workspace packages (no readable `packages:` list): no workspaces were detected from it");
  if (set.include.length === 0) return { workspaces: [], notes };

  const dirs = new Set<string>();
  for (const pattern of set.include) for (const dir of await expand(projectDir, collapseGlobstars(pattern.split("/").filter(Boolean)))) dirs.add(dir);

  const excludes = set.exclude.map((e) => e.split("/").filter(Boolean));
  const realRoot = await realpath(projectDir).catch(() => projectDir);
  const found: WorkspaceManifest[] = [];
  for (const dir of [...dirs].sort()) {
    if (dir === "" || dir.split("/").some((s) => s === "node_modules" || s === ".git") || excludes.some((e) => matchesPattern(e, dir.split("/")))) continue;
    if (!(await insideProject(realRoot, join(projectDir, dir)))) {
      notes.push(`ignored workspace directory "${dir}": its real path is outside the project`);
      continue;
    }
    const manifest = await readManifest(join(projectDir, dir));
    if (!manifest) continue;
    const named = typeof manifest.name === "string";
    found.push({ name: named ? (manifest.name as string) : dir, dir, ...(named ? {} : { unnamed: true }), manifest: toDeps(manifest) });
  }
  return { workspaces: found, notes };
}

/** Workspace patterns as the sandbox-relevant sets: what the given (old) manifest texts declare. */
export function patternsFromTexts(packageJsonText: string | undefined, pnpmYamlText: string | undefined): { patterns: string[]; pnpmEmptyUnexpected: boolean } {
  let manifest: Record<string, unknown> | undefined;
  try {
    manifest = packageJsonText === undefined ? undefined : (JSON.parse(packageJsonText) as Record<string, unknown>);
  } catch {
    manifest = undefined;
  }
  const pnpm = pnpmYamlText === undefined ? undefined : parsePnpmWorkspaceYaml(pnpmYamlText);
  return { patterns: [...manifestPatternsOf(manifest), ...(pnpm?.patterns ?? [])], pnpmEmptyUnexpected: !!pnpm && !pnpm.explicitEmpty && pnpm.patterns.length === 0 };
}

/** Which of `candidateDirs` (project-relative, forward slashes, each holding a package.json) the patterns select. */
export function selectWorkspaceDirs(rawPatterns: string[], candidateDirs: string[]): { dirs: string[]; notes: string[] } {
  const set = buildPatternSet(rawPatterns);
  const includes = set.include.map((p) => collapseGlobstars(p.split("/").filter(Boolean)));
  const excludes = set.exclude.map((p) => collapseGlobstars(p.split("/").filter(Boolean)));
  const dirs = candidateDirs
    .filter((d) => d !== "" && !d.split("/").some((s) => s === "node_modules" || s === ".git"))
    .filter((d) => includes.some((i) => matchesPattern(i, d.split("/"))) && !excludes.some((e) => matchesPattern(e, d.split("/"))));
  return { dirs: [...new Set(dirs)].sort(), notes: set.notes };
}

function buildPatternSet(raw: string[]): PatternSet {
  const set: PatternSet = { include: [], exclude: [], notes: [] };
  for (const original of raw) {
    const negated = original.startsWith("!");
    const pattern = normalize(negated ? original.slice(1) : original);
    const problem = patternProblem(pattern);
    if (problem) {
      set.notes.push(`ignored workspace pattern "${original}": ${problem}`);
      continue;
    }
    (negated ? set.exclude : set.include).push(pattern);
  }
  return set;
}

function patternProblem(pattern: string): string | undefined {
  if (pattern.startsWith("/") || /^[a-zA-Z]:/.test(pattern)) return "absolute paths are not workspace patterns";
  if (pattern.split("/").includes("..")) return "`..` leaves the project";
  return undefined;
}

function normalize(pattern: string): string {
  return pattern.trim().replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

async function insideProject(realRoot: string, path: string): Promise<boolean> {
  try {
    const rel = relative(realRoot, await realpath(path));
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    return true; // does not exist: nothing to read, nothing to leak
  }
}

function manifestPatternsOf(manifest: Record<string, unknown> | undefined): string[] {
  const ws = manifest?.workspaces;
  const list = Array.isArray(ws) ? ws : ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
  return list.filter((p): p is string => typeof p === "string");
}

async function readPnpmYaml(projectDir: string): Promise<ReturnType<typeof parsePnpmWorkspaceYaml> | undefined> {
  try {
    return parsePnpmWorkspaceYaml(await readFile(join(projectDir, "pnpm-workspace.yaml"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * `packages:` of pnpm-workspace.yaml: block list (items indented or at column 0), flow list on one or several
 * lines, quotes (a quoted item may contain commas and `#`), trailing comments. The file is tiny, so a line reader is enough.
 */
export function parsePnpmWorkspaceYaml(text: string): { patterns: string[]; explicitEmpty: boolean } {
  const patterns: string[] = [];
  let explicitEmpty = false;
  let inBlock = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const key = /^packages\s*:(.*)$/.exec(line);
    if (key) {
      inBlock = false;
      const rest = stripComment(key[1]!).trim();
      if (rest.startsWith("[")) {
        let flow = rest;
        while (!flowClosed(flow) && i + 1 < lines.length) flow += ` ${stripComment(lines[++i]!).trim()}`;
        const items = splitFlow(flow);
        if (items.length === 0) explicitEmpty = true;
        patterns.push(...items);
      } else if (rest === "") inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s*-(?:\s+(.*))?$/.exec(line);
    if (item) {
      const value = parseScalar(item[1] ?? "");
      if (value) patterns.push(value);
    } else if (/^\S/.test(line)) inBlock = false; // next top-level key
  }
  return { patterns, explicitEmpty };
}

function stripComment(value: string): string {
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(value[i - 1]!))) return value.slice(0, i);
  }
  return value;
}

function flowClosed(flow: string): boolean {
  let quote = "";
  for (const c of flow) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "]") return true;
  }
  return false;
}

function splitFlow(flow: string): string[] {
  const start = flow.indexOf("[");
  const items: string[] = [];
  let current = "";
  let quote = "";
  for (let i = start + 1; i < flow.length; i++) {
    const c = flow[i]!;
    if (quote) {
      current += c;
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === "]") break;
    else if (c === ",") {
      items.push(current);
      current = "";
    } else current += c;
  }
  items.push(current);
  return items.map(parseScalar).filter(Boolean);
}

function parseScalar(value: string): string {
  const v = value.trim();
  const q = v[0];
  if (q === "'" || q === '"') {
    const close = v.indexOf(q, 1);
    return close === -1 ? v.slice(1) : v.slice(1, close);
  }
  return stripComment(v).trim();
}

async function readManifest(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toDeps(m: Record<string, unknown>): RootManifest {
  const pick = (key: string): Record<string, string> | undefined => (m[key] && typeof m[key] === "object" ? (m[key] as Record<string, string>) : undefined);
  return { dependencies: pick("dependencies"), devDependencies: pick("devDependencies"), optionalDependencies: pick("optionalDependencies"), peerDependencies: pick("peerDependencies") };
}

/** Consecutive `**` match exactly what one does; collapsing them keeps the walk polynomial. */
function collapseGlobstars(segments: string[]): string[] {
  return segments.filter((s, i) => !(s === "**" && segments[i - 1] === "**"));
}

/** Directories (relative, forward slashes) under the root matching the pattern segments; memoised per (segment, directory). */
async function expand(root: string, segments: string[]): Promise<string[]> {
  const memo = new Map<string, Promise<string[]>>();
  const walk = (i: number, base: string): Promise<string[]> => {
    const key = `${i}\0${base}`;
    let hit = memo.get(key);
    if (!hit) {
      hit = step(i, base);
      memo.set(key, hit);
    }
    return hit;
  };
  const child = (base: string, d: string): string => (base ? `${base}/${d}` : d);
  const step = async (i: number, base: string): Promise<string[]> => {
    if (i === segments.length) return [base];
    const head = segments[i]!;
    if (head === "**") {
      const here = await walk(i + 1, base);
      const nested = await Promise.all((await subdirs(root, base)).map((d) => walk(i, child(base, d))));
      return [...here, ...nested.flat()];
    }
    if (!/[*?]/.test(head)) return walk(i + 1, child(base, head));
    const re = segmentRegex(head);
    const matches = (await subdirs(root, base)).filter((d) => re.test(d));
    return (await Promise.all(matches.map((d) => walk(i + 1, child(base, d))))).flat();
  };
  return [...new Set(await walk(0, ""))];
}

async function subdirs(root: string, base: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, base), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name !== "node_modules" && e.name !== ".git").map((e) => e.name);
  } catch {
    return [];
  }
}

function segmentRegex(segment: string): RegExp {
  return new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
}

function matchesPattern(rawPattern: string[], parts: string[]): boolean {
  const pattern = collapseGlobstars(rawPattern);
  const regexes = pattern.map((s) => (s === "**" ? undefined : segmentRegex(s)));
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (parts.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === pattern.length) result = j === parts.length;
    else if (pattern[i] === "**") result = go(i + 1, j) || (j < parts.length && go(i, j + 1));
    else result = j < parts.length && regexes[i]!.test(parts[j]!) && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** Directory of the workspace that contains `file` (longest match), if any. */
export function workspaceOfFile(file: string, workspaces: WorkspaceManifest[]): WorkspaceManifest | undefined {
  return workspaces.filter((w) => file.startsWith(`${w.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
}
