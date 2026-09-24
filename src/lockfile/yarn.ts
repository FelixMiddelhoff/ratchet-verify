import type { InstalledPackages } from "./types.js";

export type YarnFlavor = "classic" | "berry";

/** Berry writes a `__metadata:` block; classic starts with a "yarn lockfile v1" comment. */
export function detectYarnFlavor(text: string): YarnFlavor {
  return /^__metadata:/m.test(text) ? "berry" : "classic";
}

interface RawEntry {
  descriptors: string[];
  fields: Map<string, string>;
}

/** Ranges that never resolve to a registry package: workspaces, links, git, files, tarball URLs. */
const NON_REGISTRY_RANGE = /^(workspace|link|portal|file|patch|exec|git|git\+\w+|github|gitlab|bitbucket|http|https):/;

export function parseYarnLock(text: string): InstalledPackages {
  const flavor = detectYarnFlavor(text);
  const found: { name: string; version: string; ranges: string[]; aliases: string[] }[] = [];

  for (const entry of readEntries(text)) {
    if (entry.descriptors.length === 0 || entry.descriptors[0] === "__metadata") continue;
    const version = entry.fields.get("version");
    if (version === undefined) continue;
    const parsed = entry.descriptors.map(splitDescriptor);
    if (parsed.some((d) => NON_REGISTRY_RANGE.test(d.range))) continue;

    let name: string;
    if (flavor === "berry") {
      const resolution = entry.fields.get("resolution");
      if (resolution === undefined) continue;
      const at = resolution.indexOf("@npm:", 1);
      if (at === -1) continue; // patch:, workspace:, git ... resolutions are not registry versions
      name = resolution.slice(0, at);
    } else {
      const resolved = entry.fields.get("resolved");
      if (resolved === undefined || !/^https?:\/\//.test(resolved) || /codeload\.github|github\.com/.test(resolved)) continue;
      name = realName(parsed[0]!);
    }
    const aliases = parsed.map((d) => d.name).filter((n) => n !== name);
    const ranges = parsed.map((d) => d.range.replace(/^npm:/, "")).sort();
    found.push({ name, version, ranges, aliases: [...new Set(aliases)] });
  }

  const perName = new Map<string, number>();
  for (const f of found) perName.set(f.name, (perName.get(f.name) ?? 0) + 1);
  const result: InstalledPackages = new Map();
  for (const f of found) {
    // One version of a name gets the npm-style path; several get a per-range suffix so a bump still lines up.
    const path = perName.get(f.name) === 1 ? `node_modules/${f.name}` : `node_modules/${f.name}@${f.ranges[0]}`;
    result.set(path, { name: f.name, version: f.version, ...(f.aliases.length ? { aliases: f.aliases } : {}) });
  }
  return result;
}

/** `alias@npm:real@^1` installs `real`; anything else installs the descriptor's own name. */
function realName(d: { name: string; range: string }): string {
  if (!d.range.startsWith("npm:")) return d.name;
  const inner = d.range.slice(4);
  const at = inner.indexOf("@", 1);
  return at === -1 ? d.name : inner.slice(0, at);
}

/** `@scope/a@^1` -> name `@scope/a`, range `^1`. */
function splitDescriptor(descriptor: string): { name: string; range: string } {
  const at = descriptor.indexOf("@", 1);
  if (at === -1) return { name: descriptor, range: "" };
  return { name: descriptor.slice(0, at), range: descriptor.slice(at + 1) };
}

function readEntries(text: string): RawEntry[] {
  const entries: RawEntry[] = [];
  let current: RawEntry | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      if (!line.endsWith(":")) continue;
      current = { descriptors: splitHeader(line.slice(0, -1)), fields: new Map() };
      entries.push(current);
    } else if (indent === 2 && current) {
      const match = /^\s+([A-Za-z][\w-]*):?\s+(.*)$/.exec(line);
      if (match) current.fields.set(match[1]!, unquote(match[2]!.trim()));
    }
  }
  return entries;
}

/** Splits `"a@^1", a@~1.1` on commas outside quotes; berry puts them all inside one pair of quotes. */
function splitHeader(header: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let buffer = "";
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      parts.push(buffer);
      buffer = "";
    } else buffer += ch;
  }
  parts.push(buffer);
  return parts.flatMap((p) => p.split(/,\s*(?=@?[\w.-]+(?:\/[\w.-]+)?@)/)).map((p) => p.trim()).filter(Boolean);
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
