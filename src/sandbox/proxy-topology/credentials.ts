import { Credential } from "../registry-proxy/index.js";
import type { RegistryInput } from "./build-config.js";
import type { ClientRegistry } from "./npmrc.js";

export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

export interface SourcedRegistries {
  registries: RegistryInput[];
  /** How the sandbox's package manager addresses each registry (default unprefixed, others under `/_r/<id>/`). */
  client: ClientRegistry[];
  /** Upstream URL prefix (with trailing slash) each id serves: the lockfile URLs to point at the proxy. */
  upstreamPrefixes: Array<{ id: string; prefix: string }>;
  /** Human-readable, never containing a token, a password or a `${VAR}` value. */
  notes: string[];
}

export class CredentialSourceError extends Error {}

/** `key=value` lines of an `.npmrc` (comments and blank lines skipped). */
export function parseNpmrc(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf("=");
    if (t === "" || t.startsWith(";") || t.startsWith("#") || eq < 1) continue;
    out.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1"));
  }
  return out;
}

/** Expands `${NAME}` from `env`; unset names are collected (names only) instead of expanding to an empty credential. */
function expand(value: string, env: Readonly<Record<string, string | undefined>>, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      missing.add(name);
      return "";
    }
    return v;
  });
}

const nerf = (url: URL): string => `//${url.host}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;

/**
 * Turns the user's npm configuration into proxy registries and credentials. `layers` are `.npmrc` texts, the highest precedence
 * first (project file, then user file); only registries and their auth are read, nothing else is forwarded anywhere. Auth is matched
 * npm-style by the longest `//host/path/` prefix. Supported: `_authToken` (bearer), `_auth` (basic, base64 `user:pass`),
 * `username` + `_password` (basic, base64 password). A `${VAR}` that is unset is an error naming the variable, never an empty token.
 */
export function sourceRegistries(layers: readonly string[], env: Readonly<Record<string, string | undefined>>): SourcedRegistries {
  const merged = new Map<string, string>();
  for (const layer of [...layers].reverse()) for (const [k, v] of parseNpmrc(layer)) merged.set(k, v);
  const missing = new Set<string>();
  const get = (k: string): string | undefined => {
    const v = merged.get(k);
    return v === undefined ? undefined : expand(v, env, missing);
  };

  const assertNoMissing = (): void => {
    if (missing.size > 0) throw new CredentialSourceError(`environment variable(s) referenced by .npmrc but not set: ${[...missing].sort().join(", ")}`);
  };
  const routes: Array<{ url: URL; scopes: string[]; isDefault: boolean }> = [];
  const add = (raw: string, scope: string | undefined, isDefault: boolean): void => {
    assertNoMissing();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CredentialSourceError(`${scope ? `${scope}:registry` : "registry"} is not a valid URL`);
    }
    if (url.protocol !== "https:") throw new CredentialSourceError(`${scope ? `${scope}:registry` : "registry"} must be an https URL: the proxy only talks to https registries`);
    if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") throw new CredentialSourceError("registry URLs must not contain credentials, a query or a fragment");
    const existing = routes.find((r) => r.url.origin === url.origin && nerf(r.url) === nerf(url));
    if (existing) {
      if (scope) existing.scopes.push(scope);
      else existing.isDefault = true;
      return;
    }
    routes.push({ url, scopes: scope ? [scope] : [], isDefault });
  };
  add(get("registry") ?? PUBLIC_REGISTRY, undefined, true);
  for (const key of [...merged.keys()].sort()) {
    const m = /^(@[^:]+):registry$/.exec(key);
    if (m) add(get(key)!, m[1]!, false);
  }

  const registries: RegistryInput[] = [];
  const client: ClientRegistry[] = [];
  const upstreamPrefixes: SourcedRegistries["upstreamPrefixes"] = [];
  const notes: string[] = [];
  routes.forEach((r, i) => {
    const id = r.isDefault ? "main" : `r${i}`;
    const pathPrefix = r.url.pathname.replace(/\/+$/, "");
    const credential = credentialFor(r.url, merged, get);
    registries.push({ id, upstream: r.url.origin, ...(pathPrefix !== "" ? { pathPrefix } : {}), isDefault: r.isDefault, ...(credential ? { credential } : {}) });
    client.push({ id, isDefault: r.isDefault, ...(r.scopes.length > 0 ? { scopes: r.scopes } : {}) });
    upstreamPrefixes.push({ id, prefix: `${r.url.origin}${pathPrefix}/` });
    notes.push(`${id}: ${r.url.origin}${pathPrefix}/ (${credential ? `${credential.type} credential from .npmrc` : "no credential"})${r.scopes.length ? `, scopes ${r.scopes.join(", ")}` : ""}`);
  });
  assertNoMissing();
  return { registries, client, upstreamPrefixes, notes };
}

function credentialFor(url: URL, merged: ReadonlyMap<string, string>, get: (k: string) => string | undefined): Credential | undefined {
  // Longest matching nerf-dart prefix wins: `//host/a/b/` beats `//host/`.
  const want = nerf(url);
  const prefixes = new Set<string>();
  for (const key of merged.keys()) {
    const m = /^(\/\/.*\/):(_authToken|_auth|_password|username)$/.exec(key);
    if (m && want.startsWith(m[1]!)) prefixes.add(m[1]!);
  }
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    const token = get(`${prefix}:_authToken`);
    if (token) return new Credential("bearer", token);
    const auth = get(`${prefix}:_auth`);
    if (auth) {
      const decoded = Buffer.from(auth, "base64").toString("utf8");
      if (decoded.includes(":")) return new Credential("basic", decoded);
    }
    const user = get(`${prefix}:username`);
    const pass = get(`${prefix}:_password`);
    if (user && pass) return new Credential("basic", `${user}:${Buffer.from(pass, "base64").toString("utf8")}`);
  }
  return undefined;
}
