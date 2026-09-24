import { execFile } from "node:child_process";

/**
 * Contents of `path` at git `ref`, e.g. the base branch's lockfile. `path` is relative to `cwd` (the project
 * directory), so a project that lives in a subdirectory of the repository reads its own files.
 */
export function readFileAtRef(cwd: string, ref: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["show", `${ref}:./${path}`], { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git show ${ref}:${path} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

/** Every file under `cwd` at git `ref` (paths relative to `cwd`, forward slashes). Fails loudly on an unknown ref. */
export function listFilesAtRef(cwd: string, ref: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["ls-tree", "-r", "-z", "--name-only", ref], { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ls-tree ${ref} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout.split("\0").filter(Boolean));
    });
  });
}
