import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Version from the package.json that ships next to `dist/` (or the repo root when run from source). */
export function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++, dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (!existsSync(candidate)) continue;
    const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
    if (manifest.name === "ratchet-verify" && manifest.version) return manifest.version;
  }
  return "unknown";
}
