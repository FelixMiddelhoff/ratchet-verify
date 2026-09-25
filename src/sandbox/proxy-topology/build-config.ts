import { configSecrets, ConfigError, parseConfig, type Credential, type Limits, type ProxyConfig } from "../registry-proxy/index.js";
import { createRedactor, type Redactor } from "../registry-proxy/index.js";
import { ProxyTopologyError } from "./errors.js";

/** Port the sidecar listens on inside the internal network (unprivileged; the sandbox is told `http://<sidecar>:3128`). */
export const SIDECAR_PORT = 3128;

export interface RegistryInput {
  id: string;
  /** https origin of the upstream registry, e.g. `https://registry.example.com`. */
  upstream: string;
  /** "/api/npm/repo" style path prepended to every upstream path. */
  pathPrefix?: string;
  isDefault?: boolean;
  /** Opaque: only this module hands its raw value to the stdin blob (via `material()`), nowhere else. */
  credential?: Credential;
  allowPrivateAddresses?: boolean;
}

export interface ProxyConfigInput {
  registries: readonly RegistryInput[];
  allowHosts?: ReadonlyArray<string | { host: string; allowPrivateAddresses?: boolean }>;
  packages?: { allow?: readonly string[]; allowPrefixes?: readonly string[]; /** The user turned the allowlist off. */ allowAll?: boolean };
  discovery?: "off" | "audit";
  /** Explicit resolver IPs for the sidecar's own upstream lookups (mandatory: the sidecar never uses libc). */
  dns: readonly string[];
  limits?: Partial<Limits>;
}

export interface BuiltProxyConfig {
  /** The single JSON blob handed to the sidecar on stdin. Contains credentials: never log, store or pass it anywhere else. */
  readonly stdinBlob: string;
  /** The validated form (credentials inside `Credential` objects, which never serialise). */
  readonly config: ProxyConfig;
  /** Scrubs every textual form of every credential; used on ALL error text and logs of this module. */
  readonly redact: Redactor;
}

/**
 * Builds and validates the sidecar config. Validation is the proxy core's own `parseConfig` (closed-world). Errors name
 * config paths, never values. `listen` starts as a loopback placeholder; `withInternalSubnet` binds the real address.
 */
export function buildProxyConfig(input: ProxyConfigInput): BuiltProxyConfig {
  const raw = {
    registries: input.registries.map((r) => ({
      id: r.id,
      upstream: r.upstream,
      ...(r.pathPrefix !== undefined ? { pathPrefix: r.pathPrefix } : {}),
      ...(r.isDefault !== undefined ? { default: r.isDefault } : {}),
      ...(r.allowPrivateAddresses !== undefined ? { allowPrivateAddresses: r.allowPrivateAddresses } : {}),
      ...(r.credential !== undefined ? { credential: { type: r.credential.type, secret: r.credential.material()[0] } } : {}),
    })),
    allowHosts: input.allowHosts ?? [],
    packages: { allow: [...(input.packages?.allow ?? [])], allowPrefixes: [...(input.packages?.allowPrefixes ?? [])], ...(input.packages?.allowAll ? { allowAll: true } : {}) },
    discovery: input.discovery ?? "off",
    dns: [...input.dns],
    limits: input.limits ?? {},
    // Loopback placeholder: unreachable from the sandbox, so forgetting `withInternalSubnet` fails closed (self-test: sidecar unreachable).
    listen: { host: "127.0.0.1", port: SIDECAR_PORT },
  };
  const stdinBlob = JSON.stringify(raw);
  let config: ProxyConfig;
  try {
    config = parseConfig(JSON.parse(stdinBlob));
  } catch (e) {
    if (e instanceof ConfigError) throw new ProxyTopologyError("invalid-config", `invalid proxy config: ${e.message}`);
    throw new ProxyTopologyError("invalid-config", "invalid proxy config");
  }
  return Object.freeze({ stdinBlob, config, redact: createRedactor(configSecrets(config)) });
}

/**
 * Binds the sidecar to its address inside the run's internal subnet (never a wildcard: the sidecar is also on the default
 * bridge, whose side must not answer) and restricts clients to that subnet. Re-validated by the proxy core's `parseConfig`.
 */
export function withInternalSubnet(built: BuiltProxyConfig, cidr: string): BuiltProxyConfig {
  const raw = JSON.parse(built.stdinBlob) as Record<string, unknown>;
  raw.listen = { cidr, port: SIDECAR_PORT };
  raw.allowClients = [cidr];
  const stdinBlob = JSON.stringify(raw);
  let config: ProxyConfig;
  try {
    config = parseConfig(JSON.parse(stdinBlob));
  } catch (e) {
    if (e instanceof ConfigError) throw new ProxyTopologyError("invalid-config", `invalid proxy config: ${e.message}`);
    throw new ProxyTopologyError("invalid-config", "invalid proxy config");
  }
  return Object.freeze({ stdinBlob, config, redact: built.redact });
}
