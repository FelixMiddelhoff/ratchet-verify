import type { Redactor } from "./secret.js";

export interface WritableLike {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

/**
 * Line sink with backpressure: when the stream's buffer is full, lines queue up to
 * `maxQueued`; beyond that they are dropped and counted, and the next flush starts
 * with one `{"audit":"dropped","count":N}` line. A slow or stuck stderr consumer can
 * therefore neither block the proxy nor grow its memory without bound.
 */
export function createBoundedSink(stream: WritableLike, maxQueued = 1000): (line: string) => void {
  const queue: string[] = [];
  let dropped = 0;
  let waiting = false;

  const pump = (): void => {
    while (!waiting) {
      if (dropped > 0) {
        const count = dropped;
        dropped = 0;
        if (!stream.write(`${JSON.stringify({ audit: "dropped", count })}\n`)) {
          waiting = true;
          stream.once("drain", resume);
          return;
        }
      }
      const next = queue.shift();
      if (next === undefined) return;
      if (!stream.write(`${next}\n`)) {
        waiting = true;
        stream.once("drain", resume);
      }
    }
  };
  const resume = (): void => {
    waiting = false;
    pump();
  };

  return (line: string): void => {
    if (waiting) {
      if (queue.length >= maxQueued) dropped++;
      else queue.push(line);
      return;
    }
    if (!stream.write(`${line}\n`)) {
      waiting = true;
      stream.once("drain", resume);
    }
  };
}

export interface CrashProcess {
  on(event: "uncaughtException" | "unhandledRejection", listener: (arg: unknown) => void): unknown;
  exit(code: number): never | void;
}

export const CRASH_EXIT_CODE = 70;

/** One redacted, single-line, stack-free description of a fatal error. Only error name and code are trusted verbatim. */
export function crashLine(kind: string, err: unknown, redact: Redactor | undefined): string {
  // Name and code are shown only in their conventional shapes (TypeError, ERR_SOMETHING); anything else is attacker/secret-shaped text.
  const rawName = err instanceof Error ? err.name : "";
  const name = err instanceof Error ? (/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(rawName) ? rawName : "Error") : "NonError";
  const rawCode = (err as { code?: unknown } | null)?.code;
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(rawCode) ? ` ${rawCode}` : "";
  // The message may quote input or secrets: it is shown only once the redactor for the configured secrets exists.
  const message = redact && err instanceof Error ? ` ${redact(err.message).replace(/[^ -~]/g, "?").slice(0, 200)}` : "";
  return `fatal: ${kind} ${name}${code}${message}`;
}

/**
 * `uncaughtException` / `unhandledRejection`: print ONE redacted line (no stack, no
 * cause chain, no property dump) and exit non-zero. Without this, Node prints the
 * source line and stack of the throw site, which can contain secret material.
 */
export function installCrashHandlers(proc: CrashProcess, writeErr: (line: string) => void, getRedact: () => Redactor | undefined): void {
  let dying = false;
  const die = (kind: string) => (err: unknown): void => {
    if (dying) return;
    dying = true;
    let line: string;
    try {
      line = crashLine(kind, err, getRedact());
    } catch {
      line = `fatal: ${kind}`;
    }
    try {
      writeErr(line);
    } finally {
      proc.exit(CRASH_EXIT_CODE);
    }
  };
  proc.on("uncaughtException", die("uncaughtException"));
  proc.on("unhandledRejection", die("unhandledRejection"));
}
