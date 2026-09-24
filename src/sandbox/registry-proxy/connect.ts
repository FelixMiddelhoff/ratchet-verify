import { connect as netConnect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import type { AuditLog } from "./audit.js";
import { parseHostPort, type Limits } from "./config.js";
import { BlockedAddressError, resolveVetted, type NameResolver } from "./netguard.js";

export interface ConnectContext {
  allowHosts: ReadonlySet<string>;
  /** Subset of allowHosts whose names may resolve to private addresses. */
  allowPrivateHosts: ReadonlySet<string>;
  limits: Pick<Limits, "connectTimeoutMs" | "connectIdleTimeoutMs" | "maxConnectBytes">;
  resolver: NameResolver;
  audit: AuditLog;
  /** Test seam: physical address for a logical host:port (applied AFTER the destination guard vetted the logical name). */
  mapTarget?: (host: string, port: number) => { hostname: string; port: number } | undefined;
  /** Tunnel slot accounting (separate from the request gate). */
  tryAcquire(): boolean;
  release(): void;
  track(socket: Socket): void;
}

/**
 * Sends a final status line and closes the client AFTER the bytes are flushed.
 * (`end`, never `destroy`: an immediate destroy can drop the response that is
 * still sitting in the socket's write buffer.)
 */
function deny(socket: Socket, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.setTimeout(5000, () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Normalises a CONNECT authority: strict `host:port` only (no userinfo, IPv6 brackets, spaces,
 * control characters or non-ASCII/IDN), lower-cased, one trailing dot removed. Returns undefined when invalid.
 */
export function normaliseConnectAuthority(authority: string): { host: string; port: number } | undefined {
  if (authority.length === 0 || authority.length > 262 || !/^[!-~]+$/.test(authority)) return undefined;
  const lower = authority.toLowerCase();
  const colon = lower.lastIndexOf(":");
  if (colon <= 0) return undefined;
  let host = lower.slice(0, colon);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return parseHostPort(`${host}:${lower.slice(colon + 1)}`);
}

/**
 * HTTP CONNECT: only allowlisted host:port, no credentials ever involved (the
 * tunnel is opaque TLS to a public host). The name is resolved once by the
 * proxy, the answer is vetted (no private/link-local/metadata ranges unless
 * that allowHosts entry opted in) and the tunnel connects to that exact address.
 * Connection and idle timeouts, optional byte cap.
 */
export function handleConnect(req: IncomingMessage, client: Socket, head: Buffer, ctx: ConnectContext): void {
  ctx.track(client);
  client.on("error", () => client.destroy());
  const hp = normaliseConnectAuthority(req.url ?? "");
  const key = hp ? `${hp.host}:${hp.port}` : undefined;
  if (!hp || !key) {
    ctx.audit.record({ method: "CONNECT", class: "invalid", registry: null, host: null, status: 400, decision: "deny", reason: "bad-connect-target" });
    deny(client, 400, "Bad Request");
    return;
  }
  if (!ctx.allowHosts.has(key)) {
    ctx.audit.record({ method: "CONNECT", class: "connect", registry: null, host: key, status: 403, decision: "deny", reason: "host-not-allowed" });
    deny(client, 403, "Forbidden");
    return;
  }
  if (!ctx.tryAcquire()) {
    ctx.audit.record({ method: "CONNECT", class: "connect", registry: null, host: key, status: 503, decision: "deny", reason: "tunnel-limit" });
    deny(client, 503, "Service Unavailable");
    return;
  }
  let released = false;
  const finish = (): void => {
    if (!released) {
      released = true;
      ctx.release();
    }
  };
  let denied = false;
  let clientGone = false;
  const started = Date.now();
  const refuse = (status: number, text: string, reason: string, decision: "deny" | "error"): void => {
    denied = true;
    ctx.audit.record({ method: "CONNECT", class: "connect", registry: null, host: key, status, decision, reason, ms: Date.now() - started });
    deny(client, status, text);
    finish();
  };
  client.once("close", () => {
    clientGone = true;
    finish();
  });

  void (async () => {
    let address: string;
    try {
      address = (await resolveVetted(hp.host, ctx.resolver, ctx.allowPrivateHosts.has(key))).address;
    } catch (e) {
      if (e instanceof BlockedAddressError) refuse(403, "Forbidden", "blocked-address", "deny");
      else refuse(502, "Bad Gateway", "resolve-failed", "error");
      return;
    }
    if (clientGone) return;
    const mapped = ctx.mapTarget?.(hp.host, hp.port);
    const upstream = netConnect({ host: mapped?.hostname ?? address, port: mapped?.port ?? hp.port });
    ctx.track(upstream);
    let total = 0;
    const cap = ctx.limits.maxConnectBytes;
    const count = (chunk: Buffer): void => {
      total += chunk.length;
      if (cap > 0 && total > cap) {
        upstream.destroy();
        client.destroy();
      }
    };
    const connectTimer = setTimeout(() => upstream.destroy(new Error("connect timeout")), ctx.limits.connectTimeoutMs);
    const teardown = (): void => {
      clearTimeout(connectTimer);
      upstream.destroy();
      // After a refusal the client is closed by deny() once its response has flushed.
      if (!denied) client.destroy();
      finish();
    };
    let established = false;
    upstream.on("error", () => {
      if (!established) {
        clearTimeout(connectTimer);
        upstream.destroy();
        refuse(502, "Bad Gateway", "upstream-connect-failed", "error");
        return;
      }
      teardown();
    });
    upstream.once("connect", () => {
      established = true;
      clearTimeout(connectTimer);
      upstream.setTimeout(ctx.limits.connectIdleTimeoutMs, teardown);
      client.setTimeout(ctx.limits.connectIdleTimeoutMs, teardown);
      ctx.audit.record({ method: "CONNECT", class: "connect", registry: null, host: key, status: 200, decision: "allow", reason: "tunnel", ms: Date.now() - started });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        count(head);
        upstream.write(head);
      }
      client.on("data", count);
      upstream.on("data", count);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.on("close", teardown);
    upstream.on("close", teardown);
  })();
}
