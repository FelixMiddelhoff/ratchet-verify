import type { InstalledPackages } from "./types.js";

/**
 * Hand-written reader for the YAML subset pnpm emits (no runtime dependency): nested block mappings with
 * plain or quoted keys, scalars, inline `{ a: b }` maps kept as raw strings, and `- item` lists (ignored,
 * ratchet needs none). Covers lockfileVersion 5.x (`/name/1.0.0_peer@1`), 6.x (`/name@1.0.0(peer@1)`) and
 * 9.x (`name@1.0.0`, with `snapshots:`).
 */
type Node = { [key: string]: Node | string };

export function isPnpmLock(text: string): boolean {
  return /^lockfileVersion:/m.test(text);
}

export function parsePnpmLock(text: string): InstalledPackages {
  const root = parseYaml(text);
  const major = Number.parseInt(scalar(root.lockfileVersion) ?? "", 10);
  if (!Number.isFinite(major)) throw new Error("Unsupported pnpm lockfile: no lockfileVersion");
  if (major > 9) throw new Error(`Unsupported pnpm lockfile: lockfileVersion ${scalar(root.lockfileVersion)} is newer than ratchet knows (5-9)`);

  const packages = asNode(root.packages);
  const snapshots = asNode(root.snapshots);
  // Every importer (root + workspace packages) counts: a dependency any of them names is direct.
  // Which real package each importer dependency (by its manifest name) points at.
  const direct: { importer: string; depName: string; name: string; version: string }[] = [];
  for (const [importer, depName, entry] of importerEntries(root)) {
    const raw = typeof entry === "string" ? entry : scalar(entry.version);
    const ref = raw === undefined ? undefined : parseRef(raw, depName, major);
    if (ref) direct.push({ importer, depName, ...ref });
  }

  const found = new Map<string, { name: string; version: string }>(); // "name@version"
  const add = (key: string, entry: Node | string | undefined): void => {
    const ref = parseKey(key, major);
    if (!ref || (typeof entry === "object" && isNonRegistry(entry))) return;
    found.set(`${ref.name}@${ref.version}`, ref);
  };
  for (const [key, entry] of Object.entries(packages)) add(key, entry);
  // v9 keeps installed variants (peer suffixes) in `snapshots`; all of them collapse to the same name@version.
  for (const key of Object.keys(snapshots)) if (!packages[stripKey(key)]) add(key, undefined);

  const perName = new Map<string, string[]>();
  for (const ref of found.values()) perName.set(ref.name, [...(perName.get(ref.name) ?? []), ref.version]);
  const aliasesFor = new Map<string, Set<string>>();
  for (const { depName, ...ref } of direct) if (depName !== ref.name) aliasesFor.set(ref.name, (aliasesFor.get(ref.name) ?? new Set()).add(depName));

  const result: InstalledPackages = new Map();
  for (const ref of found.values()) {
    const versions = perName.get(ref.name)!;
    // One version: npm-style path. Several: the one the ROOT importer uses keeps the plain path, every other copy
    // (workspace importers, transitive) is keyed by major so a patch/minor bump still lines up. Keying by full
    // version would give a bumped copy a new path and it would show as removed+added, unattributed.
    let path = `node_modules/${ref.name}`;
    if (versions.length > 1) {
      const rootUses = direct.some((d) => d.importer === "." && d.name === ref.name && d.version === ref.version);
      if (!rootUses) path = `node_modules/${ref.name}@${ref.version.split(".")[0]}`;
    }
    const aliases = [...(aliasesFor.get(ref.name) ?? [])];
    const importers = [...new Set(direct.filter((d) => d.name === ref.name && d.version === ref.version).map((d) => d.importer))];
    result.set(uniquePath(result, path, ref.version), { name: ref.name, version: ref.version, ...(aliases.length ? { aliases } : {}), ...(importers.length ? { importers } : {}) });
  }
  return result;
}

function uniquePath(result: InstalledPackages, path: string, version: string): string {
  return result.has(path) ? `${path}#${version}` : path;
}

/**
 * Dependencies of every importer, flattened: all `importers` entries (root `.` and workspace packages), or the
 * top-level v5/v6 sections of a single-project lockfile. Same name in several importers = several entries.
 */
function importerEntries(root: Node): [string, string, Node | string][] {
  const importers = asNode(root.importers);
  const sources: [string, Node][] = Object.keys(importers).length > 0 ? Object.entries(importers).map(([k, v]) => [k, asNode(v)]) : [[".", root]];
  const entries: [string, string, Node | string][] = [];
  for (const [importer, source] of sources) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) for (const [dep, entry] of Object.entries(asNode(source[section]))) entries.push([importer, dep, entry]);
  }
  return entries;
}

