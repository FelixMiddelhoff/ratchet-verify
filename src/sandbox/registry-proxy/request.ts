import { isValidPackageName, type Limits, type RegistryConfig } from "./config.js";

export type AcceptedClass = "packument" | "tarball";
export type RejectedClass = "denied" | "invalid";

export interface Accepted {
  ok: true;
  method: "GET" | "HEAD";
  class: AcceptedClass;
  registry: RegistryConfig;
  name: string;
  /** Tarball only. */
  version?: string;
  /** True when the name was let through by discovery mode (not in the configured allowlist). */
  discovered?: boolean;
  /** Canonical upstream path (prefix included), rebuilt from parsed parts, never the raw client path. */
  upstreamPath: string;
}

export interface Rejected {
  ok: false;
  class: RejectedClass;
  status: number;
  /** Fixed vocabulary, safe to log and to return to the client. */
  reason: string;
  /** Known once routing succeeded; never raw client text. */
  registry?: string;
  /** Only ever a string that passed the package-name grammar. */
  name?: string;
}

export interface ClassifyInput {
  method: string | undefined;
  url: string | undefined;
  /** Node's `req.rawHeaders`: alternating name, value, in wire order and with duplicates. */
  rawHeaders: readonly string[];
}

export interface ClassifyContext {
  registries: readonly RegistryConfig[];
  limits: Pick<Limits, "maxUrlLength" | "maxHeaderBytes">;
  /** false = deny; "discovered" = allowed by discovery mode only. */
  isPackageAllowed(name: string): boolean | "discovered";
}

const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOST_HEADER_RE = /^[A-Za-z0-9.:[\]-]{1,255}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const reject = (status: number, reason: string, cls: RejectedClass = "invalid"): Rejected => ({ ok: false, class: cls, status, reason });

/** Checks the header block for smuggling/injection shapes. Returns a reason or undefined. */
export function checkHeaderBlock(rawHeaders: readonly string[], maxHeaderBytes: number): string | undefined {
  if (rawHeaders.length % 2 !== 0) return "malformed-headers";
  const seen = new Map<string, number>();
  let size = 0;
  let contentLength: string | undefined;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const value = rawHeaders[i + 1] as string;
    size += name.length + value.length + 4;
    if (!TOKEN_RE.test(name)) return "bad-header-name";
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return "bad-header-value";
    const lower = name.toLowerCase();
    seen.set(lower, (seen.get(lower) ?? 0) + 1);
    if (lower === "content-length") contentLength = value.trim();
    if (lower === "host" && !HOST_HEADER_RE.test(value)) return "bad-host-header";
  }
  if (size > maxHeaderBytes) return "headers-too-large";
  for (const single of ["host", "content-length", "transfer-encoding"]) {
    if ((seen.get(single) ?? 0) > 1) return `duplicate-${single}`;
  }
  if ((seen.get("host") ?? 0) !== 1) return "missing-host";
  const te = seen.get("transfer-encoding") ?? 0;
  if (te > 0 && contentLength !== undefined) return "conflicting-length-headers";
  if (te > 0) return "request-body-not-allowed";
  if (contentLength !== undefined && contentLength !== "0") return "request-body-not-allowed";
  return undefined;
}

interface ParsedPackagePath {
  ok: true;
  name: string;
  cls: AcceptedClass;
  /** Tarball only. */
  file?: string;
  version?: string;
}

/** Decodes each segment exactly once and turns `[name..., "-", file]` / `[name]` into a package request, or rejects. */
function parsePackagePath(segs: readonly string[]): ParsedPackagePath | Rejected {
  const decoded: string[] = [];
  for (const [i, raw] of segs.entries()) {
    // %2f is only legal as the scope separator of a scoped name; everything else is decoded once.
    if (/%(?![0-9A-Fa-f]{2})/.test(raw)) return reject(400, "bad-percent-encoding");
    let d: string;
    try {
      d = decodeURIComponent(raw);
    } catch {
      return reject(400, "bad-percent-encoding");
    }
    if (d.includes("%")) return reject(400, "double-encoding");
    if (!/^[!-~]+$/.test(d) || d.includes("\\")) return reject(400, "bad-characters");
    if (d === "." || d === "..") return reject(400, "traversal");
    if (d.includes("/")) {
      const scoped = i === 0 && d.startsWith("@") && d.indexOf("/") === d.lastIndexOf("/") && !d.endsWith("/");
      if (!scoped) return reject(400, "encoded-slash");
    }
    decoded.push(d);
  }

  const first = decoded[0] as string;
  if (first.startsWith("-")) return reject(403, "npm-api-path", "denied");

  let name: string;
  let rest: string[];
  if (first.startsWith("@") && first.includes("/")) {
    name = first;
    rest = decoded.slice(1);
  } else if (first.startsWith("@")) {
    const second = decoded[1];
    if (second === undefined) return reject(403, "invalid-package-name", "denied");
    name = `${first}/${second}`;
    rest = decoded.slice(2);
  } else {
    name = first;
    rest = decoded.slice(1);
  }
  if (!isValidPackageName(name)) return reject(403, "invalid-package-name", "denied");

  if (rest.length === 0) return { ok: true, name, cls: "packument" };
  if (rest.length === 2 && rest[0] === "-") {
    const file = rest[1] as string;
    const bare = name.includes("/") ? (name.split("/")[1] as string) : name;
    const version = file.startsWith(`${bare}-`) && file.endsWith(".tgz") ? file.slice(bare.length + 1, -4) : "";
    if (!VERSION_RE.test(version)) return { ...reject(403, "path-not-allowed", "denied"), name };
    return { ok: true, name, cls: "tarball", file, version };
  }
  return { ...reject(403, "path-not-allowed", "denied"), name };
}

