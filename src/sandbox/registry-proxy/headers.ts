import type { IncomingHttpHeaders } from "node:http";
import type { RegistryConfig } from "./config.js";

export const DEFAULT_USER_AGENT = "ratchet-registry-proxy";

/** Client headers that may be forwarded, each with a strict value shape. Everything else is dropped. */
const FORWARDED: Record<string, RegExp> = {
  accept: /^[A-Za-z0-9 ,;=*.+/_-]{1,200}$/,
  "accept-encoding": /^[A-Za-z0-9 ,;=*.-]{1,100}$/,
  "if-none-match": /^[ -~]{1,200}$/,
  "if-modified-since": /^[A-Za-z0-9 ,:]{1,40}$/,
  "npm-command": /^[a-z-]{1,32}$/,
  "pacote-req-type": /^[a-z]{1,16}$/,
};

export function sanitiseUserAgent(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_USER_AGENT;
  const clean = value.replace(/[^A-Za-z0-9 ._/();:,+-]/g, "").slice(0, 100).trim();
  return clean.length > 0 ? clean : DEFAULT_USER_AGENT;
}

export interface UpstreamHeaderContext {
  registry: RegistryConfig;
  /** True once any earlier hop of this request left the registry origin: credentials are gone for good. */
  tainted: boolean;
  /**
   * Packuments are rewritten by the proxy: ask for identity encoding and never forward the client's
   * validators (the client's etag describes OUR rewritten body; conditional handling is local).
   */
  rewriting?: boolean;
}

/**
 * Builds the upstream request headers from scratch. Client Authorization, Cookie,
 * Proxy-*, Forwarded, X-Forwarded-* (and anything not allowlisted) never make it.
 * The credential is attached only when the target origin is exactly the registry origin.
 */
export function buildUpstreamHeaders(client: IncomingHttpHeaders, target: URL, ctx: UpstreamHeaderContext): Record<string, string> {
  const out: Record<string, string> = { host: target.host, "user-agent": sanitiseUserAgent(client["user-agent"]), connection: "close" };
  for (const [name, shape] of Object.entries(FORWARDED)) {
    const v = client[name];
    if (typeof v === "string" && shape.test(v)) out[name] = v;
  }
  if (ctx.rewriting) {
    delete out["if-none-match"];
    delete out["if-modified-since"];
    out["accept-encoding"] = "identity";
  }
  if (!out["accept-encoding"]) out["accept-encoding"] = "identity";
  if (!ctx.tainted && ctx.registry.credential && target.protocol === "https:" && target.origin === ctx.registry.upstreamOrigin) {
    out.authorization = ctx.registry.credential.authorization();
  }
  return out;
}
