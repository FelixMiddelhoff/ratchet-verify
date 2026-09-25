import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { RegistryProxyInfo } from "../report/index.js";
import type { ResolvedIsolation } from "../sandbox/index.js";
import type { SandboxProxy } from "../sandbox/proxy-client.js";
import {
  allowedPackageNames, buildProxyConfig, proxyRegistryUrl, PUBLIC_REGISTRY_ALIASES, sourceRegistries, withProxyTopology, type Engine, type UrlMapping,
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
  /** Lockfile states under test (old and new): their package names form the allowlist. */
  lockfiles: readonly string[];
  manifestNames: readonly string[];
  /** The project `.npmrc` to take registries and credentials from, when it must not be the working tree's (--base: the base ref's). `{ text: undefined }` = none. */
  projectNpmrc?: { text: string | undefined };
  log?: (line: string) => void;
  /** Test seams. */
  homeDir?: string;
  engine?: Engine;
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
  if (!config.registryAuth) return fn(undefined);
  if (!isolation.container) {
    throw new Error('registryAuth needs container isolation (docker or podman): a temp-dir sandbox cannot be confined to the registry proxy, and ratchet never runs unprotected instead. Use --isolation container.');
  }
  const userRc = options.env.NPM_CONFIG_USERCONFIG ?? join(options.homeDir ?? homedir(), ".npmrc");
  const projectRc = options.projectNpmrc ? options.projectNpmrc.text : await readIfExists(join(options.projectDir, ".npmrc"));
  const layers = [projectRc, await readIfExists(userRc)].filter((t): t is string => t !== undefined);
  const sourced = sourceRegistries(layers, options.env, config.registryPrivateHosts);
  const allowlistOn = config.registryAllowlist;
  const names = allowedPackageNames(options.lockfiles, options.manifestNames);
  const built = buildProxyConfig({
    registries: sourced.registries,
    allowHosts: config.registryAllowHosts,
    packages: allowlistOn ? { allow: names } : { allowAll: true },
    discovery: "audit",
    dns: config.registryDns,
    limits: {},
  });
  for (const note of sourced.notes) options.log?.(`registry proxy: ${note}`);
  if (!allowlistOn) options.log?.("registry proxy: package allowlist is OFF (registryAllowlist=false)");

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
          host: `${new URL(r.upstream).host}${r.pathPrefix ?? ""}`,
          credential: r.credential?.type ?? "none",
          ...(clientById.get(r.id)?.scopes ? { scopes: [...clientById.get(r.id)!.scopes!] } : {}),
        })),
        allowlist: allowlistOn ? "on" : "off",
        allowHosts: [...config.registryAllowHosts],
        allowedPackages: allowlistOn ? names.length : 0,
        discoveredPackages: topology.discoveredNames(),
        requestsAllowed: audit.filter((e) => e.decision === "allow").length,
        requestsDenied: audit.filter((e) => e.decision === "deny").length,
        auditTruncated: topology.auditTruncated(),
      };
    };
    return fn({ proxy, info });
  });
}
