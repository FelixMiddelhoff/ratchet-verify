import { createHash } from "node:crypto";
import { isValidPackageName } from "./config.js";

/**
 * Packument (registry metadata) rewriting. Every `versions[v].dist.tarball` is
 * replaced by a canonical URL of THIS proxy so that yarn, berry and pnpm (which
 * follow `dist.tarball` literally) fetch through it. The original upstream URL
 * is returned as `learned` so the proxy can map the canonical request back to
 * it (Artifactory `/api/npm/repo/...`, GitHub Packages `/download/...` layouts).
 * `integrity` / `shasum` are never touched.
 */
export interface LearnedTarball {
  version: string;
  /** Validated absolute https URL (href). */
  url: string;
}

export interface PackumentRewrite {
  body: Buffer;
  learned: LearnedTarball[];
  /** Package names declared as dependencies by any version (for discovery mode). */
  declared: string[];
}

const MAX_DECLARED_PER_PACKUMENT = 5000;
const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/** Returns the URL when it is a plausible upstream tarball location (https, no userinfo/fragment, bounded, printable). */
export function validateLearnedUrl(text: unknown): URL | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > 2048 || !/^[!-~]+$/.test(text)) return undefined;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || !u.hostname) return undefined;
  return u;
}

/** `npm:real-name@range` aliases resolve to `real-name`; plain specs resolve to the key itself. */
function realName(key: string, spec: unknown): string {
  if (typeof spec === "string" && spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.startsWith("@") ? rest.indexOf("@", 1) : rest.indexOf("@");
    return at === -1 ? rest : rest.slice(0, at);
  }
  return key;
}

/**
 * A same-origin (credentialed) upstream tarball URL must at least mention the package and
 * version in its path, so a publisher cannot point `dist.tarball` at an arbitrary
 * authenticated endpoint of the registry and read it through the proxy.
 */
export function plausibleTarballUrl(u: URL, name: string, version: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  const bare = name.includes("/") ? (name.split("/")[1] as string) : name;
  return path.includes(bare) && path.includes(version) && !path.split("/").some((s) => s === "..");
}

export function canonicalTarballUrl(base: string, name: string, version: string): string {
  const bare = name.includes("/") ? (name.split("/")[1] as string) : name;
  // The version is a JSON key from the upstream document: nothing outside the semver alphabet may reach a URL path.
  const safe = version.replace(/[^0-9A-Za-z.+-]/g, (c) => encodeURIComponent(c));
  return `${base}/${name}/-/${bare}-${safe}.tgz`;
}

/**
 * Parses a JSON packument and rewrites tarball URLs to `${base}/<name>/-/<bare>-<version>.tgz`.
 * `base` is the client-facing origin plus the registry route prefix. Returns undefined when the
 * body is not a JSON object.
 */
export function rewritePackument(text: Buffer | string, name: string, base: string): PackumentRewrite | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(typeof text === "string" ? text : text.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const learned: LearnedTarball[] = [];
  const declared = new Set<string>();
  const versions = (doc as { versions?: unknown }).versions;
  if (typeof versions === "object" && versions !== null && !Array.isArray(versions)) {
    for (const [version, meta] of Object.entries(versions as Record<string, unknown>)) {
      if (typeof meta !== "object" || meta === null) continue;
      const m = meta as Record<string, unknown>;
      const dist = m.dist;
      if (typeof dist === "object" && dist !== null && !Array.isArray(dist)) {
        const d = dist as Record<string, unknown>;
        if ("tarball" in d) {
          const u = validateLearnedUrl(d.tarball);
          if (u) learned.push({ version, url: u.href });
          d.tarball = canonicalTarballUrl(base, name, version);
        }
      }
      for (const field of DEP_FIELDS) {
        const deps = m[field];
        if (typeof deps !== "object" || deps === null || Array.isArray(deps)) continue;
        for (const [key, spec] of Object.entries(deps as Record<string, unknown>)) {
          const n = realName(key, spec);
          if (declared.size < MAX_DECLARED_PER_PACKUMENT && isValidPackageName(n)) declared.add(n);
        }
      }
    }
  }
  return { body: Buffer.from(JSON.stringify(doc)), learned, declared: [...declared] };
}

/** Weak validator computed over the rewritten body (upstream validators no longer describe what the client gets). */
export function weakEtag(body: Buffer): string {
  return `W/"${createHash("sha1").update(body).digest("hex")}"`;
}

/** RFC 9110 weak comparison of an If-None-Match header against our etag. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (typeof ifNoneMatch !== "string" || ifNoneMatch.length > 4096) return false;
  const strip = (t: string): string => t.trim().replace(/^W\//, "");
  const ours = strip(etag);
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || strip(t) === ours);
}
