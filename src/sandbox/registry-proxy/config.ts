import { isIP } from "node:net";
import { parseClientCidr, type ClientCidr } from "./clients.js";
import { isIpLiteral, looksNumeric, parseV4, parseV6 } from "./netguard.js";
import { Credential } from "./secret.js";

/** Strict, closed-world validation of the proxy configuration. Errors name paths, never values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Limits {
  maxResponseBytes: number;
  requestTimeoutMs: number;
  /** Upstream-active requests at once. Waiters queue (maxQueued / queueWaitMs), CONNECT tunnels are separate. */
  maxConcurrent: number;
  maxUrlLength: number;
  maxHeaderBytes: number;
  maxRedirects: number;
  connectTimeoutMs: number;
  connectIdleTimeoutMs: number;
  /** 0 = no cap on CONNECT tunnels. */
  maxConnectBytes: number;
  /** Requests waiting for a free upstream slot; beyond this (or after queueWaitMs) the answer is 503. */
  maxQueued: number;
  queueWaitMs: number;
  /** Concurrent CONNECT tunnels (NOT counted against maxConcurrent). */
  maxTunnels: number;
  /** server.maxConnections: hard cap on open client sockets. */
  maxConnections: number;
  /** Open client sockets per source address. */
  maxConnectionsPerSource: number;
  /** Idle keep-alive lifetime of a client socket. */
  keepAliveTimeoutMs: number;
  /** Cap for a buffered (rewritten) packument. */
  maxPackumentBytes: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxResponseBytes: 256 * 1024 * 1024,
  requestTimeoutMs: 60_000,
  maxConcurrent: 128,
  maxUrlLength: 512,
  maxHeaderBytes: 8 * 1024,
  maxRedirects: 5,
  connectTimeoutMs: 10_000,
  connectIdleTimeoutMs: 30_000,
  maxConnectBytes: 0,
  maxQueued: 1024,
  queueWaitMs: 30_000,
  maxTunnels: 64,
  maxConnections: 1024,
  maxConnectionsPerSource: 512,
  keepAliveTimeoutMs: 65_000,
  maxPackumentBytes: 64 * 1024 * 1024,
});

const LIMIT_RANGES: Record<keyof Limits, [number, number]> = {
  maxResponseBytes: [1, 8 * 1024 ** 3],
  requestTimeoutMs: [1, 3_600_000],
  maxConcurrent: [1, 1024],
  maxUrlLength: [16, 2048],
  maxHeaderBytes: [1024, 64 * 1024],
  maxRedirects: [0, 10],
  connectTimeoutMs: [1, 300_000],
  connectIdleTimeoutMs: [1, 3_600_000],
  maxConnectBytes: [0, 8 * 1024 ** 3],
  maxQueued: [0, 100_000],
  queueWaitMs: [1, 600_000],
  maxTunnels: [1, 4096],
  maxConnections: [1, 65_535],
  maxConnectionsPerSource: [1, 65_535],
  keepAliveTimeoutMs: [1000, 600_000],
  maxPackumentBytes: [1024, 1024 ** 3],
};

export interface RegistryConfig {
  /** Non-default registries are routed under `/_r/<id>/` (outside the npm name space); the default one is unprefixed. */
  readonly id: string;
  /** Exact `URL.origin` of the upstream (always https). */
  readonly upstreamOrigin: string;
  /** "" or "/a/b": prepended to every upstream path. */
  readonly pathPrefix: string;
  readonly isDefault: boolean;
  readonly credential: Credential | undefined;
  /** Explicit opt-in for an in-network registry: its name may resolve to loopback/RFC1918/CGNAT/ULA. Link-local, multicast and reserved ranges stay refused. */
  readonly allowPrivateAddresses: boolean;
}

export type Discovery = "off" | "audit";

