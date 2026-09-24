#!/usr/bin/env node
// Registry proxy sidecar entrypoint. NOT wired into any CLI flag, config or pipeline yet.
// Usage: printf '<json config+credentials>' | node main.js
import { runSidecar } from "./sidecar.js";
import { createBoundedSink, installCrashHandlers } from "./sink.js";
import type { Redactor } from "./secret.js";

// stderr carries the audit log: bounded queue, drop-count line instead of unbounded memory or blocking.
const stderrLine = createBoundedSink(process.stderr);
let redactor: Redactor | undefined;

// A crash must never dump a stack (source lines can hold secret material): one redacted line, non-zero exit.
installCrashHandlers(
  {
    on: (event, listener) => process.on(event, listener),
    exit: (code) => {
      setTimeout(() => process.exit(code), 50);
    },
  },
  stderrLine,
  () => redactor,
);

const result = await runSidecar({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: stderrLine,
  setRedactor: (r) => {
    redactor = r;
  },
});

if (!result.ok) {
  process.exitCode = result.exitCode;
} else {
  const stop = (): void => {
    void result.proxy.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
