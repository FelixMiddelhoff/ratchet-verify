import { configSecrets, parseConfig, type ProxyConfig } from "./config.js";
import { createRedactor, redactError } from "./secret.js";
import { startRegistryProxy, type RegistryProxy } from "./server.js";

export const READY_PREFIX = "RATCHET_PROXY_READY";
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
}

export type SidecarResult = { ok: true; proxy: RegistryProxy } | { ok: false; exitCode: number };

async function readAll(stdin: SidecarIo["stdin"]): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stdin) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    size += b.length;
    if (size > MAX_STDIN_BYTES) return undefined;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Sidecar boot: refuse credential-like argv/env, read ONE JSON blob (config +
 * credentials) from stdin to EOF, start the proxy, print one ready line.
 * Nothing here logs the blob or any parse detail beyond fixed messages.
 */
export async function runSidecar(io: SidecarIo): Promise<SidecarResult> {
  const leaks = findCredentialLeaks(io.argv, io.env);
  if (leaks.length > 0) {
    for (const l of leaks) io.stderr(`refusing to start: ${l}`);
    io.stderr("credentials must arrive on stdin only");
    return { ok: false, exitCode: 2 };
  }
  const text = await readAll(io.stdin);
  if (text === undefined) {
    io.stderr("refusing to start: stdin config too large");
    return { ok: false, exitCode: 2 };
  }
  let config: ProxyConfig;
  try {
    config = parseConfig(JSON.parse(text));
  } catch (e) {
    // JSON.parse messages can quote input; only ConfigError text (paths, no values) is shown.
    io.stderr(e instanceof Error && e.name === "ConfigError" ? `invalid config: ${e.message}` : "invalid config: stdin is not valid JSON");
    return { ok: false, exitCode: 2 };
  }
  const embedded = findConfiguredSecretsInProcess(config, io.argv, io.env);
  if (embedded.length > 0) {
    for (const l of embedded) io.stderr(`refusing to start: ${l}`);
    return { ok: false, exitCode: 2 };
  }
  const redact = createRedactor(configSecrets(config));
  try {
    const proxy = await startRegistryProxy(config, { auditSink: (line) => io.stderr(line) });
    io.stdout(`${READY_PREFIX} port=${proxy.port}`);
    return { ok: true, proxy };
  } catch (e) {
    io.stderr(`failed to start: ${redactError(redact, e)}`);
    return { ok: false, exitCode: 1 };
  }
}
