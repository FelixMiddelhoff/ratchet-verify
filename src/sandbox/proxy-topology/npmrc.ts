/** A registry the sandbox may use through the proxy: the default one (unprefixed) or a scope routed under `/_r/<id>/`. */
export interface ClientRegistry {
  id: string;
  isDefault?: boolean;
  /** npm scope (`@acme`) served by this registry; only meaningful for non-default registries. */
  scopes?: readonly string[];
}

export interface RewrittenNpmrc {
  text: string;
  /** Names (never values) of the settings removed from the project's file. */
  dropped: string[];
}

/** Settings that pick a registry, authenticate, or reroute the network: the proxy owns all of them. */
const OWNED_KEYS = new Set([
  "registry", "replace-registry-host", "always-auth", "_auth", "_authtoken", "_password", "username", "email",
  "proxy", "https-proxy", "noproxy", "strict-ssl", "cafile", "ca", "cert", "key", "certfile", "keyfile", "userconfig", "globalconfig",
]);

const isOwned = (key: string): boolean => {
  const k = key.trim().toLowerCase();
  return OWNED_KEYS.has(k) || k.startsWith("//") || /^@[^:]+:registry$/.test(k) || /:(_auth|_authtoken|_password|username|email|certfile|keyfile|cafile)$/.test(k);
};

export const proxyRegistryUrl = (proxyUrl: string, registry: ClientRegistry): string => `${proxyUrl.replace(/\/+$/, "")}${registry.isDefault === false ? `/_r/${registry.id}` : ""}/`;

/**
 * The sandbox's `.npmrc` (npm and pnpm read it): the project's own file with every registry, auth and network setting
 * removed, then the proxy's registries appended. Other settings (`legacy-peer-deps`, `engine-strict`, ...) stay because they
 * change what an install does. `${VAR}` references are never expanded here and the sandbox has none of those variables.
 */
export function rewriteNpmrc(projectNpmrc: string | undefined, proxyUrl: string, registries: readonly ClientRegistry[]): RewrittenNpmrc {
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const line of (projectNpmrc ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (trimmed === "" || trimmed.startsWith(";") || trimmed.startsWith("#") || eq < 1) {
      kept.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq);
    if (isOwned(key)) {
      // Auth keys carry the host in the name (`//host/:_authToken`): report the setting, not the host or the value.
      dropped.push(key.trim().startsWith("//") ? key.trim().replace(/^\/\/[^:]*:?/, "//<host>/:") : key.trim());
    } else kept.push(line);
  }
  const defaults = registries.filter((r) => r.isDefault !== false);
  if (defaults.length !== 1) throw new Error(`exactly one default registry is required, got ${defaults.length}`);
  const own = [`registry=${proxyRegistryUrl(proxyUrl, defaults[0]!)}`, "replace-registry-host=always", "audit=false", "fund=false"];
  for (const r of registries) for (const scope of r.scopes ?? []) own.push(`${scope}:registry=${proxyRegistryUrl(proxyUrl, r)}`);
  return { text: `${kept.join("\n").replace(/\n+$/, "")}${kept.length > 0 ? "\n" : ""}${own.join("\n")}\n`, dropped };
}
