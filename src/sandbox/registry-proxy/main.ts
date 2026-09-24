#!/usr/bin/env node
// Registry proxy sidecar entrypoint. NOT wired into any CLI flag, config or pipeline yet.
// Usage: printf '<json config+credentials>' | node main.js
import { runSidecar } from "./sidecar.js";

const result = await runSidecar({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
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
