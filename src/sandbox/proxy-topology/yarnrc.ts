import { proxyRegistryUrl, type ClientRegistry, type RewrittenNpmrc } from "./npmrc.js";

const defaultRegistry = (registries: readonly ClientRegistry[]): ClientRegistry => {
  const defaults = registries.filter((r) => r.isDefault !== false);
  if (defaults.length !== 1) throw new Error(`exactly one default registry is required, got ${defaults.length}`);
  return defaults[0]!;
};

const CLASSIC_OWNED = new Set(["registry", "always-auth", "_auth", "_authtoken", "_password", "username", "email", "proxy", "https-proxy", "noproxy", "strict-ssl", "cafile", "ca", "cert", "key", "certfile", "keyfile"]);
const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, "$1");

/**
 * Yarn classic's `.yarnrc` (`key "value"` lines; classic also reads the sandbox `.npmrc`, see `rewriteNpmrc`): the
 * project's file without registry, auth and network settings (`yarn-path`, `--install.*` flags stay), proxy registries appended.
 */
export function rewriteYarnrcClassic(projectYarnrc: string | undefined, proxyUrl: string, registries: readonly ClientRegistry[]): RewrittenNpmrc {
  const def = defaultRegistry(registries);
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const line of (projectYarnrc ?? "").split(/\r?\n/)) {
    const t = line.trim();
    const m = /^("[^"]*"|[^\s"]+)(?:\s+|\s*=\s*)/.exec(t);
    if (t === "" || t.startsWith("#") || !m) {
      kept.push(line);
      continue;
    }
    const key = unquote(m[1]!).toLowerCase();
    if (CLASSIC_OWNED.has(key) || /^@[^:]+:registry$/.test(key) || key.startsWith("//") || /:(_auth|_authtoken|_password|username|email)$/.test(key)) dropped.push(key.startsWith("//") ? "//<host>/:auth" : key);
    else kept.push(line);
  }
  const own = [`registry "${proxyRegistryUrl(proxyUrl, def)}"`];
  for (const r of registries) for (const scope of r.scopes ?? []) own.push(`"${scope}:registry" "${proxyRegistryUrl(proxyUrl, r)}"`);
  const body = kept.join("\n").trim();
  return { text: `${body === "" ? "" : `${body}\n`}${own.join("\n")}\n`, dropped };
}

const BERRY_OWNED = new Set([
  "npmregistryserver", "npmscopes", "npmregistries", "npmauthtoken", "npmauthident", "npmalwaysauth", "npmpublishregistry",
  "httpproxy", "httpsproxy", "cafilepath", "enablestrictssl", "unsafehttpwhitelist", "networksettings", "enablenetwork", "enabletelemetry", "httpretry", "httptimeout",
]);

/**
 * Yarn berry's `.yarnrc.yml`: top-level registry, auth and network keys (with their indented blocks) are removed, every other
 * top-level key is kept verbatim (`nodeLinker`, `plugins`, `yarnPath`, ...). No YAML parser: only column-0 keys are recognised,
 * which is how these settings are written; a key spelled another way (flow style on one line) is still a column-0 key here.
 */
export function rewriteYarnrcBerry(projectYml: string | undefined, proxyUrl: string, registries: readonly ClientRegistry[]): RewrittenNpmrc {
  const def = defaultRegistry(registries);
  const dropped: string[] = [];
  const kept: string[] = [];
  let skipping = false;
  for (const line of (projectYml ?? "").split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*|"[^"]*"|'[^']*')\s*:/.exec(line);
    if (top) {
      const key = unquote(top[1]!.replace(/^'(.*)'$/, "$1"));
      skipping = BERRY_OWNED.has(key.toLowerCase());
      if (skipping) dropped.push(key);
    } else if (skipping && (line.trim() === "" || /^\s/.test(line) || line.startsWith("-"))) continue;
    else skipping = false;
    if (!skipping) kept.push(line);
  }
  const host = new URL(proxyUrl).hostname;
  const scoped = registries.flatMap((r) => (r.scopes ?? []).map((s) => [s.replace(/^@/, ""), r] as const));
  const own = [
    `npmRegistryServer: "${proxyRegistryUrl(proxyUrl, def)}"`,
    `unsafeHttpWhitelist:\n  - "${host}"`,
    "enableTelemetry: false",
    ...(scoped.length > 0 ? ["npmScopes:", ...scoped.map(([s, r]) => `  ${JSON.stringify(s)}:\n    npmRegistryServer: "${proxyRegistryUrl(proxyUrl, r)}"`)] : []),
  ];
  const body = kept.join("\n").trim();
  return { text: `${body === "" ? "" : `${body}\n`}${own.join("\n")}\n`, dropped };
}
