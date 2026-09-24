import { promises as dnsPromises } from "node:dns";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";

/** Minimal resolver surface (matches dns.promises.Resolver). Injected in tests. */
export interface NameResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6?(hostname: string): Promise<string[]>;
}

/** Resolver bound to the explicit servers from config; never falls back to libc. */
export function createResolver(servers: readonly string[]): NameResolver {
  const r = new dnsPromises.Resolver();
  r.setServers([...servers]);
  return r;
}

/** A `lookup` for http(s).request/net.connect that only uses the injected resolver. */
export function lookupWith(resolver: NameResolver): LookupFunction {
  return (hostname, options, callback) => {
    const family = isIP(hostname);
    if (family !== 0) {
      if (options.all) callback(null, [{ address: hostname, family }]);
      else callback(null, hostname, family);
      return;
    }
    (async () => {
      let addrs: string[] = [];
      try {
        addrs = await resolver.resolve4(hostname);
      } catch {
        /* fall through to v6 */
      }
      if (addrs.length === 0 && resolver.resolve6) addrs = await resolver.resolve6(hostname);
      if (addrs.length === 0) throw Object.assign(new Error("no address"), { code: "ENOTFOUND" });
      const fam = isIP(addrs[0] as string) === 6 ? 6 : 4;
      if (options.all) callback(null, addrs.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 })));
      else callback(null, addrs[0] as string, fam);
    })().catch((e: NodeJS.ErrnoException) => callback(e, "", 4));
  };
}

/** How to physically reach a logical target. Production: identity. */
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
 * enforces `https` for every configured upstream and every redirect target;
 * the seam only changes where the socket goes, never what policy is applied.
 */
export type TestDialSeam = (logical: { hostname: string; port: number; protocol: "https:" }) => DialTarget | undefined;

export function defaultDial(url: URL): DialTarget {
  return { protocol: "https:", hostname: url.hostname, port: Number(url.port) || 443 };
}
