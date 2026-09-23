import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../src/sandbox/index.js";

export type Files = Record<string, string>;

/** Writes `files` into a fresh temp dir, hands it to `body`, and always removes it. */
export async function withTempProject<T>(files: Files, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ratchet-test-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Generates package-lock.json offline, without running any install scripts. */
export async function generateLockfile(dir: string): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const result = await runCommand({
    command: "npm",
    args: ["install", "--package-lock-only", "--ignore-scripts", "--offline"],
    cwd: dir,
    env,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new Error(`lockfile generation failed:\n${result.output}`);
  const { readFile } = await import("node:fs/promises");
  return readFile(join(dir, "package-lock.json"), "utf8");
}

export const pkg = (fields: object) => JSON.stringify({ name: "fixture", version: "1.0.0", ...fields });
