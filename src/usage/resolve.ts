import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { WorkspaceManifest } from "../lockfile/types.js";

export const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const NON_CODE = /\.(json|css|scss|sass|less|svg|png|jpe?g|gif|webp|md|html|node|wasm|txt|ico|woff2?)$/i;

/** Project file a module path (no extension needed; ESM `.js`-for-`.ts`; `index` files) points at, if any. */
export function resolveModuleFile(base: string, files: { has(file: string): boolean }): string | undefined {
  const stem = base.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => stem + e), ...EXTENSIONS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => files.has(c));
}

/** `{ files }`: project files the specifier can load. `{ unresolved }`: it may load project code that was not found. undefined: an external package. */
export type Resolution = { files: string[] } | { unresolved: string } | undefined;

/** tsconfig options that decide how non-relative specifiers map to project files, `extends` already applied. */
interface ModuleOptions {
  /** Project-relative directory of the tsconfig (the scope it applies to). */
  scope: string;
  /** Project-relative absolute-ish baseUrl directory. */
  baseUrl?: string;
  paths?: Record<string, string[]>;
  /** Directory `paths` targets are relative to: baseUrl when set, else the config that declared `paths`. */
  pathsBase?: string;
  /** Why the config could not be fully read; path aliases it defines are then unknown. */
  problem?: string;
}

/**
 * Resolves non-relative specifiers to project files: tsconfig/jsconfig `compilerOptions.paths` and `baseUrl`
 * (with `extends`, JSONC comments and trailing commas via the TypeScript API), and workspace package names.
 * Anything that may point at project code but cannot be located is reported, never dropped.
 */
export class SpecifierResolver {
  private readonly manifests = new Map<string, Record<string, unknown> | undefined>();

  private constructor(
    private readonly projectDir: string,
    private readonly files: Map<string, string>,
    private readonly options: ModuleOptions[],
    private readonly workspaces: WorkspaceManifest[],
  ) {}

  static async create(projectDir: string, files: Map<string, string>, configFiles: string[], workspaces: WorkspaceManifest[]): Promise<SpecifierResolver> {
    const options: ModuleOptions[] = [];
    for (const config of configFiles) options.push(await loadOptions(projectDir, config));
    return new SpecifierResolver(projectDir, files, options, workspaces);
  }

  /** Configs that could not be read completely: alias definitions may be missing, so this is an unresolved caveat by itself. */
  configProblems(): { file: string; reason: string }[] {
    return this.options.filter((o) => o.problem).map((o) => ({ file: o.scope === "" ? "tsconfig" : `${o.scope}/tsconfig`, reason: o.problem! }));
  }

  resolve(fromFile: string, specifier: string): Resolution {
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || specifier === "") return undefined;
    const found = new Set<string>();
    const missing: string[] = [];

    if (specifier.startsWith("#")) missing.push(`package.json "imports" specifier ${specifier} is not resolved`);

    const fromDir = posix.dirname(fromFile);
    for (const o of this.options) {
      if (o.scope !== "" && fromDir !== o.scope && !fromDir.startsWith(`${o.scope}/`)) continue;
      const viaPaths = this.viaPaths(o, specifier);
      if (viaPaths) {
        for (const f of viaPaths.files) found.add(f);
        if (viaPaths.files.length === 0 && viaPaths.checked) missing.push(`path alias ${specifier} matched a tsconfig \`paths\` entry but no scanned source file`);
      } else if (o.baseUrl !== undefined) {
        const hit = resolveModuleFile(posix.normalize(posix.join(o.baseUrl, specifier)), this.files);
        if (hit) found.add(hit);
      }
    }

    const ws = this.workspaceFor(specifier);
    if (ws) {
      const hits = this.workspaceFiles(ws.workspace, ws.subpath);
      if (hits === "ignore") {
        // not code (e.g. package.json, css)
      } else if (hits.length > 0) for (const f of hits) found.add(f);
      else missing.push(`workspace package ${specifier} resolves to ${ws.workspace.dir}, but its entry file was not found among scanned sources`);
    }

