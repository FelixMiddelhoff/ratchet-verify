import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { pipeline, Transform } from "node:stream";
import { AuditLog, type AuditEntry } from "./audit.js";
import { configSecrets, isValidPackageName, type ProxyConfig } from "./config.js";
import { handleConnect } from "./connect.js";
import { createResolver, defaultDial, lookupWith, type DialTarget, type NameResolver, type TestDialSeam } from "./dial.js";
import { buildUpstreamHeaders } from "./headers.js";
import { decideRedirect, REDIRECT_STATUSES } from "./redirect.js";
import { classifyRequest, type Accepted } from "./request.js";
import { createRedactor, type Redactor } from "./secret.js";

export interface ProxyOptions {
  /** Inject a resolver (tests). Default: dns.Resolver bound to config.dns. */
  resolver?: NameResolver;
  now?: () => number;
  /** Receives one redacted JSON line per audit entry. */
  auditSink?: (line: string) => void;
  /** TEST ONLY, see dial.ts. Never set by production code paths. */
  testDial?: TestDialSeam;
}

export interface RegistryProxy {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
  audit(): AuditEntry[];
  /** Extends the package-name allowlist at runtime (e.g. versions/names discovered during bisect). */
  addAllowedPackages(names: readonly string[]): void;
  readonly redact: Redactor;
}

const RESPONSE_HEADERS = ["content-type", "content-length", "content-encoding", "etag", "last-modified", "cache-control", "vary"];

class Gate {
  #active = 0;
  constructor(private readonly max: number) {}
  tryAcquire(): boolean {
    if (this.#active >= this.max) return false;
    this.#active++;
    return true;
  }
  release(): void {
    this.#active = Math.max(0, this.#active - 1);
  }
}

class ByteCap extends Transform {
  exceeded = false;
  #seen = 0;
  constructor(private readonly max: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.#seen += chunk.length;
    if (this.#seen > this.max) {
      this.exceeded = true;
      cb(new Error("response too large"));
      return;
    }
    cb(null, chunk);
  }
}

function send(res: ServerResponse, status: number, reason: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: status >= 500 ? "proxy-error" : "denied", reason });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close", ...extra });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

