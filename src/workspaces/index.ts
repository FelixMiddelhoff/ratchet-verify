import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RootManifest, WorkspaceManifest } from "../lockfile/types.js";

export type { WorkspaceManifest };

/**
 * Workspace packages of a project: package.json `workspaces` (npm, yarn classic and berry; array or
 * `{ packages }`) and `pnpm-workspace.yaml` `packages:`. Patterns support literal directories, `*` inside a
 * segment and `**`; `!pattern` excludes. Directories without a package.json are not workspaces.
 */
export async function discoverWorkspaces(projectDir: string): Promise<WorkspaceManifest[]> {
  const patterns = [...(await manifestPatterns(projectDir)), ...(await pnpmPatterns(projectDir))];
  if (patterns.length === 0) return [];
  const include = patterns.filter((p) => !p.startsWith("!")).map(normalize);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => normalize(p.slice(1)));

  const dirs = new Set<string>();
  for (const pattern of include) for (const dir of await expand(projectDir, pattern.split("/").filter(Boolean), "")) dirs.add(dir);

  const found: WorkspaceManifest[] = [];
  for (const dir of [...dirs].sort()) {
    if (dir === "" || exclude.some((e) => matchesPattern(e.split("/").filter(Boolean), dir.split("/")))) continue;
    const manifest = await readManifest(join(projectDir, dir));
    if (manifest) found.push({ name: typeof manifest.name === "string" ? manifest.name : dir, dir, manifest: toDeps(manifest) });
  }
  return found;
}

function normalize(pattern: string): string {
  return pattern.replace(/^\.\//, "").replace(/\/+$/, "");
}

async function manifestPatterns(projectDir: string): Promise<string[]> {
  const manifest = await readManifest(projectDir);
  const ws = manifest?.workspaces;
  const list = Array.isArray(ws) ? ws : ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
  return list.filter((p): p is string => typeof p === "string");
}

/** `packages:` list of pnpm-workspace.yaml (`- 'apps/*'`); the file is tiny, so a line reader is enough. */
async function pnpmPatterns(projectDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(projectDir, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      const inline = /^packages\s*:\s*\[(.*)\]/.exec(line);
      if (inline) patterns.push(...inline[1]!.split(",").map(unquote).filter(Boolean));
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) inPackages = false; // next top-level key
    else {
      const item = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(line);
      if (item) patterns.push(unquote(item[1]!));
    }
  }
  return patterns;
}

function unquote(value: string): string {
  const v = value.trim();
  return (v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')) ? v.slice(1, -1) : v;
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

/** Directories (relative, forward slashes) under `base` matching the remaining pattern segments. */
async function expand(root: string, segments: string[], base: string): Promise<string[]> {
  if (segments.length === 0) return [base];
  const [head, ...rest] = segments as [string, ...string[]];
  if (head === "**") {
    const here = await expand(root, rest, base);
    const nested = await Promise.all((await subdirs(root, base)).map((d) => expand(root, segments, base ? `${base}/${d}` : d)));
    return [...here, ...nested.flat()];
  }
  if (!/[*?]/.test(head)) return expand(root, rest, base ? `${base}/${head}` : head);
  const re = segmentRegex(head);
  const matches = (await subdirs(root, base)).filter((d) => re.test(d));
  return (await Promise.all(matches.map((d) => expand(root, rest, base ? `${base}/${d}` : d)))).flat();
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

function matchesPattern(pattern: string[], parts: string[]): boolean {
  if (pattern.length === 0) return parts.length === 0;
  const [head, ...rest] = pattern as [string, ...string[]];
  if (head === "**") return matchesPattern(rest, parts) || (parts.length > 0 && matchesPattern(pattern, parts.slice(1)));
  return parts.length > 0 && segmentRegex(head).test(parts[0]!) && matchesPattern(rest, parts.slice(1));
}

/** Directory of the workspace that contains `file` (longest match), if any. */
export function workspaceOfFile(file: string, workspaces: WorkspaceManifest[]): WorkspaceManifest | undefined {
  return workspaces.filter((w) => file.startsWith(`${w.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
}
