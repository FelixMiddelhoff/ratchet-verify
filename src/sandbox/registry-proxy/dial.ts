import { promises as dnsPromises } from "node:dns";
import type { NameResolver } from "./netguard.js";

export type { NameResolver } from "./netguard.js";

/** Resolver bound to the explicit servers from config; never falls back to libc. */
export function createResolver(servers: readonly string[]): NameResolver {
  const r = new dnsPromises.Resolver();
  r.setServers([...servers]);
  return r;
}

/** How to physically reach a logical target. Production: the vetted address of the logical name. */
export interface DialTarget {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  /** TLS only. */
  servername?: string;
  ca?: string;
}

/**
 * TEST SEAM. Lets tests point the logical origin `https://registry.test` at a
 * loopback fixture (plain http or self-signed https). It is an in-process
 * function argument of startRegistryProxy: it cannot be set from the JSON
 * config, argv or env, and main.ts never passes one. The validator still
 * enforces `https` for every configured upstream and every redirect target and
 * the destination guard (netguard.ts) still vets the LOGICAL name through the
 * injected resolver first; the seam only changes where the socket goes.
 */
export type TestDialSeam = (logical: { hostname: string; port: number; protocol: "https:" }) => DialTarget | undefined;