    if (found.size > 0) return { files: [...found] };
    if (missing.length > 0) return { unresolved: missing[0]! };
    return undefined;
  }

  private viaPaths(o: ModuleOptions, specifier: string): { files: string[]; checked: boolean } | undefined {
    if (!o.paths) return undefined;
    const index = pathsIndex(o.paths);
    if (index.exact.has(specifier)) return this.tryTargets(o, o.paths[specifier]!, "");
    // TypeScript: the wildcard key with the longest matching prefix wins. Probe the specifier's prefixes longest first.
    for (let len = specifier.length; len >= 0; len--) {
      for (const { key, suffix } of index.wild.get(specifier.slice(0, len)) ?? []) {
        if (specifier.length >= len + suffix.length && specifier.endsWith(suffix)) return this.tryTargets(o, o.paths[key]!, specifier.slice(len, specifier.length - suffix.length));
      }
    }
    return undefined;
  }

  private tryTargets(o: ModuleOptions, targets: string[], star: string): { files: string[]; checked: boolean } {
    const files: string[] = [];
    let checked = false;
    for (const target of targets) {
      const substituted = target.replace("*", star);
      if (NON_CODE.test(substituted)) continue; // json/css aliases carry no code
      checked = true;
      const hit = resolveModuleFile(posix.normalize(posix.join(o.pathsBase ?? o.scope, substituted)), this.files);
      if (hit) files.push(hit);
    }
    return { files, checked };
  }

  private workspaceFor(specifier: string): { workspace: WorkspaceManifest; subpath: string } | undefined {
    for (const w of this.workspaces) {
      if (specifier === w.name) return { workspace: w, subpath: "." };
      if (specifier.startsWith(`${w.name}/`)) return { workspace: w, subpath: `./${specifier.slice(w.name.length + 1)}` };
    }
    return undefined;
  }

  /** Source files a workspace package entry (`.`) or subpath (`./x`) can load; "ignore" for non-code. */
  private workspaceFiles(w: WorkspaceManifest, subpath: string): string[] | "ignore" {
    if (subpath !== "." && NON_CODE.test(subpath)) return "ignore";
    const manifest = this.manifest(w.dir);
    const targets = new Set<string>();
    const exportsField = manifest?.exports;
    if (exportsField !== undefined) for (const t of exportTargets(exportsField, subpath)) targets.add(t);
    if (subpath === ".") {
      for (const key of ["module", "main"]) if (typeof manifest?.[key] === "string") targets.add(manifest[key] as string);
    } else {
      targets.add(subpath);
      targets.add(`./src/${subpath.slice(2)}`);
    }

    const hits = new Set<string>();
    for (const t of targets) {
      const rel = t.replace(/^\.\//, "");
      for (const variant of [rel, rel.replace(/^(dist|lib|build|out)\//, "src/")]) {
        const hit = resolveModuleFile(posix.normalize(posix.join(w.dir, variant)), this.files);
        if (hit) hits.add(hit);
      }
    }
    if (hits.size === 0 && subpath === ".") {
      for (const fallback of ["src/index", "index"]) {
        const hit = resolveModuleFile(posix.join(w.dir, fallback), this.files);
        if (hit) hits.add(hit);
      }
    }
    return [...hits];
  }

  private manifest(dir: string): Record<string, unknown> | undefined {
    if (!this.manifests.has(dir)) {
      try {
        this.manifests.set(dir, JSON.parse(readFileSync(join(this.projectDir, dir, "package.json"), "utf8")) as Record<string, unknown>);
      } catch {
        this.manifests.set(dir, undefined);
      }
    }
    return this.manifests.get(dir);
  }
}

interface PathsIndex {
  exact: Set<string>;
  /** Wildcard keys by their prefix (text before the `*`), so lookups cost O(specifier length), not O(keys). */
  wild: Map<string, { key: string; suffix: string }[]>;
}

const indexes = new WeakMap<object, PathsIndex>();

function pathsIndex(paths: Record<string, string[]>): PathsIndex {
  let index = indexes.get(paths);
  if (!index) {
    index = { exact: new Set(), wild: new Map() };
    for (const key of Object.keys(paths)) {
      const star = key.indexOf("*");
      if (star === -1) index.exact.add(key);
      else {
        const prefix = key.slice(0, star);
        index.wild.set(prefix, [...(index.wild.get(prefix) ?? []), { key, suffix: key.slice(star + 1) }]);
      }
    }
    indexes.set(paths, index);
  }
  return index;
}

/** Every string target an `exports` field can give for `subpath` (all conditions: any could be the one that loads). */
function exportTargets(exportsField: unknown, subpath: string): string[] {
  const flatten = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(flatten) : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : []);
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return subpath === "." ? flatten(exportsField) : [];
  if (!exportsField || typeof exportsField !== "object") return [];
  const map = exportsField as Record<string, unknown>;
  const keys = Object.keys(map);
  if (!keys.some((k) => k.startsWith("."))) return subpath === "." ? flatten(map) : []; // conditions only = the "." entry
  if (map[subpath] !== undefined) return flatten(map[subpath]);
  const out: string[] = [];
  for (const key of keys) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const match = subpath.slice(prefix.length, subpath.length - suffix.length);
      out.push(...flatten(map[key]).map((t) => t.replace("*", match)));
    }
  }
  return out;
}

