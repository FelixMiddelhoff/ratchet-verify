/**
 * v2 leftover item: a config file, mirroring src/config.ts's shape and validation style
 * (unknown keys rejected, each field validated) at python-module's much smaller option set —
 * no registry-proxy settings exist here, those are npm-registry-specific. CLI flags always
 * win over the config file, same precedence as the npm core.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PythonLockfileName = "uv.lock" | "poetry.lock" | "requirements.txt";

export interface PythonConfig {
  lockfileName?: PythonLockfileName;
  testCommand?: string[];
  containerImage?: string;
  maxInstalls: number;
  testTimeoutMs: number;
  installTimeoutMs: number;
  format: "text" | "json" | "sarif";
}

export const DEFAULT_PYTHON_CONFIG: PythonConfig = {
  maxInstalls: 10,
  testTimeoutMs: 10 * 60 * 1000,
  installTimeoutMs: 10 * 60 * 1000,
  format: "text",
};

export const PYTHON_CONFIG_FILE = ".ratchetrc.python";

/** Missing file is not an error: every field just keeps its default. */
export async function loadPythonConfig(projectDir: string): Promise<PythonConfig> {
  let text: string;
  try {
    text = await readFile(join(projectDir, PYTHON_CONFIG_FILE), "utf8");
  } catch {
    return { ...DEFAULT_PYTHON_CONFIG };
  }
  return parsePythonConfig(text);
}

const LOCKFILE_NAMES: PythonLockfileName[] = ["uv.lock", "poetry.lock", "requirements.txt"];
const FORMATS = ["text", "json", "sarif"];

/** Unknown keys are errors: a typo'd option silently ignored would hide a weakened check. */
export function parsePythonConfig(text: string): PythonConfig {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const known = new Set(["lockfileName", "testCommand", "containerImage", "maxInstalls", "testTimeoutMs", "installTimeoutMs", "format"]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`${PYTHON_CONFIG_FILE}: unknown option(s): ${unknown.join(", ")}`);

  const config = { ...DEFAULT_PYTHON_CONFIG, ...raw } as PythonConfig;
  if (config.lockfileName !== undefined && !LOCKFILE_NAMES.includes(config.lockfileName)) {
    throw new Error(`${PYTHON_CONFIG_FILE}: "lockfileName" must be one of ${LOCKFILE_NAMES.join(", ")}`);
  }
  if (config.testCommand !== undefined && (!Array.isArray(config.testCommand) || config.testCommand.length === 0 || config.testCommand.some((c) => typeof c !== "string"))) {
    throw new Error(`${PYTHON_CONFIG_FILE}: "testCommand" must be a non-empty array of strings`);
  }
  if (config.containerImage !== undefined && (typeof config.containerImage !== "string" || config.containerImage === "")) {
    throw new Error(`${PYTHON_CONFIG_FILE}: "containerImage" must be a non-empty image name`);
  }
  if (!Number.isInteger(config.maxInstalls) || config.maxInstalls < 1) {
    throw new Error(`${PYTHON_CONFIG_FILE}: "maxInstalls" must be a positive integer`);
  }
  if (!Number.isInteger(config.testTimeoutMs) || config.testTimeoutMs < 1) {
    throw new Error(`${PYTHON_CONFIG_FILE}: "testTimeoutMs" must be a positive integer`);
  }
  if (!Number.isInteger(config.installTimeoutMs) || config.installTimeoutMs < 1) {
    throw new Error(`${PYTHON_CONFIG_FILE}: "installTimeoutMs" must be a positive integer`);
  }
  if (!FORMATS.includes(config.format)) {
    throw new Error(`${PYTHON_CONFIG_FILE}: "format" must be one of ${FORMATS.join(", ")}`);
  }
  return config;
}
