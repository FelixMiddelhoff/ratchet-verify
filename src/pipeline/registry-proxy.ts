import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { AuditEntry } from "../sandbox/registry-proxy/index.js";
import type { RegistryProxyInfo } from "../report/index.js";
import type { ResolvedIsolation } from "../sandbox/index.js";
import type { SandboxProxy } from "../sandbox/proxy-client.js";
import {
  allowedPackageNames, buildProxyConfig, proxyRegistryUrl, PUBLIC_REGISTRY_ALIASES, sourceRegistries, withProxyTopology, yarnrcToNpmrc, type Engine, type UrlMapping,
} from "../sandbox/proxy-topology/index.js";

export interface RegistryProxyRun {
  proxy: SandboxProxy;
  /** Snapshot for the report; read after all work is done. */
  info(): RegistryProxyInfo;
}

export interface RegistryProxyOptions {
  config: Config;
  isolation: ResolvedIsolation;
  projectDir: string;
  env: NodeJS.ProcessEnv;
  /** Base-ref lockfile text (already reviewed, not the checkout under test): its package names anchor the allowlist. */
  baseLockfileText: string;
  /** Base-ref manifest's dependency names (same trust level as baseLockfileText). */
  baseManifestNames: readonly string[];
  /** Names of the dependencies actually changed between old and new lockfile: the ones ratchet is testing. */
  candidateNames: readonly string[];
  /** The project `.npmrc` to take registries and credentials from, when it must not be the working tree's (--base: the base ref's). `{ text: undefined }` = none. */
  projectNpmrc?: { text: string | undefined };
  /** Same for the project `.yarnrc.yml` (yarn berry registry settings, highest precedence when present). */
  projectYarnrc?: { text: string | undefined };
  log?: (line: string) => void;
  /** Test seams. */
  homeDir?: string;
  engine?: Engine;
}

/** Refusals a normal run causes: npm's own `/-/` API probes, and ratchet's isolation self-test, which asks the proxy for `/` to prove it is reachable. */
const BENIGN_DENIALS = new Set(["denied:npm-api-path", "invalid:empty-segment"]);

