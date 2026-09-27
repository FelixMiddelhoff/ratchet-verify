#!/usr/bin/env node
// Registry proxy sidecar entrypoint, run inside the container by proxy-topology.ts (opt-in via config.registryAuth).
// Usage: printf '<json config+credentials>\n' | node main.js (stdin then stays open; see controllerGone below)
import { MAX_LIFETIME_MS, runSidecar } from "./sidecar.js";
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
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void result.proxy.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // I-3 (security-review-0.7.md): the controller's stdin pipe closing (normally its own teardown, but also within
  // seconds of a hard SIGKILL of the controller, since the OS then closes its end) shuts this down without waiting
  // for MAX_LIFETIME_MS, which remains only as a backstop for cases where that pipe somehow never closes.
  void result.controllerGone.then(() => {
    stderrLine("controller pipe closed, stopping");
    stop();
  });
  setTimeout(() => {
    stderrLine("maximum lifetime reached, stopping");
    stop();
  }, MAX_LIFETIME_MS).unref();
}