export interface ProxyConfig {
  readonly registries: readonly RegistryConfig[];
  /** Lower-case `host:port` entries CONNECT (and cross-origin redirects) may reach. */
  readonly allowHosts: ReadonlySet<string>;
  /** Subset of allowHosts whose names may resolve to private addresses (explicit, per entry). */
  readonly allowPrivateHosts: ReadonlySet<string>;
  /** "audit": dependency names declared by an allowed packument that the client then requests are auto-allowed and recorded. */
  readonly discovery: Discovery;
  readonly packages: { readonly allow: ReadonlySet<string>; readonly allowPrefixes: readonly string[]; /** Every syntactically valid package name passes (the user switched the allowlist off; still no query strings, no non-package paths). */ readonly allowAll: boolean };
  readonly limits: Readonly<Limits>;
  /** Explicit resolver IPs for upstream names; the sidecar never uses libc. */
  readonly dns: readonly string[];
  /**
   * `cidr` (production): bind the one local address inside that IPv4 range, resolved at start (`resolveListenHost`);
   * never a wildcard, so an interface on another network (the sidecar's egress side) does not answer.
   */
  readonly listen: { readonly host: string; readonly cidr?: string; readonly port: number };
  /** Connections from outside these ranges are destroyed before a byte is parsed (defence in depth for the bind). */
  readonly allowClients: readonly ClientCidr[];
}

const isWildcardAddress = (host: string): boolean => {
  const v4 = parseV4(host);
  if (v4) return v4.every((b) => b === 0);
  const v6 = parseV6(host);
  return v6 !== undefined && v6.every((b) => b === 0);
};

const isLoopbackAddress = (host: string): boolean => {
  const v4 = parseV4(host);
  if (v4) return v4[0] === 127;
  const v6 = parseV6(host);
  return v6 !== undefined && v6.slice(0, 15).every((b) => b === 0) && v6[15] === 1;
};

export const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const SCOPE_PREFIX_RE = /^(@[A-Za-z0-9~-][A-Za-z0-9._~-]*)(?:\/([A-Za-z0-9._~-]*))?$/;
const NAME_PREFIX_RE = /^[A-Za-z0-9~][A-Za-z0-9._~-]*[-._]$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOSTPORT_RE = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):(\d{1,5})$/;

export function isValidPackageName(name: string): boolean {
  return name.length <= 214 && name !== "-" && PACKAGE_NAME_RE.test(name);
}

/**
 * Package-name prefix semantics (exact boundaries, no footguns):
 *  - `@scope` or `@scope/`  -> every package of that scope (`@scope/*`); never `@scopeevil/x`.
 *  - `@scope/part-`         -> packages of that scope whose name starts with `part-`.
 *  - `name-`                -> unscoped packages starting with `name-`.
 * A name part must end with a separator (`-`, `.` or `_`), otherwise the entry would
 * silently also match unrelated names (`foo` vs `foo-evil`); use `packages.allow` for an exact name.
 * Returns the normalised prefix, or undefined when the entry is invalid.
 */
export function normalisePrefix(prefix: string): string | undefined {
  if (prefix.length < 2 || prefix.length > 214) return undefined;
  if (prefix.startsWith("@")) {
    const m = SCOPE_PREFIX_RE.exec(prefix);
    if (!m) return undefined;
    const part = m[2];
    if (part === undefined || part === "") return `${m[1]}/`;
    return NAME_PREFIX_RE.test(part) ? `${m[1]}/${part}` : undefined;
  }
  return NAME_PREFIX_RE.test(prefix) ? prefix : undefined;
}

function obj(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(`${path}: expected an object`);
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) throw new ConfigError(`${path}: unknown key`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") throw new ConfigError(`${path}: expected a string`);
  return v;
}

function arr(v: unknown, path: string, max = 100_000): unknown[] {
  if (!Array.isArray(v)) throw new ConfigError(`${path}: expected an array`);
  if (v.length > max) throw new ConfigError(`${path}: too many entries`);
  return v;
}