/** `name@1.0.0(peer@1)`, `/name/1.0.0_peer@1` and friends -> registry name + version; undefined = not a registry package. */
function parseKey(key: string, major: number): { name: string; version: string } | undefined {
  const bare = stripKey(key);
  if (/^(file|link|git|git\+\w+|github|gitlab|bitbucket|https?|workspace):/.test(bare) || /(^|[/@])(github\.com|codeload\.github\.com|gitlab\.com|bitbucket\.org)[/:]/.test(bare)) return undefined;
  if (bare.includes("@https:") || bare.includes("@http:") || bare.includes("@file:") || bare.includes("@link:") || bare.includes("@github:")) return undefined;
  if (major < 6) {
    const m = /^\/?((?:@[^/]+\/)?[^/]+)\/([^/]+)$/.exec(key.replace(/^['"]|['"]$/g, "").replace(/\([^)]*\)$/, ""));
    if (!m) return undefined;
    return validRef(m[1]!, m[2]!.replace(/_.*$/, ""));
  }
  const at = bare.lastIndexOf("@");
  if (at <= 0) return undefined;
  return validRef(bare.slice(0, at), bare.slice(at + 1));
}

function validRef(name: string, version: string): { name: string; version: string } | undefined {
  return /^\d+\.\d+\.\d+/.test(version) ? { name, version } : undefined;
}

/** Unquote, drop the v5/v6 leading slash and every `(peer)` or v5 `_peer` suffix. */
function stripKey(key: string): string {
  let k = key.replace(/^['"]|['"]$/g, "").replace(/^\//, "");
  const paren = k.indexOf("(");
  if (paren !== -1) k = k.slice(0, paren);
  return k;
}

/** An importer's `version:` value, e.g. `18.2.0(react@18.2.0)`, `/chalk@4.1.2`, `chalk@4.1.2`, `/chalk/4.1.2`, `link:../x`. */
function parseRef(raw: string, depName: string, major: number): { name: string; version: string } | undefined {
  const value = unquote(raw);
  if (/^(link|file|workspace|git|https?|github):/.test(value)) return undefined;
  const isPlainVersion = /^\d/.test(value);
  if (isPlainVersion) return validRef(depName, value.replace(/\(.*$/, "").replace(/_.*$/, ""));
  return parseKey(value, major);
}

/** Registry entries only carry an integrity; git, directory and custom tarball resolutions are not diffed. */
function isNonRegistry(entry: Node): boolean {
  const resolution = entry.resolution;
  const raw = typeof resolution === "string" ? resolution : "";
  return /type:\s*(git|directory)|commit:|directory:|repo:|tarball:\s*(file:|https?:\/\/(codeload\.github|github\.com|gitlab|bitbucket))/.test(raw);
}

function asNode(value: Node | string | undefined): Node {
  return typeof value === "object" ? value : {};
}

function scalar(value: Node | string | undefined): string | undefined {
  return typeof value === "string" ? unquote(value) : undefined;
}

function unquote(value: string): string {
  const v = value.trim();
  return (v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')) ? v.slice(1, -1) : v;
}

function parseYaml(text: string): Node {
  const rootNode: Node = {};
  const stack: { indent: number; node: Node }[] = [{ indent: -1, node: rootNode }];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#") || raw.trimStart().startsWith("- ")) continue;
    const indent = raw.length - raw.trimStart().length;
    const parsed = splitKeyValue(raw.trim());
    if (!parsed) continue;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    if (parsed.value === "") {
      const child: Node = {};
      parent[parsed.key] = child;
      stack.push({ indent, node: child });
    } else parent[parsed.key] = parsed.value;
  }
  return rootNode;
}

/** `'@scope/a@1.0.0':` / `/a/1.0.0:` / `key: value` (a trailing `# comment` is not stripped: pnpm emits none). */
function splitKeyValue(line: string): { key: string; value: string } | undefined {
  let end = -1;
  if (line.startsWith("'") || line.startsWith('"')) {
    const close = line.indexOf(line[0]!, 1);
    if (close === -1 || line[close + 1] !== ":") return undefined;
    end = close + 1;
  } else {
    end = line.search(/:(\s|$)/);
    if (end === -1) return undefined;
  }
  return { key: unquote(line.slice(0, end)), value: line.slice(end + 1).trim() };
}
