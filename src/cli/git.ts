import { execFile } from "node:child_process";

/** Contents of `path` at git `ref`, e.g. the base branch's lockfile. */
export function readFileAtRef(cwd: string, ref: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["show", `${ref}:${path}`], { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git show ${ref}:${path} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}