/** Normalises `host:port` (lower-case, port 1-65535). Returns undefined when not strictly valid. */
export function parseHostPort(value: string): { host: string; port: number } | undefined {
  const m = HOSTPORT_RE.exec(value);
  if (!m) return undefined;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return undefined;
  const host = m[1] as string;
  // DNS labels: 1-63 chars of [a-z0-9-], not starting or ending with a hyphen, no empty labels.
  if (!host.split(".").every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return undefined;
  return { host, port };
}

function parseRegistry(raw: unknown, path: string): RegistryConfig {
  const o = obj(raw, path, ["id", "upstream", "pathPrefix", "default", "credential", "allowPrivateAddresses"]);
  const id = str(o.id, `${path}.id`);
  if (!ID_RE.test(id)) throw new ConfigError(`${path}.id: must match ${ID_RE}`);
  const upstream = str(o.upstream, `${path}.upstream`);
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new ConfigError(`${path}.upstream: not a URL`);
  }
  if (url.protocol !== "https:") throw new ConfigError(`${path}.upstream: must be an https origin`);
  if (url.username || url.password) throw new ConfigError(`${path}.upstream: must not contain userinfo`);
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ConfigError(`${path}.upstream: must be an origin only (use pathPrefix for a path)`);
  }
  if (!url.hostname) throw new ConfigError(`${path}.upstream: missing host`);
  if (o.allowPrivateAddresses !== undefined && typeof o.allowPrivateAddresses !== "boolean") {
    throw new ConfigError(`${path}.allowPrivateAddresses: expected a boolean`);
  }
  const allowPrivateAddresses = o.allowPrivateAddresses === true;
  if (!allowPrivateAddresses && (isIpLiteral(url.hostname) || looksNumeric(url.hostname))) {
    throw new ConfigError(`${path}.upstream: IP-literal hosts need allowPrivateAddresses: true`);
  }
  let pathPrefix = "";
  if (o.pathPrefix !== undefined) {
    pathPrefix = str(o.pathPrefix, `${path}.pathPrefix`);
    if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(pathPrefix) || pathPrefix.split("/").some((s) => s === "." || s === "..")) {
      throw new ConfigError(`${path}.pathPrefix: must be /segment[/segment...] of unreserved characters`);
    }
  }
  if (o.default !== undefined && typeof o.default !== "boolean") throw new ConfigError(`${path}.default: expected a boolean`);
  let credential: Credential | undefined;
  if (o.credential !== undefined) {
    const c = obj(o.credential, `${path}.credential`, ["type", "secret"]);
    const type = c.type;
    if (type !== "bearer" && type !== "basic") throw new ConfigError(`${path}.credential.type: must be bearer or basic`);
    try {
      credential = new Credential(type, str(c.secret, `${path}.credential.secret`));
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`${path}.credential.secret: invalid (${type === "basic" ? "username:password, " : ""}min 8 chars, no control characters)`);
    }
  }
  return { id, upstreamOrigin: url.origin, pathPrefix, isDefault: o.default === true, credential, allowPrivateAddresses };
}

