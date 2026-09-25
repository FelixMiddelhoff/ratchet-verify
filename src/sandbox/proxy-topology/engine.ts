import { spawn } from "node:child_process";
import type { ContainerRuntime } from "../container.js";
import type { RunResult } from "../exec.js";

/** A long-lived engine client process (`start -a -i`) that owns the sidecar's stdio. Never reachable from the sandbox. */
export interface AttachedProcess {
  onStdoutLine(listener: (line: string) => void): void;
  onStderrLine(listener: (line: string) => void): void;
  /** Kills the CLIENT process (the container is removed separately with `rm -f`). */
  kill(): void;
  /** Resolves with the client's exit code once it ended. */
  readonly exited: Promise<number | null>;
}

export interface RunOptions {
  /** Written to the command's stdin, then stdin is closed. */
  stdin?: string;
  timeoutMs?: number;
}

/** The seam: unit tests use a fake that records commands; real tests use docker or podman. */
export interface Engine {
  readonly runtime: ContainerRuntime;
  /** Runs one engine command to completion. Never throws for a non-zero exit. */
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Starts a long-lived client and pipes `stdin` into it (then closes stdin). */
  spawnAttached(args: readonly string[], stdin: string): AttachedProcess;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const hostEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

function lineSplitter(listeners: Array<(line: string) => void>): (chunk: Buffer) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      for (const l of listeners) l(line);
      nl = pending.indexOf("\n");
    }
    if (pending.length > 1024 * 1024) pending = ""; // a line without newline must not grow without bound
  };
}

function killProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** The real thing: spawns `docker`/`podman` directly (no shell, argv only) with the host environment. */
export function createRealEngine(runtime: ContainerRuntime): Engine {
  return {
    runtime,
    run(args, options = {}) {
      const maxBytes = 64 * 1024;
      return new Promise<RunResult>((resolve) => {
        const child = spawn(runtime, [...args], { env: hostEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        let truncated = false;
        const collect = (chunk: Buffer): void => {
          output += chunk.toString("utf8");
          if (output.length > maxBytes) {
            output = output.slice(output.length - maxBytes);
            truncated = true;
          }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          killProcess(child.pid);
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const finish = (exitCode: number | null): void => {
          clearTimeout(timer);
          resolve({ exitCode, timedOut, output, truncated });
        };
        child.on("error", (e) => {
          output += `\n${e.message}`;
          finish(null);
        });
        child.on("close", (code) => finish(code));
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.stdin ?? "");
      });
    },
    spawnAttached(args, stdin) {
      const child = spawn(runtime, [...args], { env: hostEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const out: Array<(line: string) => void> = [];
      const err: Array<(line: string) => void> = [];
      child.stdout.on("data", lineSplitter(out));
      child.stderr.on("data", lineSplitter(err));
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
      const exited = new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
      });
      return {
        onStdoutLine: (l) => void out.push(l),
        onStderrLine: (l) => void err.push(l),
        kill: () => killProcess(child.pid),
        exited,
      };
    },
  };
}
