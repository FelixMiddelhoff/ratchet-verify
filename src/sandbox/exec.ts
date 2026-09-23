import { spawn, spawnSync } from "node:child_process";

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Only the tail is kept: failures explain themselves at the end of the output. */
  maxOutputBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
}

const DEFAULT_MAX_OUTPUT = 64 * 1024;
const isWindows = process.platform === "win32";

export function runCommand(options: RunOptions): Promise<RunResult> {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolve) => {
    // npm/yarn/pnpm are .cmd shims on Windows, which only spawn through a shell.
    const child = spawn(quoteForShell(options.command), options.args.map(quoteForShell), {
      cwd: options.cwd,
      env: options.env,
      shell: isWindows,
      detached: !isWindows,
      windowsHide: true,
    });

    let output = "";
    let truncated = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > maxBytes) {
        output = output.slice(output.length - maxBytes);
        truncated = true;
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut, output, truncated });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** With `shell: true` on Windows, args are joined unquoted, so anything with spaces or metacharacters must be quoted. */
function quoteForShell(arg: string): string {
  if (!isWindows || /^[\w./:=@-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** A hung test run (e.g. an infinite loop in a dependency) must not outlive its timeout. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}
