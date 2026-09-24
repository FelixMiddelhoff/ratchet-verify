import { connect as netConnect, type LookupFunction, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import type { AuditLog } from "./audit.js";
import { parseHostPort, type Limits } from "./config.js";

export interface ConnectContext {
  allowHosts: ReadonlySet<string>;
  limits: Pick<Limits, "connectTimeoutMs" | "connectIdleTimeoutMs" | "maxConnectBytes">;
  lookup: LookupFunction;
  audit: AuditLog;
  /** Test seam: physical address for a logical host:port. */
  mapTarget?: (host: string, port: number) => { hostname: string; port: number } | undefined;
  tryAcquire(): boolean;
  release(): void;
  track(socket: Socket): void;
}

function deny(socket: Socket, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * HTTP CONNECT: only allowlisted host:port, no credentials ever involved (the
 * tunnel is opaque TLS to a public host). Connection and idle timeouts, optional byte cap.
 */
export function handleConnect(req: IncomingMessage, client: Socket, head: Buffer, ctx: ConnectContext): void {
  ctx.track(client);
  client.on("error", () => client.destroy());
  const authority = req.url ?? "";
  const hp = authority.length <= 262 ? parseHostPort(authority) : undefined;
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
    ctx.audit.record({ method: "CONNECT", class: "connect", registry: null, host: key, status: 503, decision: "deny", reason: "concurrency-limit" });
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
  const target = ctx.mapTarget?.(hp.host, hp.port) ?? { hostname: hp.host, port: hp.port };
  const upstream = netConnect({ host: target.hostname, port: target.port, lookup: ctx.lookup });
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
    client.destroy();
    finish();
  };
  let established = false;
  upstream.on("error", () => {
    if (!established) {
      clearTimeout(connectTimer);
      ctx.audit.record({ method: "CONNECT", class: "connect", registry: null, host: key, status: 502, decision: "error", reason: "upstream-connect-failed" });
      deny(client, 502, "Bad Gateway");
      upstream.destroy();
      finish();
      return;
    }
    teardown();
  });
  upstream.once("connect", () => {
    established = true;
    clearTimeout(connectTimer);
    upstream.setTimeout(ctx.limits.connectIdleTimeoutMs, teardown);
    client.setTimeout(ctx.limits.connectIdleTimeoutMs, teardown);
    ctx.audit.record({ method: "CONNECT", class: "connect", registry: null, host: key, status: 200, decision: "allow", reason: "tunnel" });
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
}