async function loadOptions(projectDir: string, configFile: string): Promise<ModuleOptions> {
  const scope = posix.dirname(configFile) === "." ? "" : posix.dirname(configFile);
  const result: ModuleOptions = { scope };
  const chain: { dir: string; options: { baseUrl?: unknown; paths?: unknown } }[] = [];
  const problems: string[] = [];
  const visited = new Set<string>();

  const load = async (absPath: string, requester: string): Promise<void> => {
    const key = resolve(absPath);
    if (visited.has(key)) return; // extends cycle: the chain so far already carries everything reachable
    visited.add(key);
    let text: string;
    try {
      text = await readFile(key, "utf8");
    } catch {
      problems.push(`tsconfig ${requester} extends ${relativeTo(projectDir, key)}, which could not be read`);
      return;
    }
    let parsed: { config?: unknown; error?: unknown };
    try {
      parsed = ts.parseConfigFileTextToJson(key.split(sep).join("/"), text);
    } catch {
      parsed = { error: true };
    }
    if (parsed.error || typeof parsed.config !== "object" || parsed.config === null) {
      problems.push(`tsconfig ${relativeTo(projectDir, key)} could not be parsed`);
      return;
    }
    const config = parsed.config as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
    const parents = typeof config.extends === "string" ? [config.extends] : Array.isArray(config.extends) ? (config.extends as unknown[]).filter((e): e is string => typeof e === "string") : [];
    for (const parent of parents) {
      const target = resolveExtends(dirname(key), parent);
      if (target) await load(target, relativeTo(projectDir, key));
      else problems.push(`tsconfig ${relativeTo(projectDir, key)} extends "${parent}", which was not found (path aliases in it are unknown)`);
    }
    chain.push({ dir: relativeTo(projectDir, dirname(key)), options: config.compilerOptions ?? {} });
  };

  await load(join(projectDir, configFile), configFile);
  for (const { dir, options } of chain) {
    if (typeof options.baseUrl === "string") result.baseUrl = posix.normalize(posix.join(dir, options.baseUrl));
    if (options.paths && typeof options.paths === "object") {
      result.paths = Object.fromEntries(Object.entries(options.paths as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []]));
      result.pathsBase = dir;
    }
  }
  if (result.paths && result.baseUrl !== undefined) result.pathsBase = result.baseUrl;
  if (problems.length > 0) result.problem = problems[0];
  return result;
}

function relativeTo(projectDir: string, abs: string): string {
  const rel = relative(projectDir, abs).split(sep).join("/");
  return rel === "" ? "." : rel;
}

/** `extends` value -> absolute file: relative/absolute paths, else a package looked up in node_modules upward. */
function resolveExtends(fromDir: string, value: string): string | undefined {
  const withJson = (p: string): string | undefined => [p, `${p}.json`, join(p, "tsconfig.json")].find((c) => existsSync(c) && !isDirectory(c));
  if (value.startsWith(".") || isAbsolute(value)) return withJson(resolve(fromDir, value));
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const hit = withJson(join(dir, "node_modules", value));
    if (hit) return hit;
    if (dirname(dir) === dir) return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
