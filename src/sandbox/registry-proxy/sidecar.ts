import { configSecrets, parseConfig, type ProxyConfig } from "./config.js";
import { createRedactor, redactError, type Redactor } from "./secret.js";
import { startRegistryProxy, type RegistryProxy } from "./server.js";

export const READY_PREFIX = "RATCHET_PROXY_READY";
/** A sidecar whose ratchet process vanished (stdin is closed after the config, so there is no EOF signal) stops itself; well below the 12 h sweep age. */
export const MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;

const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API_?KEY|PRIVATE_?KEY|_KEY$)/i;
const SECRET_VALUE = /(npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bBearer\s+\S{8,}|\bBasic\s+[A-Za-z0-9+/=]{8,}|[a-z]+:\/\/[^\s/:@]+:[^\s/@]+@)/;

/** Returns human-readable refusals (names only, never values) when credential-like data is in argv or env. */
export function findCredentialLeaks(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  argv.forEach((arg, i) => {
    if (SECRET_VALUE.test(arg)) problems.push(`argv[${i}] looks like a credential`);
  });
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (SECRET_ENV_NAME.test(name)) problems.push(`environment variable ${name} is set (credential-like name)`);
    else if (SECRET_VALUE.test(value)) problems.push(`environment variable ${name} looks like it holds a credential`);
  }
  return problems;
}

/** Checks the actual configured secrets against argv/env values (exact substring), names only in the report. */
export function findConfiguredSecretsInProcess(config: ProxyConfig, argv: readonly string[], env: Readonly<Record<string, string | undefined>>): string[] {
  const secrets = configSecrets(config);
  const problems: string[] = [];
  argv.forEach((arg, i) => {
    if (secrets.some((s) => arg.includes(s))) problems.push(`argv[${i}] contains a configured secret`);
  });
  for (const [name, value] of Object.entries(env)) {
    if (value && secrets.some((s) => value.includes(s))) problems.push(`environment variable ${name} contains a configured secret`);
  }
  return problems;
}

export interface SidecarIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdin: AsyncIterable<Buffer | string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Called once the secrets are known so crash reporting can redact them. */
  setRedactor?: (redact: Redactor) => void;
}

export type SidecarResult =
  | {
      ok: true;
      proxy: RegistryProxy;
      /**
       * I-3 (security-review-0.7.md): resolves once the controller's stdin pipe closes, at ANY point after startup —
       * normally only during its own graceful teardown (`AttachedProcess.endStdin`), but also within seconds of the
       * controller being hard-killed (SIGKILL), since the OS then closes its end of the pipe for it. `main.ts` treats
       * this the same as SIGTERM: stop the proxy, don't wait for `MAX_LIFETIME_MS`.
       */
      controllerGone: Promise<void>;
    }
  | { ok: false; exitCode: number };

/** Reads stdin up to (and not including) the first `\n` as the config; the SAME underlying iterator is returned so the
 *  caller can keep watching it afterward (any further data, or its end, both matter — see `controllerGone` above). */
async function readFirstLine(stdin: SidecarIo["stdin"]): Promise<{ line: string | undefined; iterator: AsyncIterator<Buffer | string> }> {
  const iterator = stdin[Symbol.asyncIterator]();
  let buf = "";
  let size = 0;
  for (;;) {
    const { value, done } = await iterator.next();
    // No trailing "\n" before EOF (a caller that closes stdin right after the blob, the old whole-stream protocol):
    // whatever was buffered is the line. An EOF with nothing at all is the actual failure case.
    if (done) return { line: buf.length > 0 ? buf : undefined, iterator };
    const b = typeof value === "string" ? value : (value as Buffer).toString("utf8");
    size += b.length;
    if (size > MAX_STDIN_BYTES) {
      await iterator.return?.();
      return { line: undefined, iterator };
    }
    buf += b;
    const nl = buf.indexOf("\n");
    if (nl >= 0) return { line: buf.slice(0, nl), iterator };
  }
}

/** Never resolves until the controller's pipe ends; any data received before then (a heartbeat, or a stray byte) is
 *  ignored, it only matters that the pipe is still open. Stream errors count as "gone" too, not as a crash. */
async function watchControllerPipe(iterator: AsyncIterator<Buffer | string>): Promise<void> {
  try {
    for (;;) {
      const { done } = await iterator.next();
      if (done) return;
    }
  } catch {
    return;
  }
}

/**
 * Sidecar boot: refuse credential-like argv/env, read ONE JSON blob (config + credentials) as the first line of
 * stdin, start the proxy, print one ready line. stdin then stays open for the controller's whole run (see
 * `SidecarResult.controllerGone`, I-3) instead of being read to EOF here. Nothing here logs the blob or any parse
 * detail beyond fixed messages.
 */
export async function runSidecar(io: SidecarIo): Promise<SidecarResult> {
  const leaks = findCredentialLeaks(io.argv, io.env);
  if (leaks.length > 0) {
    for (const l of leaks) io.stderr(`refusing to start: ${l}`);
    io.stderr("credentials must arrive on stdin only");
    return { ok: false, exitCode: 2 };
  }
  const first = await readFirstLine(io.stdin);
  // Every ok:false return from here on must release `first.iterator` (a partially-consumed async iterator otherwise
  // keeps the underlying stream's handle open, which keeps the process alive with nothing left to read it).
  const refuse = async (exitCode: number, ...lines: string[]): Promise<SidecarResult> => {
    for (const l of lines) io.stderr(l);
    await first.iterator.return?.();
    return { ok: false, exitCode };
  };
  if (first.line === undefined) return refuse(2, "refusing to start: stdin config too large or closed before a config line arrived");
  let config: ProxyConfig;
  try {
    config = parseConfig(JSON.parse(first.line));
  } catch (e) {
    // JSON.parse messages can quote input; only ConfigError text (paths, no values) is shown.
    return refuse(2, e instanceof Error && e.name === "ConfigError" ? `invalid config: ${e.message}` : "invalid config: stdin is not valid JSON");
  }
  const embedded = findConfiguredSecretsInProcess(config, io.argv, io.env);
  if (embedded.length > 0) return refuse(2, ...embedded.map((l) => `refusing to start: ${l}`));
  const redact = createRedactor(configSecrets(config));
  io.setRedactor?.(redact);
  try {
    const proxy = await startRegistryProxy(config, { auditSink: (line) => io.stderr(line) });
    io.stdout(`${READY_PREFIX} port=${proxy.port}`);
    return { ok: true, proxy, controllerGone: watchControllerPipe(first.iterator) };
  } catch (e) {
    return refuse(1, `failed to start: ${redactError(redact, e)}`);
  }
}
