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
}

export const DEFAULT_CONFIG: Config = {
  ignore: [],
  maxInstalls: 10,
  testTimeoutMs: 10 * 60 * 1000,
  failOn: "broken",
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
  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULT_CONFIG));
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
  return config;
}
