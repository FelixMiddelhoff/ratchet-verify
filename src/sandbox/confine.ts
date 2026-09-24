import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Why a project-relative file key cannot be trusted, or undefined when it is a plain path inside the project.
 * Windows and POSIX rules are both applied whatever the host OS, so a key written as `C:\x`, `\\srv\share`,
 * `..\x` or `/etc/x` is refused everywhere.
 */
export function confinementProblem(key: string): string | undefined {
  if (key === "" || key.includes("\0")) return "empty or contains a NUL byte";
  if (isAbsolute(key) || /^[a-zA-Z]:/.test(key) || key.startsWith("/") || key.startsWith("\\")) return "is absolute";
  if (key.replaceAll("\\", "/").split("/").includes("..")) return "contains a `..` segment";
  return undefined;
}

/** Absolute path of `key` inside `dir`; throws when the key would land outside of it. */
export function confinedPath(dir: string, key: string): string {
  const problem = confinementProblem(key);
  if (problem) throw new Error(`sandbox file key "${key}" ${problem}: refusing to touch a path outside the sandbox`);
  const target = resolve(dir, key.replaceAll("\\", "/"));
  const rel = relative(dir, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`sandbox file key "${key}" resolves outside the sandbox: refusing to touch it`);
  }
  return target;
}
