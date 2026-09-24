import { readFile } from "node:fs/promises";
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
}

export const DEFAULT_CONFIG: Config = {
  ignore: [],
  maxInstalls: 10,
  testTimeoutMs: 10 * 60 * 1000,
  failOn: "broken",
  isolation: "temp-dir",
  containerRuntime: "auto",
  containerNetwork: "tests-offline",
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
  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULT_CONFIG) && key !== "containerImage");
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
  if (config.containerImage !== undefined && (typeof config.containerImage !== "string" || config.containerImage === "")) {
    throw new Error(`${CONFIG_FILE}: "containerImage" must be a non-empty image name`);
  }
  return config;
}
