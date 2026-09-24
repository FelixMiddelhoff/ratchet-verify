import { isIP } from "node:net";

/**
 * Destination guard (SSRF). The proxy resolves upstream names itself, vets the
 * FINAL address, and connects to that exact address (name kept only for SNI and
 * the Host header), so a resolver that answers public-then-private (rebinding)
 * cannot get a second, unvetted lookup.
 *
 * Classes:
 *  - "public":  routable global unicast, always fine.
 *  - "private": loopback, RFC1918, CGNAT 100.64/10, ULA fc00::/7, ::1. Only with an explicit
 *               `allowPrivateAddresses` (per registry / per allowHosts entry).
 *  - "never":   link-local (169.254/16 incl. cloud metadata 169.254.169.254, fe80::/10), multicast,
 *               unspecified, reserved, benchmark/documentation/test nets, Teredo, and every other
 *               non-global-unicast range. Refused even with allowPrivateAddresses.
 * IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) forms are classified by
 * the IPv4 address they embed; IPv4-compatible (::a.b.c.d) is refused outright.
 */
export type AddressClass = "public" | "private" | "never";

export class BlockedAddressError extends Error {
  readonly code = "EBLOCKED";
  constructor(readonly addressClass: AddressClass | "unresolvable") {
    super("destination address is not allowed");
    this.name = "BlockedAddressError";
  }
}

/** Minimal resolver surface (matches dns.promises.Resolver). Injected in tests. */
export interface NameResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6?(hostname: string): Promise<string[]>;
}

export function parseV4(s: string): number[] | undefined {
  if (isIP(s) !== 4) return undefined;
  const parts = s.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : undefined;
}

/** Parses an IPv6 literal (no zone id) to 16 bytes. */
export function parseV6(s: string): number[] | undefined {
  if (s.includes("%") || isIP(s) !== 6) return undefined;
  let text = s;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  let v4tail: number[] | undefined;
  if (tail.includes(".")) {
    v4tail = parseV4(tail);
    if (!v4tail) return undefined;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] as string).split(":")) : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return undefined;
    groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (v4tail) {
    bytes[12] = v4tail[0] as number;
    bytes[13] = v4tail[1] as number;
    bytes[14] = v4tail[2] as number;
    bytes[15] = v4tail[3] as number;
  }
  return bytes;
}

const worse = (a: AddressClass, b: AddressClass): AddressClass => (a === "never" || b === "never" ? "never" : a === "private" || b === "private" ? "private" : "public");

function classifyV4(b: number[]): AddressClass {
  const [a, c, d] = [b[0] as number, b[1] as number, b[2] as number];
  if (a === 10 || a === 127) return "private";
  if (a === 172 && c >= 16 && c <= 31) return "private";
  if (a === 192 && c === 168) return "private";
  if (a === 100 && c >= 64 && c <= 127) return "private"; // CGNAT
  if (a === 0) return "never"; // "this network", unspecified
  if (a === 169 && c === 254) return "never"; // link-local incl. metadata
  if (a === 192 && c === 0 && d === 0) return "never"; // IETF protocol assignments
  if (a === 192 && c === 0 && d === 2) return "never"; // TEST-NET-1
  if (a === 192 && c === 88 && d === 99) return "never"; // 6to4 relay anycast
  if (a === 198 && (c === 18 || c === 19)) return "never"; // benchmarking
  if (a === 198 && c === 51 && d === 100) return "never"; // TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return "never"; // TEST-NET-3
  if (a >= 224) return "never"; // multicast + reserved + broadcast
  return "public";
}

function classifyV6(b: number[]): AddressClass {
  const allZeroUntil = (n: number): boolean => b.slice(0, n).every((x) => x === 0);
  if (allZeroUntil(15) && b[15] === 1) return "private"; // ::1
  if (allZeroUntil(10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12)); // ::ffff:a.b.c.d
  if (allZeroUntil(12)) return "never"; // ::, IPv4-compatible ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b.slice(4, 12).every((x) => x === 0)) return worse("public", classifyV4(b.slice(12))); // NAT64 64:ff9b::/96
    return "never"; // 64:ff9b:1::/48 local-use NAT64 and the rest of the block
  }
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)); // 6to4 2002::/16 embeds a v4
  if ((b[0] as number) >> 5 !== 0b001) {
    // Only 2000::/3 is global unicast. ULA fc00::/7 is the one permitted "private" range.
    return ((b[0] as number) & 0xfe) === 0xfc ? "private" : "never";
  }
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0x00 && b[3] === 0x00) return "never"; // Teredo 2001::/32 (embeds v4)
    if (b[2] === 0x0d && b[3] === 0xb8) return "never"; // documentation 2001:db8::/32
    if (b[2] === 0x00 && (b[3] as number) <= 0x2f) return "never"; // IETF protocol assignments, ORCHID, benchmarking
  }
  if (b[0] === 0x3f && (b[1] as number) >= 0xf0) return "never"; // 3fff::/20 documentation
  return "public";
}

/** Classifies an IP literal (v4, v6, mapped/embedded forms). Unparseable input is "never". */
export function classifyAddress(ip: string): AddressClass {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const v4 = parseV4(bare);
  if (v4) return classifyV4(v4);
  const v6 = parseV6(bare);
  return v6 ? classifyV6(v6) : "never";
}

export function isIpLiteral(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return isIP(bare) !== 0;
}

/** Hostnames the WHATWG parser would fold into an IPv4 address (decimal, hex, short forms) or that end in a numeric label. */
export function looksNumeric(host: string): boolean {
  const last = host.split(".").filter((l) => l.length > 0).pop() ?? "";
  return /^(?:0x[0-9a-f]*|[0-9]+)$/i.test(last);
}

export interface VettedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves `hostname` with the injected resolver (once), vets every returned
 * address, and returns the first one. Throws BlockedAddressError when any
 * answer is refused (a mixed answer is not trusted). The caller connects to
 * the returned address and must not resolve the name again.
 */
export async function resolveVetted(hostname: string, resolver: NameResolver, allowPrivate: boolean): Promise<VettedAddress> {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  let addrs: string[];
  if (isIP(bare) !== 0) {
    addrs = [bare];
  } else {
    addrs = [];
    try {
      addrs = await resolver.resolve4(bare);
    } catch {
      /* fall through to v6 */
    }
    if (addrs.length === 0 && resolver.resolve6) {
      try {
        addrs = await resolver.resolve6(bare);
      } catch {
        /* nothing */
      }
    }
    if (addrs.length === 0) throw Object.assign(new Error("no address"), { code: "ENOTFOUND" });
  }
  let worst: AddressClass = "public";
  for (const a of addrs) worst = worse(worst, classifyAddress(a));
  if (worst === "never" || (worst === "private" && !allowPrivate)) throw new BlockedAddressError(worst);
  const first = addrs[0] as string;
  return { address: first, family: isIP(first) === 6 ? 6 : 4 };
}