export async function startRegistryProxy(config: ProxyConfig, options: ProxyOptions = {}): Promise<RegistryProxy> {
  const redact = createRedactor(configSecrets(config));
  const audit = new AuditLog(redact, options.now ?? Date.now, options.auditSink);
  const resolver = options.resolver ?? createResolver(config.dns);
  const lookup = lookupWith(resolver);
  const gate = new Gate(config.limits.maxConcurrent);
  const allow = new Set(config.packages.allow);
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const track = (s: Socket): void => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };
  const isPackageAllowed = (name: string): boolean => allow.has(name) || config.packages.allowPrefixes.some((p) => name.startsWith(p));

  const dialFor = (url: URL): DialTarget | undefined => {
    if (!options.testDial) return defaultDial(url);
    return options.testDial({ hostname: url.hostname, port: Number(url.port) || 443, protocol: "https:" });
  };

  function requestUpstream(url: URL, method: string, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const dial = dialFor(url);
      if (!dial) {
        reject(new Error("no dial target"));
        return;
      }
      const opts: https.RequestOptions = {
        method,
        hostname: dial.hostname,
        port: dial.port,
        path: url.pathname,
        headers,
        lookup,
        agent: false,
        signal,
        ...(dial.protocol === "https:" ? { servername: dial.servername ?? url.hostname, ca: dial.ca } : {}),
      };
      const req = (dial.protocol === "https:" ? https : http).request(opts, resolve);
      req.on("error", reject);
      req.end();
    });
  }

  async function serve(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const method = req.method ?? "?";
    const verdict = classifyRequest({ method: req.method, url: req.url, rawHeaders: req.rawHeaders }, {
      registries: config.registries,
      limits: config.limits,
      isPackageAllowed,
    });
    if (!verdict.ok) {
      audit.record({ method, class: verdict.class, registry: null, host: null, status: verdict.status, decision: "deny", reason: verdict.reason });
      send(res, verdict.status, verdict.reason, verdict.status === 405 ? { allow: "GET, HEAD" } : {});
      return;
    }
    await forward(req, res, verdict, signal);
  }

  async function forward(req: IncomingMessage, res: ServerResponse, acc: Accepted, signal: AbortSignal): Promise<void> {
    let url = new URL(`${acc.registry.upstreamOrigin}${acc.upstreamPath}`);
    const visited = [url.href];
    let tainted = false;
    for (;;) {
      const headers = buildUpstreamHeaders(req.headers, url, { registry: acc.registry, tainted });
      const upstream = await requestUpstream(url, acc.method, headers, signal);
      const status = upstream.statusCode ?? 502;
      if (REDIRECT_STATUSES.has(status)) {
        upstream.resume();
        const decision = decideRedirect(url, upstream.headers.location, {
          registryOrigin: acc.registry.upstreamOrigin,
          allowHosts: config.allowHosts,
          maxRedirects: config.limits.maxRedirects,
          visited,
        });
        if (decision.action === "deny") {
          audit.record({ method: acc.method, class: acc.class, registry: acc.registry.id, host: url.host, status: decision.status, decision: "deny", reason: decision.reason });
          send(res, decision.status, decision.reason);
          return;
        }
        if (decision.crossOrigin) tainted = true;
        url = decision.url;
        visited.push(url.href);
        continue;
      }
      const declared = Number(upstream.headers["content-length"]);
      if (Number.isFinite(declared) && declared > config.limits.maxResponseBytes) {
        upstream.destroy();
        audit.record({ method: acc.method, class: acc.class, registry: acc.registry.id, host: url.host, status: 502, decision: "error", reason: "response-too-large" });
        send(res, 502, "response-too-large");
        return;
      }
      const out: Record<string, string> = {};
      for (const h of RESPONSE_HEADERS) {
        const v = upstream.headers[h];
        if (typeof v === "string") out[h] = v;
      }
      const record = (decision: "allow" | "error", reason: string, st = status): void =>
        audit.record({ method: acc.method, class: acc.class, registry: acc.registry.id, host: url.host, status: st, decision, reason });
      res.writeHead(status, out);
      if (acc.method === "HEAD" || status === 204 || status === 304) {
        upstream.resume();
        res.end();
        record("allow", "forwarded");
        return;
      }
      const cap = new ByteCap(config.limits.maxResponseBytes);
      await new Promise<void>((done) => {
        pipeline(upstream, cap, res, (err) => {
          if (!err) record("allow", "forwarded");
          else if (cap.exceeded) record("error", "response-too-large", 502);
          else if (signal.aborted) record("error", "aborted-or-timeout", 504);
          else record("error", "stream-failed", 502);
          done();
        });
      });
      return;
    }
  }

  const server = http.createServer({
    maxHeaderSize: config.limits.maxHeaderBytes,
    headersTimeout: config.limits.requestTimeoutMs,
    requestTimeout: config.limits.requestTimeoutMs,
    keepAliveTimeout: 2000,
    connectionsCheckingInterval: Math.max(10, Math.min(1000, Math.floor(config.limits.requestTimeoutMs / 2))),
  });
  server.on("connection", track);

  server.on("request", (req, res) => {
    if (!gate.tryAcquire()) {
      audit.record({ method: req.method ?? "?", class: "denied", registry: null, host: null, status: 503, decision: "deny", reason: "concurrency-limit" });
      send(res, 503, "concurrency-limit", { "retry-after": "1" });
      return;
    }
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, config.limits.requestTimeoutMs);
    timers.add(timer);
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    serve(req, res, ac.signal)
      .catch((err: unknown) => {
        const reason = timedOut ? "upstream-timeout" : "upstream-error";
        audit.record({ method: req.method ?? "?", class: "denied", registry: null, host: null, status: timedOut ? 504 : 502, decision: "error", reason });
        send(res, timedOut ? 504 : 502, reason);
      })
      .finally(() => {
        clearTimeout(timer);
        timers.delete(timer);
        gate.release();
      });
  });

  server.on("connect", (req, socket, head) =>
    handleConnect(req, socket as Socket, head, {
      allowHosts: config.allowHosts,
      limits: config.limits,
      lookup,
      audit,
      tryAcquire: () => gate.tryAcquire(),
      release: () => gate.release(),
      track,
      mapTarget: options.testDial
        ? (host, port) => {
            const d = options.testDial?.({ hostname: host, port, protocol: "https:" });
            return d ? { hostname: d.hostname, port: d.port } : undefined;
          }
        : undefined,
    }),
  );

  server.on("upgrade", (req, socket) => {
    audit.record({ method: req.method ?? "?", class: "denied", registry: null, host: null, status: 400, decision: "deny", reason: "upgrade-not-allowed" });
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    if (err.code === "ECONNRESET" || err.code === "EPIPE") {
      socket.destroy(); // peer went away; not a malformed request
      return;
    }
    const overflow = err.code === "HPE_HEADER_OVERFLOW";
    const timeout = err.code === "ERR_HTTP_REQUEST_TIMEOUT";
    const status = overflow ? 431 : timeout ? 408 : 400;
    const reason = overflow ? "headers-too-large" : timeout ? "request-timeout" : "malformed-request";
    audit.record({ method: "?", class: "invalid", registry: null, host: null, status, decision: "deny", reason });
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("proxy failed to bind");

  return {
    host: config.listen.host,
    port: addr.port,
    redact,
    audit: () => audit.entries(),
    addAllowedPackages(names) {
      for (const n of names) if (isValidPackageName(n)) allow.add(n);
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