export function suspiciousDenials(audit: readonly AuditEntry[]): RegistryProxyInfo["suspicious"] {
  const counts = new Map<string, { class: string; reason: string; name?: string; count: number }>();
  for (const e of audit) {
    if (e.decision !== "deny" || BENIGN_DENIALS.has(`${e.class}:${e.reason}`)) continue;
    const key = `${e.class}
${e.reason}
${e.name ?? ""}`;
    const entry = counts.get(key) ?? { class: e.class, reason: e.reason, ...(e.name ? { name: e.name } : {}), count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.class.localeCompare(b.class) || a.reason.localeCompare(b.reason)).slice(0, 20);
}

const readIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/**
 * Opt-in (`registryAuth`) registry proxy for one pipeline run. Disabled: `fn` gets `undefined`. Enabled: needs container isolation
 * (temp-dir cannot confine the sandbox to the proxy, so there is no fallback: an error), reads registries and credentials from the
 * project and user `.npmrc`, starts the proxy topology, runs `fn`, and always tears the topology down.
 */
export async function withRegistryProxy<T>(options: RegistryProxyOptions, fn: (run: RegistryProxyRun | undefined) => Promise<T>): Promise<T> {
  const { config, isolation } = options;
  const networkOnly = config.containerNetwork === "proxy";
  if (!config.registryAuth && !networkOnly) return fn(undefined);
  if (!isolation.container) {
    const flag = config.registryAuth ? "registryAuth" : '"--network proxy"';
    throw new Error(`${flag} needs container isolation (docker or podman): a temp-dir sandbox cannot be confined to the registry proxy, and ratchet never runs unprotected instead. Use --isolation container.`);
  }
  // "--network proxy" alone (no registryAuth): pure network restriction, not registry redirection. Never reads
  // .npmrc/.yarnrc.yml or credentials; the sandbox only ever reaches the public npm registry through the proxy.
  let layers: string[] = [];
  if (config.registryAuth) {
    const userRc = options.env.NPM_CONFIG_USERCONFIG ?? join(options.homeDir ?? homedir(), ".npmrc");
    const projectRc = options.projectNpmrc ? options.projectNpmrc.text : await readIfExists(join(options.projectDir, ".npmrc"));
    const yarnRc = options.projectYarnrc ? options.projectYarnrc.text : await readIfExists(join(options.projectDir, ".yarnrc.yml"));
    layers = [yarnRc === undefined ? undefined : yarnrcToNpmrc(yarnRc), projectRc, await readIfExists(userRc)].filter((t): t is string => t !== undefined);
  }
  const home = options.homeDir ?? homedir();
  const files = { home, read: (path: string): string | undefined => { try { return readFileSync(path, "utf8"); } catch { return undefined; } } };
  const sourced = sourceRegistries(layers, options.env, config.registryAuth ? config.registryPrivateHosts : [], files);
  if (networkOnly && !config.registryAuth) options.log?.("registry proxy: network-only mode (--network proxy): egress restricted to the npm registry, no custom registry or credentials read");
  const allowlistOn = config.registryAllowlist;
  const names = allowedPackageNames(options.baseLockfileText, options.baseManifestNames, options.candidateNames);
  const built = buildProxyConfig({
    registries: sourced.registries,
    allowHosts: config.registryAllowHosts,
    connectHosts: config.registryConnectHosts,
    packages: allowlistOn ? { allow: names } : { allowAll: true },
    discovery: config.registryDiscovery ? "audit" : "off",
    dns: config.registryDns,
    limits: {},
  });
  for (const note of sourced.notes) options.log?.(`registry proxy: ${note}`);
  if (!allowlistOn) options.log?.("registry proxy: package allowlist is OFF (registryAllowlist=false)");
  if (allowlistOn && !config.registryDiscovery) options.log?.("registry proxy: package discovery is OFF (registryDiscovery=false): a transitive dependency not already in the base lockfile/manifest or under test is denied, not just audited");

  const caFile = config.registryCaFile === undefined ? undefined : isAbsolute(config.registryCaFile) ? config.registryCaFile : resolve(options.projectDir, config.registryCaFile);
  return withProxyTopology({ settings: isolation.container, config: built, engine: options.engine, extraCaFile: caFile, log: options.log }, async (topology) => {
    const clientById = new Map(sourced.client.map((c) => [c.id, c]));
    const lockUrlMappings: UrlMapping[] = sourced.upstreamPrefixes.map((u) => ({ from: u.prefix, to: proxyRegistryUrl(topology.proxyUrl, clientById.get(u.id)!) }));
    const main = sourced.upstreamPrefixes.find((u) => u.id === "main");
    if (main?.prefix === PUBLIC_REGISTRY_ALIASES[0]) for (const alias of PUBLIC_REGISTRY_ALIASES.slice(1)) lockUrlMappings.push({ from: alias, to: proxyRegistryUrl(topology.proxyUrl, clientById.get("main")!) });
    const proxy: SandboxProxy = { network: topology.networkName, proxyUrl: topology.proxyUrl, registries: sourced.client, lockUrlMappings };
    const info = (): RegistryProxyInfo => {
      const audit = topology.audit();
      return {
        registries: sourced.registries.map((r) => ({
          id: r.id,
          host: new URL(r.upstream).host, // never the path: it may carry a secret (Cloudsmith/Gemfury style URLs)
          credential: r.credential?.type ?? "none",
          ...(r.clientCertificate ? { clientCertificate: true as const } : {}),
          ...(clientById.get(r.id)?.scopes ? { scopes: [...clientById.get(r.id)!.scopes!] } : {}),
        })),
        allowlist: allowlistOn ? "on" : "off",
        allowHosts: [...config.registryAllowHosts],
        connectHosts: [...config.registryConnectHosts],
        allowedPackages: allowlistOn ? names.length : 0,
        discoveredPackages: topology.discoveredNames(),
        requestsAllowed: audit.filter((e) => e.decision === "allow").length,
        requestsDenied: audit.filter((e) => e.decision === "deny").length,
        suspicious: suspiciousDenials(audit),
        auditTruncated: topology.auditTruncated(),
      };
    };
    return fn({ proxy, info });
  });
}