/** Canonical client-facing path prefix of a registry: "" for the default one, `/_r/<id>` otherwise. */
export const routePrefix = (r: RegistryConfig): string => (r.isDefault ? "" : `/_r/${r.id}`);

/**
 * Same-origin redirect / learned-URL check: is this upstream path (registry pathPrefix
 * included, no query) exactly a packument or tarball of an allowed package?
 */
export function isAllowedUpstreamPackagePath(registry: RegistryConfig, pathname: string, search: string, isAllowed: (name: string) => boolean): boolean {
  if (search !== "") return false;
  const prefix = registry.pathPrefix;
  if (prefix !== "" && !pathname.startsWith(`${prefix}/`)) return false;
  const rest = pathname.slice(prefix.length);
  if (!rest.startsWith("/") || rest.length < 2) return false;
  const segs = rest.slice(1).split("/");
  if (segs.some((s) => s.length === 0)) return false;
  const p = parsePackagePath(segs);
  return p.ok && isAllowed(p.name);
}

/**
 * Normalises then classifies an incoming request. Anything that is not exactly a
 * packument or tarball GET/HEAD for an allowed package is rejected.
 *
 * Routing: the default registry owns every unprefixed path; any registry (default or not) is
 * also reachable as `/_r/<id>/...`. `_` cannot start a package name, so no id can shadow a package.
 * A leading registry pathPrefix (`/api/npm/repo/...`, from a lockfile `resolved` URL whose host was
 * replaced) is stripped when what remains is a valid package path.
 */
export function classifyRequest(input: ClassifyInput, ctx: ClassifyContext): Accepted | Rejected {
  const method = input.method;
  if (method !== "GET" && method !== "HEAD") return reject(405, "method-not-allowed", "denied");

  const url = input.url;
  if (typeof url !== "string" || url.length === 0) return reject(400, "missing-url");
  if (url.length > ctx.limits.maxUrlLength) return reject(414, "url-too-long");
  // Printable ASCII only: kills CR/LF/NUL/space/raw unicode/backslash before any parsing.
  if (!/^[!-~]+$/.test(url) || url.includes("\\")) return reject(400, "bad-characters");
  if (url[0] !== "/" || url[1] === "/") return reject(400, "not-origin-form");
  if (url.includes("#")) return reject(400, "fragment-not-allowed");
  if (url.includes("?")) return reject(403, "query-not-allowed", "denied");

  const headerProblem = checkHeaderBlock(input.rawHeaders, ctx.limits.maxHeaderBytes);
  if (headerProblem) return reject(400, headerProblem);

  const rawSegments = url.slice(1).split("/");
  if (rawSegments.some((s) => s.length === 0)) return reject(400, "empty-segment");

  let registry = ctx.registries.find((r) => r.isDefault);
  let segs = rawSegments;
  if (rawSegments[0] === "_r") {
    const id = rawSegments[1];
    registry = ctx.registries.find((r) => r.id === id);
    if (!registry) return reject(404, "no-registry", "denied");
    segs = rawSegments.slice(2);
  }
  if (!registry) return reject(404, "no-registry", "denied");
  const withRegistry = <T extends Rejected>(r: T): T => ({ ...r, registry: registry.id });
  if (segs.length === 0) return withRegistry(reject(403, "path-not-allowed", "denied"));

  let parsed: ParsedPackagePath | Rejected | undefined;
  if (registry.pathPrefix !== "") {
    const prefixSegs = registry.pathPrefix.slice(1).split("/");
    if (segs.length > prefixSegs.length && prefixSegs.every((p, i) => segs[i] === p)) {
      const stripped = parsePackagePath(segs.slice(prefixSegs.length));
      if (stripped.ok) parsed = stripped;
    }
  }
  parsed ??= parsePackagePath(segs);
  if (!parsed.ok) return withRegistry(parsed);

  const verdict = ctx.isPackageAllowed(parsed.name);
  if (verdict === false) return { ...withRegistry(reject(403, "package-not-allowlisted", "denied")), name: parsed.name };

  const upstreamPath = parsed.cls === "packument" ? `/${parsed.name.replace("/", "%2F")}` : `/${parsed.name}/-/${parsed.file as string}`;
  return {
    ok: true,
    method,
    class: parsed.cls,
    registry,
    name: parsed.name,
    ...(parsed.version !== undefined ? { version: parsed.version } : {}),
    ...(verdict === "discovered" ? { discovered: true } : {}),
    upstreamPath: `${registry.pathPrefix}${upstreamPath}`,
  };
}

