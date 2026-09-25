import { isAbsolute } from "node:path";
import { CONFIG_FILE, DEFAULT_CONFIG, parseConfig, type Config } from "../config.js";
import type { GitReader } from "./main.js";

/**
 * Registry settings decide where a credential is sent (host, DNS, CA, private-address exemption), so a pull request must not
 * be able to change them: a hostile PR could point `.npmrc` at its own server and ask for `${NPM_TOKEN}`. With `--base` they are
 * therefore read from the base ref (already reviewed and merged), never from the checkout under test. Explicit command-line
 * flags still win: they come from whoever runs ratchet.
 */
export const TRUSTED_REGISTRY_KEYS = ["registryAuth", "registryAllowlist", "registryAllowHosts", "registryDns", "registryPrivateHosts", "registryCaFile"] as const;

export interface TrustedRegistrySettings {
  /** Text of the project `.npmrc` at the base ref; undefined = the base has none. */
  npmrc: string | undefined;
  notes: string[];
}

export async function applyTrustedRegistryConfig(config: Config, base: string, reader: GitReader): Promise<TrustedRegistrySettings> {
  const tree = new Set(await reader.list());
  const notes: string[] = [];
  const baseConfig = tree.has(CONFIG_FILE) ? parseConfig(await reader.read(CONFIG_FILE)) : { ...DEFAULT_CONFIG };
  const changed: string[] = [];
  for (const key of TRUSTED_REGISTRY_KEYS) {
    if (JSON.stringify(config[key]) !== JSON.stringify(baseConfig[key])) changed.push(key);
    (config as unknown as Record<string, unknown>)[key] = baseConfig[key];
  }
  if (changed.length > 0) notes.push(`registry settings (${changed.join(", ")}) in the working tree's ${CONFIG_FILE} differ from ${base} and are ignored: credentials only follow the base ref's settings`);
  if (config.registryCaFile !== undefined && !isAbsolute(config.registryCaFile)) {
    throw new Error(`registryCaFile "${config.registryCaFile}" must be an absolute path when --base is used: a relative file would come from the checkout under test`);
  }
  return { npmrc: tree.has(".npmrc") ? await reader.read(".npmrc") : undefined, notes };
}
