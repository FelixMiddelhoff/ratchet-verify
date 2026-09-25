/** Collision-safe subnet choice for the run-scoped internal network (docker needs an explicit --subnet with inhibit_ipv4). */

export interface Cidr {
  base: number;
  bits: number;
}

export function parseCidr(text: string): Cidr | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text.trim());
  if (!m) return undefined;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return undefined;
  const base = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, bits };
}

export function cidrOverlap(a: Cidr, b: Cidr): boolean {
  const bits = Math.min(a.bits, b.bits);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((a.base & mask) >>> 0) === ((b.base & mask) >>> 0);
}

export const ipv4 = (n: number): string => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** Candidate range: 10.200.0.0 - 10.250.255.0 as /24 (clear of docker's 172.17+ / 192.168 pools and podman's 10.88-10.89). */
export const SUBNET_FIRST_OCTET2 = 200;
export const SUBNET_LAST_OCTET2 = 250;

/**
 * Picks a /24 that overlaps none of `used`. `random` returns [0,1) (injectable for tests). Scans from a random
 * start so concurrent runs rarely pick the same one first; returns undefined when the whole range is taken.
 */
export function pickSubnet(used: readonly string[], random: () => number = Math.random): string | undefined {
  const taken = used.map(parseCidr).filter((c): c is Cidr => c !== undefined);
  const span = (SUBNET_LAST_OCTET2 - SUBNET_FIRST_OCTET2 + 1) * 256;
  const start = Math.floor(random() * span) % span;
  for (let i = 0; i < span; i++) {
    const idx = (start + i) % span;
    const second = SUBNET_FIRST_OCTET2 + (idx >> 8);
    const third = idx & 255;
    const candidate: Cidr = { base: ((10 << 24) | (second << 16) | (third << 8)) >>> 0, bits: 24 };
    if (!taken.some((t) => cidrOverlap(t, candidate))) return `${ipv4(candidate.base)}/24`;
  }
  return undefined;
}

/** Collects every IPv4 CIDR under a `Subnet`/`subnet` key of network-inspect JSON (docker and podman shapes). */
export function subnetsFromInspect(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === "string") {
      if ((key === "Subnet" || key === "subnet") && parseCidr(v)) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(parsed);
  return out;
}

/** Docker/podman error text for "this address pool/subnet is taken". */
export const SUBNET_CONFLICT_RE = /overlap|already in use|pool overlaps|address already|conflict|subnet.*(in use|exists)|same subnet/i;
