import { parseV4, parseV6 } from "./netguard.js";

/**
 * Client allowlist (defence in depth for the listener bind): a connection whose remote address is outside every
 * configured CIDR is destroyed before a byte is parsed, for plain HTTP and CONNECT alike. IPv4-mapped IPv6 remotes
 * (`::ffff:a.b.c.d`, how a dual-stack socket reports an IPv4 peer) are matched as the IPv4 address they embed.
 */
export interface ClientCidr {
  readonly family: 4 | 6;
  /** Network address bytes (already masked). */
  readonly bytes: readonly number[];
  readonly bits: number;
}

const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

function parseAddress(text: string): { family: 4 | 6; bytes: number[] } | undefined {
  const v4 = parseV4(text);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseV6(text);
  if (!v6) return undefined;
  if (V4_MAPPED_PREFIX.every((b, i) => v6[i] === b)) return { family: 4, bytes: v6.slice(12) };
  return { family: 6, bytes: v6 };
}

const mask = (bytes: readonly number[], bits: number): number[] =>
  bytes.map((b, i) => {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    return b & ((0xff << (8 - keep)) & 0xff);
  });

/** Parses `a.b.c.d/n` or an IPv6 `x::/n`. Returns undefined for anything malformed (no host bits set required: they are masked). */
export function parseClientCidr(text: string): ClientCidr | undefined {
  const slash = text.indexOf("/");
  if (slash < 1 || text.indexOf("/", slash + 1) >= 0) return undefined;
  const addrText = text.slice(0, slash);
  const bitsText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsText)) return undefined;
  const bits = Number(bitsText);
  const explicitV6 = addrText.includes(":");
  const a = parseAddress(addrText);
  if (!a) return undefined;
  if (a.family === 4) {
    // `::ffff:10.0.0.0/104` is a v4 range written in mapped form: shift the prefix length to v4 terms.
    const effective = explicitV6 ? bits - 96 : bits;
    if (effective < 0 || effective > 32) return undefined;
    return { family: 4, bytes: mask(a.bytes, effective), bits: effective };
  }
  if (bits > 128) return undefined;
  return { family: 6, bytes: mask(a.bytes, bits), bits };
}

export function clientInCidrs(address: string | undefined, cidrs: readonly ClientCidr[]): boolean {
  if (address === undefined) return false;
  const a = parseAddress(address);
  if (!a) return false;
  return cidrs.some((c) => c.family === a.family && mask(a.bytes, c.bits).every((b, i) => b === c.bytes[i]));
}