/** Validates the untrusted JSON config. Throws ConfigError; the message never contains input values. */
export function parseConfig(raw: unknown): ProxyConfig {
  const o = obj(raw, "config", ["registries", "allowHosts", "packages", "limits", "dns", "listen", "allowClients", "discovery"]);

  const regsRaw = arr(o.registries, "config.registries", 32);
  if (regsRaw.length === 0) throw new ConfigError("config.registries: at least one registry is required");
  const registries = regsRaw.map((r, i) => parseRegistry(r, `config.registries[${i}]`));
  if (new Set(registries.map((r) => r.id)).size !== registries.length) throw new ConfigError("config.registries: duplicate id");
  const defaults = registries.filter((r) => r.isDefault);
  let finalRegistries = registries;
  if (registries.length === 1) {
    finalRegistries = registries.map((r) => ({ ...r, isDefault: true }));
  } else if (defaults.length !== 1) {
    throw new ConfigError("config.registries: with several registries exactly one must set default: true");
  }

  const allowHosts = new Set<string>();
  const allowPrivateHosts = new Set<string>();
  for (const [i, h] of arr(o.allowHosts ?? [], "config.allowHosts", 1000).entries()) {
    const path = `config.allowHosts[${i}]`;
    let text: string;
    let priv = false;
    if (typeof h === "string") {
      text = h;
    } else {
      const e = obj(h, path, ["host", "allowPrivateAddresses"]);
      text = str(e.host, `${path}.host`);
      if (e.allowPrivateAddresses !== undefined && typeof e.allowPrivateAddresses !== "boolean") throw new ConfigError(`${path}.allowPrivateAddresses: expected a boolean`);
      priv = e.allowPrivateAddresses === true;
    }
    const hp = parseHostPort(text);
    if (!hp) throw new ConfigError(`${path}: must be lower-case host:port`);
    if (!priv && (isIpLiteral(hp.host) || looksNumeric(hp.host))) throw new ConfigError(`${path}: IP-literal hosts need allowPrivateAddresses: true`);
    allowHosts.add(`${hp.host}:${hp.port}`);
    if (priv) allowPrivateHosts.add(`${hp.host}:${hp.port}`);
  }

  const pk = obj(o.packages ?? {}, "config.packages", ["allow", "allowPrefixes", "allowAll"]);
  if (pk.allowAll !== undefined && typeof pk.allowAll !== "boolean") throw new ConfigError("config.packages.allowAll: must be true or false");
  const allow = new Set<string>();
  for (const [i, n] of arr(pk.allow ?? [], "config.packages.allow").entries()) {
    const name = str(n, `config.packages.allow[${i}]`);
    if (!isValidPackageName(name)) throw new ConfigError(`config.packages.allow[${i}]: not a valid package name`);
    allow.add(name);
  }
  const allowPrefixes: string[] = [];
  for (const [i, p] of arr(pk.allowPrefixes ?? [], "config.packages.allowPrefixes", 10_000).entries()) {
    const prefix = normalisePrefix(str(p, `config.packages.allowPrefixes[${i}]`));
    if (prefix === undefined) {
      throw new ConfigError(`config.packages.allowPrefixes[${i}]: use "@scope", "@scope/part-" or "name-" (a name part must end in - . or _)`);
    }
    allowPrefixes.push(prefix);
  }

  const lim = obj(o.limits ?? {}, "config.limits", Object.keys(DEFAULT_LIMITS));
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const v = lim[key];
    if (v === undefined) continue;
    const [lo, hi] = LIMIT_RANGES[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
      throw new ConfigError(`config.limits.${key}: must be an integer in [${lo}, ${hi}]`);
    }
    limits[key] = v;
  }

  const discovery = o.discovery === undefined ? "off" : o.discovery;
  if (discovery !== "off" && discovery !== "audit") throw new ConfigError('config.discovery: must be "off" or "audit"');

  const dnsRaw = arr(o.dns, "config.dns", 8);
  if (dnsRaw.length === 0) throw new ConfigError("config.dns: at least one resolver IP is required");
  const dns = dnsRaw.map((d, i) => {
    const ip = str(d, `config.dns[${i}]`);
    if (isIP(ip) === 0) throw new ConfigError(`config.dns[${i}]: must be an IP address`);
    return ip;
  });

  const ls = obj(o.listen ?? {}, "config.listen", ["host", "cidr", "port"]);
  if (ls.host !== undefined && ls.cidr !== undefined) throw new ConfigError("config.listen: host and cidr are mutually exclusive");
  const host = ls.host === undefined ? "127.0.0.1" : str(ls.host, "config.listen.host");
  if (isIP(host) === 0) throw new ConfigError("config.listen.host: must be an IP address");
  if (isWildcardAddress(host)) {
    throw new ConfigError("config.listen.host: a wildcard address is refused (bind the internal-network address with listen.cidr)");
  }
  let listenCidr: string | undefined;
  let listenRange: ClientCidr | undefined;
  if (ls.cidr !== undefined) {
    listenCidr = str(ls.cidr, "config.listen.cidr");
    listenRange = parseClientCidr(listenCidr);
    if (!listenRange || listenRange.family !== 4 || listenRange.bits < 8 || listenRange.bits > 30) {
      throw new ConfigError("config.listen.cidr: must be an IPv4 CIDR between /8 and /30");
    }
  }
  const clientsRaw = o.allowClients === undefined ? [] : arr(o.allowClients, "config.allowClients", 16);
  const allowClients: ClientCidr[] = clientsRaw.map((c, i) => {
    const parsed = parseClientCidr(str(c, `config.allowClients[${i}]`));
    if (!parsed) throw new ConfigError(`config.allowClients[${i}]: must be a CIDR like 10.0.0.0/8`);
    return parsed;
  });
  if (allowClients.length === 0 && listenRange) allowClients.push(listenRange);
  if (allowClients.length === 0 && ls.cidr === undefined && !isLoopbackAddress(host)) {
    throw new ConfigError("config.allowClients: required when listening on a non-loopback address");
  }
  const port = ls.port === undefined ? 0 : ls.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError("config.listen.port: must be an integer 0-65535");
  }

  return Object.freeze({
    registries: Object.freeze(finalRegistries),
    allowHosts,
    allowPrivateHosts,
    discovery,
    packages: Object.freeze({ allow, allowPrefixes: Object.freeze(allowPrefixes), allowAll: pk.allowAll === true }),
    limits: Object.freeze(limits),
    dns: Object.freeze(dns),
    listen: Object.freeze({ host, ...(listenCidr !== undefined ? { cidr: listenCidr } : {}), port }),
    allowClients: Object.freeze(allowClients),
  });
}

/** Every raw secret string in the config (for redaction). */
export function configSecrets(config: ProxyConfig): string[] {
  return config.registries.flatMap((r) => r.credential?.material() ?? []);
}
