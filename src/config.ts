import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { VerdictStatus } from "./report/index.js";

export interface Config {
  /** Dependency names to leave out of the verdict entirely. */
  ignore: string[];
  /** Cap on installs per bisection; past it the result is a narrowed range. */
  maxInstalls: number;
  testTimeoutMs: number;
  /** Exit non-zero when the overall verdict is at least this severe. */
  failOn: Exclude<VerdictStatus, "safe">;
  /** "container" runs installs and tests in docker/podman; "auto" uses one when available. */
  isolation: "temp-dir" | "container" | "auto";
  containerRuntime: "auto" | "docker" | "podman";
  /** Image for container isolation; defaults to node:24. */
  containerImage?: string;
  /** Container mode: "tests-offline" (default) runs the test phase with no network; "open" keeps it. */
  containerNetwork: "tests-offline" | "open";
  /** Opt-in: install through a registry proxy that holds the credentials from `.npmrc`, so private registries work. Needs container isolation. */
  registryAuth: boolean;
  /** With registryAuth: only package names from the lockfiles (plus their dependencies, reported) pass the proxy. Turning it off is reported. */
  registryAllowlist: boolean;
  /** With registryAuth: extra `host[:port]` the proxy may tunnel to (CDN, binary downloads); port defaults to 443. */
  registryAllowHosts: string[];
  /** With registryAuth: resolver IPs the proxy uses for registry host names (it never uses the system resolver); set your corporate DNS for internal registries. */
  registryDns: string[];
  /** With registryAuth: registry hosts that may resolve to private addresses (an internal Artifactory on 10.x). Everything else is refused by the proxy's SSRF guard. */
  registryPrivateHosts: string[];
  /** With registryAuth: extra CA bundle (PEM file) the proxy trusts for registries with a corporate certificate. */
  registryCaFile?: string;
}

export const DEFAULT_CONFIG: Config = {
  ignore: [],
  maxInstalls: 10,
  testTimeoutMs: 10 * 60 * 1000,
  failOn: "broken",
  isolation: "temp-dir",
  containerRuntime: "auto",
  containerNetwork: "tests-offline",
  registryAuth: false,
  registryAllowlist: true,
  registryAllowHosts: [],
  registryDns: ["1.1.1.1", "9.9.9.9"],
  registryPrivateHosts: [],
};

export const CONFIG_FILE = ".ratchetrc";

/** Unknown keys are errors: a typo'd option silently ignored would hide a weakened check. */
export async function loadConfig(projectDir: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(join(projectDir, CONFIG_FILE), "utf8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  return parseConfig(text);
}

export function parseConfig(text: string): Config {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULT_CONFIG) && key !== "containerImage" && key !== "registryCaFile");
  if (unknown.length > 0) throw new Error(`${CONFIG_FILE}: unknown option(s): ${unknown.join(", ")}`);

  const config = { ...DEFAULT_CONFIG, ...raw } as Config;
  if (!Array.isArray(config.ignore) || config.ignore.some((n) => typeof n !== "string")) {
    throw new Error(`${CONFIG_FILE}: "ignore" must be an array of package names`);
  }
  if (!Number.isInteger(config.maxInstalls) || config.maxInstalls < 1) {
    throw new Error(`${CONFIG_FILE}: "maxInstalls" must be a positive integer`);
  }
  if (!Number.isInteger(config.testTimeoutMs) || config.testTimeoutMs < 1) {
    throw new Error(`${CONFIG_FILE}: "testTimeoutMs" must be a positive integer`);
  }
  if (config.failOn !== "broken" && config.failOn !== "risky") {
    throw new Error(`${CONFIG_FILE}: "failOn" must be "broken" or "risky"`);
  }
  if (!["temp-dir", "container", "auto"].includes(config.isolation)) {
    throw new Error(`${CONFIG_FILE}: "isolation" must be "temp-dir", "container" or "auto"`);
  }
  if (!["auto", "docker", "podman"].includes(config.containerRuntime)) {
    throw new Error(`${CONFIG_FILE}: "containerRuntime" must be "auto", "docker" or "podman"`);
  }
  if (!["tests-offline", "open"].includes(config.containerNetwork)) {
    throw new Error(`${CONFIG_FILE}: "containerNetwork" must be "tests-offline" or "open"`);
  }
  if (typeof config.registryAuth !== "boolean") throw new Error(`${CONFIG_FILE}: "registryAuth" must be true or false`);
  if (typeof config.registryAllowlist !== "boolean") throw new Error(`${CONFIG_FILE}: "registryAllowlist" must be true or false`);
  if (!Array.isArray(config.registryAllowHosts) || config.registryAllowHosts.some((h) => typeof h !== "string" || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(h))) {
    throw new Error(`${CONFIG_FILE}: "registryAllowHosts" must be an array of "host" or "host:port" strings`);
  }
  if (!Array.isArray(config.registryDns) || config.registryDns.length === 0 || config.registryDns.some((d) => typeof d !== "string" || isIP(d) === 0)) {
    throw new Error(`${CONFIG_FILE}: "registryDns" must be a non-empty array of IP addresses`);
  }
  if (!Array.isArray(config.registryPrivateHosts) || config.registryPrivateHosts.some((h) => typeof h !== "string" || !/^[A-Za-z0-9.-]+$/.test(h))) {
    throw new Error(`${CONFIG_FILE}: "registryPrivateHosts" must be an array of host names (no port, no scheme)`);
  }
  if (config.registryCaFile !== undefined && (typeof config.registryCaFile !== "string" || config.registryCaFile === "")) {
    throw new Error(`${CONFIG_FILE}: "registryCaFile" must be a path`);
  }
  if (config.containerImage !== undefined && (typeof config.containerImage !== "string" || config.containerImage === "")) {
    throw new Error(`${CONFIG_FILE}: "containerImage" must be a non-empty image name`);
  }
  return config;
}
