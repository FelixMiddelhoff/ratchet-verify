import { isValidPackageName, type Limits, type RegistryConfig } from "./config.js";

export type AcceptedClass = "packument" | "tarball";
export type RejectedClass = "denied" | "invalid";

export interface Accepted {
  ok: true;
  method: "GET" | "HEAD";
  class: AcceptedClass;
  registry: RegistryConfig;
  name: string;
  /** Canonical upstream path (prefix included), rebuilt from parsed parts, never the raw client path. */
  upstreamPath: string;
}

export interface Rejected {
  ok: false;
  class: RejectedClass;
  status: number;
  /** Fixed vocabulary, safe to log and to return to the client. */
  reason: string;
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
  isPackageAllowed(name: string): boolean;
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

/**
 * Normalises then classifies an incoming request. Anything that is not exactly a
 * packument or tarball GET/HEAD for an allowed package is rejected.
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

  // Registry routing: a non-default registry owns "/<id>/..."; everything else goes to the default.
  let registry = ctx.registries.find((r) => r.isDefault);
  let segs = rawSegments;
  const routed = ctx.registries.find((r) => !r.isDefault && r.id === rawSegments[0]);
  if (routed) {
    registry = routed;
    segs = rawSegments.slice(1);
  }
  if (!registry) return reject(404, "no-registry", "denied");
  if (segs.length === 0) return reject(403, "path-not-allowed", "denied");

  // Decode each segment exactly once; %2f is only legal as the scope separator of a scoped name.
  const decoded: string[] = [];
  for (const [i, raw] of segs.entries()) {
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

  let cls: AcceptedClass;
  let upstreamPath: string;
  if (rest.length === 0) {
    cls = "packument";
    upstreamPath = `/${name.replace("/", "%2F")}`;
  } else if (rest.length === 2 && rest[0] === "-") {
    const file = rest[1] as string;
    const bare = name.includes("/") ? (name.split("/")[1] as string) : name;
    const version = file.startsWith(`${bare}-`) && file.endsWith(".tgz") ? file.slice(bare.length + 1, -4) : "";
    if (!VERSION_RE.test(version)) return reject(403, "path-not-allowed", "denied");
    cls = "tarball";
    upstreamPath = `/${name}/-/${file}`;
  } else {
    return reject(403, "path-not-allowed", "denied");
  }

  if (!ctx.isPackageAllowed(name)) return reject(403, "package-not-allowed", "denied");

  return { ok: true, method, class: cls, registry, name, upstreamPath: `${registry.pathPrefix}${upstreamPath}` };
}
