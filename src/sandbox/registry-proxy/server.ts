import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { AuditLog, clientFamily, type AuditEntry, type AuditInput, type ClientFamily } from "./audit.js";
import { configSecrets, isValidPackageName, type ProxyConfig, type RegistryConfig } from "./config.js";
import { handleConnect } from "./connect.js";
import { createResolver, type DialTarget, type NameResolver, type TestDialSeam } from "./dial.js";
import { Counter, Gate } from "./gate.js";
import { buildUpstreamHeaders } from "./headers.js";
import { BlockedAddressError, resolveVetted } from "./netguard.js";
import { etagMatches, plausibleTarballUrl, rewritePackument, validateLearnedUrl, weakEtag } from "./packument.js";
import { decideRedirect, hostPortOf, REDIRECT_STATUSES } from "./redirect.js";
import { classifyRequest, isAllowedUpstreamPackagePath, routePrefix, type Accepted } from "./request.js";
import { createRedactor, type Redactor } from "./secret.js";

export interface ProxyOptions {
  /** Inject a resolver (tests). Default: dns.Resolver bound to config.dns. */
  resolver?: NameResolver;
  now?: () => number;
  /** Receives one redacted JSON line per audit entry. */
  auditSink?: (line: string) => void;
  /** TEST ONLY, see dial.ts. Never set by production code paths. */
  testDial?: TestDialSeam;
  /** TEST ONLY: extra CA for upstream TLS (lets a loopback fixture with a self-signed certificate be reached through the REAL, seam-less dial path). */
  testTlsCa?: string;
}

export interface RegistryProxy {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
  audit(): AuditEntry[];
  /** Extends the package-name allowlist at runtime (e.g. versions/names discovered during bisect). */
  addAllowedPackages(names: readonly string[]): void;
  /** Names let through by `discovery: "audit"` (declared by an allowed packument and then requested), sorted. */
  discoveredNames(): string[];
  /** Valid package names that were refused as "package-not-allowlisted" (sorted, bounded). */
  deniedPackages(): string[];
  readonly redact: Redactor;
}

/*
 * Design notes (kept next to the code that implements them):
 *  - Range requests are NOT honoured: the upstream request never carries `Range`, so a client asking
 *    for bytes=0-99 gets the full body with 200. No supported client depends on ranges for tarballs.
 *  - npm audit (POST /-/npm/v1/security/advisories/bulk) and /-/ping are denied by design (405/403);
 *    the sandbox npmrc generated in phase 4 sets audit=false so they never appear in the report.
 *  - Packuments are buffered, `dist.tarball` is rewritten to this proxy (see packument.ts) and validators are
 *    ours (weak etag over the rewritten body); conditional requests are answered locally, the packument is
 *    always re-fetched upstream (no cache).
 *  - yarn classic's lockfile `resolved` URLs still point at the original registry host: rewriting the
 *    sandbox copy of the lockfile is phase 4, not a proxy feature.
 */

const RESPONSE_HEADERS = ["content-type", "content-length", "content-encoding", "etag", "last-modified", "cache-control", "vary"];
const MAX_PIPELINED = 8;
const MAX_LEARNED = 200_000;
const MAX_DENIED_NAMES = 10_000;
const MAX_DECLARED = 500_000;

class ByteCap extends Writable {
  exceeded = false;
  seen = 0;
  readonly chunks: Buffer[] = [];
  constructor(private readonly max: number) {
    super();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.seen += chunk.length;
    if (this.seen > this.max) {
      this.exceeded = true;
      cb(new Error("response too large"));
      return;
    }
    this.chunks.push(chunk);
    cb();
  }
}

/** Counts and caps bytes on their way to the client (tarball streaming). */
class CountingPass extends Writable {
  exceeded = false;
  seen = 0;
  constructor(
    private readonly max: number,
    private readonly sink: ServerResponse,
  ) {
    super();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.seen += chunk.length;
    if (this.seen > this.max) {
      this.exceeded = true;
      cb(new Error("response too large"));
      return;
    }
    if (this.sink.write(chunk)) cb();
    else this.sink.once("drain", () => cb());
  }
  override _final(cb: (err?: Error | null) => void): void {
    this.sink.end();
    cb();
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

/** Non-2xx upstream answers never reach the client with their body (a reflecting upstream could echo the credential). */
function sendUpstreamError(res: ServerResponse, clientStatus: number, upstreamStatus: number, retryAfter: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: `upstream ${upstreamStatus}` });
  const headers: Record<string, string | number> = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
  if (typeof retryAfter === "string" && /^\d{1,7}$/.test(retryAfter)) headers["retry-after"] = retryAfter;
  res.writeHead(clientStatus, headers);
  res.end(res.req.method === "HEAD" ? undefined : body);
}

interface SocketState {
  busy: boolean;
  /** Set once the socket was dropped for pipelining too deep. */
  dropped?: boolean;
  queue: { req: IncomingMessage; res: ServerResponse }[];
}

export async function startRegistryProxy(config: ProxyConfig, options: ProxyOptions = {}): Promise<RegistryProxy> {
  const redact = createRedactor(configSecrets(config));
  const now = options.now ?? Date.now;
  const audit = new AuditLog(redact, now, options.auditSink);
  const resolver = options.resolver ?? createResolver(config.dns);
  const gate = new Gate(config.limits.maxConcurrent, config.limits.maxQueued, config.limits.queueWaitMs);
  const tunnels = new Counter(config.limits.maxTunnels);
  const allow = new Set(config.packages.allow);
  const declared = new Set<string>();
  const discovered = new Set<string>();
  const denied = new Set<string>();
  const learned = new Map<string, string>();
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const track = (s: Socket): void => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };
  const discoveryOn = config.discovery === "audit";
  const isPackageAllowed = (name: string): boolean | "discovered" => {
    if (allow.has(name) || config.packages.allowPrefixes.some((p) => name.startsWith(p))) return true;
    return discoveryOn && declared.has(name) ? "discovered" : false;
  };
  const learnKey = (r: RegistryConfig, name: string, version: string): string => `${r.id}\n${name}\n${version}`;

  function learn(r: RegistryConfig, name: string, list: readonly { version: string; url: string }[]): void {
    for (const { version, url } of list) {
      const u = new URL(url);
      if (u.origin === r.upstreamOrigin && !plausibleTarballUrl(u, name, version)) continue;
      if (learned.size >= MAX_LEARNED) learned.delete(learned.keys().next().value as string);
      learned.set(learnKey(r, name, version), url);
    }
  }

  function requestUpstream(url: URL, method: string, headers: Record<string, string>, signal: AbortSignal, allowPrivate: boolean): Promise<IncomingMessage> {
    return (async () => {
      // Resolve ONCE, vet the answer, connect to that exact address. The name only survives as SNI / Host.
      const vetted = await resolveVetted(url.hostname, resolver, allowPrivate);
      const port = Number(url.port) || 443;
      const seam = options.testDial?.({ hostname: url.hostname, port, protocol: "https:" });
      if (options.testDial && !seam) throw new Error("no dial target");
      const literal = isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0;
      // SNI is the NAME; for an IP-literal upstream there is none (an IP as SNI is deprecated and ignored).
      const dial: DialTarget = seam ?? { protocol: "https:", hostname: vetted.address, port, ...(literal ? {} : { servername: url.hostname }) };
      const opts: https.RequestOptions = {
        method,
        hostname: dial.hostname,
        port: dial.port,
        path: url.pathname + url.search,
        headers,
        agent: false,
        signal,
        ...(dial.protocol === "https:" ? { servername: dial.servername ?? (literal ? "" : url.hostname), ca: dial.ca ?? options.testTlsCa } : {}),
      };
      return await new Promise<IncomingMessage>((resolve, reject) => {
        const req = (dial.protocol === "https:" ? https : http).request(opts, resolve);
        req.on("error", reject);
        req.end();
      });
    })();
  }

  const allowPrivateFor = (r: RegistryConfig, url: URL): boolean => (url.origin === r.upstreamOrigin ? r.allowPrivateAddresses : config.allowPrivateHosts.has(hostPortOf(url)));

  async function serve(req: IncomingMessage, res: ServerResponse, ac: AbortController): Promise<void> {
    const started = now();
    const method = req.method ?? "?";
    const client = clientFamily(req.headers["user-agent"]);
    const verdict = classifyRequest({ method: req.method, url: req.url, rawHeaders: req.rawHeaders }, {
      registries: config.registries,
      limits: config.limits,
      isPackageAllowed,
    });
    if (!verdict.ok) {
      if (verdict.reason === "package-not-allowlisted" && verdict.name !== undefined && denied.size < MAX_DENIED_NAMES) denied.add(verdict.name);
      audit.record({ method, class: verdict.class, registry: verdict.registry ?? null, host: null, status: verdict.status, decision: "deny", reason: verdict.reason, name: verdict.name ?? null, client, ms: now() - started });
      send(res, verdict.status, verdict.reason, verdict.status === 405 ? { allow: "GET, HEAD" } : {});
      return;
    }
    const slot = await gate.acquire(ac.signal);
    if (slot === "aborted") return;
    if (slot !== "ok") {
      const reason = slot === "timeout" ? "queue-timeout" : "queue-full";
      audit.record({ method, class: verdict.class, registry: verdict.registry.id, host: null, status: 503, decision: "deny", reason, name: verdict.name, client, ms: now() - started });
      send(res, 503, reason, { "retry-after": "1" });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, config.limits.requestTimeoutMs);
    timers.add(timer);
    const rec = (entry: Omit<AuditInput, "method" | "class" | "registry" | "name" | "version" | "client" | "ms">): void =>
      audit.record({ method, class: verdict.class, registry: verdict.registry.id, name: verdict.name, ...(verdict.version !== undefined ? { version: verdict.version } : {}), client, ms: now() - started, ...entry });
    try {
      if (verdict.discovered && !discovered.has(verdict.name)) {
        discovered.add(verdict.name);
        rec({ host: null, status: 0, decision: "allow", reason: "discovered" });
      }
      await forward(req, res, verdict, ac.signal, rec);
    } catch (err: unknown) {
      const blocked = err instanceof BlockedAddressError;
      const reason = blocked ? "blocked-address" : timedOut ? "upstream-timeout" : "upstream-error";
      const status = blocked ? 403 : timedOut ? 504 : 502;
      rec({ host: null, status, decision: blocked ? "deny" : "error", reason });
      send(res, status, reason);
    } finally {
      clearTimeout(timer);
      timers.delete(timer);
      gate.release();
    }
  }

  async function forward(req: IncomingMessage, res: ServerResponse, acc: Accepted, signal: AbortSignal, rec: (e: Omit<AuditInput, "method" | "class" | "registry" | "name" | "version" | "client" | "ms">) => void): Promise<void> {
    const rewriting = acc.class === "packument";
    let url: URL;
    let tainted = false;
    const learnedHref = acc.class === "tarball" && acc.version !== undefined ? learned.get(learnKey(acc.registry, acc.name, acc.version)) : undefined;
    if (learnedHref !== undefined && validateLearnedUrl(learnedHref)) {
      url = new URL(learnedHref);
      if (url.origin !== acc.registry.upstreamOrigin) {
        // Learned from a packument, but a foreign origin: only an allowlisted host, and never with the credential.
        if (!config.allowHosts.has(hostPortOf(url))) {
          rec({ host: url.host, status: 403, decision: "deny", reason: "tarball-host-not-allowed" });
          send(res, 403, "tarball-host-not-allowed");
          return;
        }
        tainted = true;
      }
    } else {
      url = new URL(`${acc.registry.upstreamOrigin}${acc.upstreamPath}`);
    }
    const visited = [url.href];
    const isAllowedName = (n: string): boolean => isPackageAllowed(n) !== false;
    for (;;) {
      const headers = buildUpstreamHeaders(req.headers, url, { registry: acc.registry, tainted, rewriting });
      const upstream = await requestUpstream(url, acc.method, headers, signal, allowPrivateFor(acc.registry, url));
      const status = upstream.statusCode ?? 502;
      if (REDIRECT_STATUSES.has(status)) {
        upstream.resume();
        const decision = decideRedirect(url, upstream.headers.location, {
          registryOrigin: acc.registry.upstreamOrigin,
          allowHosts: config.allowHosts,
          maxRedirects: config.limits.maxRedirects,
          visited,
          isPackagePath: (next) => isAllowedUpstreamPackagePath(acc.registry, next.pathname, next.search, isAllowedName),
        });
        if (decision.action === "deny") {
          rec({ host: url.host, status: decision.status, decision: "deny", reason: decision.reason, upstreamStatus: status });
          send(res, decision.status, decision.reason);
          return;
        }
        if (decision.dropCredential) tainted = true;
        url = decision.url;
        visited.push(url.href);
        continue;
      }
      await respond(req, res, acc, upstream, status, url, signal, rec);
      return;
    }
  }

  async function respond(
    req: IncomingMessage,
    res: ServerResponse,
    acc: Accepted,
    upstream: IncomingMessage,
    status: number,
    url: URL,
    signal: AbortSignal,
    rec: (e: Omit<AuditInput, "method" | "class" | "registry" | "name" | "version" | "client" | "ms">) => void,
  ): Promise<void> {
    const isHead = acc.method === "HEAD";
    // Conditional 304 (tarballs only; packument validators are ours) carries no body.
    if (status === 304 && acc.class === "tarball") {
      const out: Record<string, string> = {};
      for (const h of ["etag", "last-modified", "cache-control", "vary"]) {
        const v = upstream.headers[h];
        if (typeof v === "string") out[h] = v;
      }
      upstream.resume();
      res.writeHead(304, out);
      res.end();
      rec({ host: url.host, status: 304, decision: "allow", reason: "not-modified", upstreamStatus: 304 });
      return;
    }
    if (status < 200 || status > 299) {
      // D4: never forward the body of a non-2xx upstream answer.
      upstream.resume();
      const clientStatus = status >= 400 && status <= 599 && status !== 407 ? status : 502;
      rec({ host: url.host, status: clientStatus, decision: "upstream-error", reason: `upstream-${status}`, upstreamStatus: status });
      sendUpstreamError(res, clientStatus, status, upstream.headers["retry-after"]);
      return;
    }
    const declaredLength = Number(upstream.headers["content-length"]);
    const cap = acc.class === "packument" ? Math.min(config.limits.maxPackumentBytes, config.limits.maxResponseBytes) : config.limits.maxResponseBytes;
    if (Number.isFinite(declaredLength) && declaredLength > cap) {
      upstream.destroy();
      rec({ host: url.host, status: 502, decision: "error", reason: "response-too-large", upstreamStatus: status });
      send(res, 502, "response-too-large");
      return;
    }

    if (acc.class === "packument") {
      await respondPackument(req, res, acc, upstream, status, url, signal, cap, rec);
      return;
    }

    const out: Record<string, string> = {};
    for (const h of RESPONSE_HEADERS) {
      const v = upstream.headers[h];
      if (typeof v === "string") out[h] = v;
    }
    res.writeHead(status, out);
    if (isHead || status === 204) {
      upstream.resume();
      res.end();
      rec({ host: url.host, status, decision: "allow", reason: "forwarded", upstreamStatus: status, bytes: 0 });
      return;
    }
    const sink = new CountingPass(cap, res);
    try {
      await pipeline(upstream, sink);
      rec({ host: url.host, status, decision: "allow", reason: "forwarded", upstreamStatus: status, bytes: sink.seen });
    } catch {
      if (sink.exceeded) {
        rec({ host: url.host, status: 502, decision: "error", reason: "response-too-large", upstreamStatus: status, bytes: sink.seen });
        res.destroy();
      } else if (signal.aborted) {
        rec({ host: url.host, status: 504, decision: "error", reason: "aborted-or-timeout", upstreamStatus: status, bytes: sink.seen });
        res.destroy();
      } else {
        rec({ host: url.host, status: 502, decision: "error", reason: "stream-failed", upstreamStatus: status, bytes: sink.seen });
        res.destroy();
      }
    }
  }

  async function respondPackument(
    req: IncomingMessage,
    res: ServerResponse,
    acc: Accepted,
    upstream: IncomingMessage,
    status: number,
    url: URL,
    _signal: AbortSignal,
    cap: number,
    rec: (e: Omit<AuditInput, "method" | "class" | "registry" | "name" | "version" | "client" | "ms">) => void,
  ): Promise<void> {
    const outCommon: Record<string, string> = {};
    for (const h of ["cache-control", "vary"]) {
      const v = upstream.headers[h];
      if (typeof v === "string") outCommon[h] = v;
    }
    const ct = typeof upstream.headers["content-type"] === "string" ? upstream.headers["content-type"] : "application/json";
    if (acc.method === "HEAD") {
      // No body to rewrite; upstream length/validators would describe the un-rewritten document, so they are dropped.
      upstream.resume();
      res.writeHead(status, { ...outCommon, "content-type": ct });
      res.end();
      rec({ host: url.host, status, decision: "allow", reason: "forwarded", upstreamStatus: status, bytes: 0 });
      return;
    }
    const encoding = String(upstream.headers["content-encoding"] ?? "identity").toLowerCase().trim();
    let stages: (Readable | NodeJS.ReadWriteStream)[];
    if (encoding === "identity" || encoding === "") stages = [];
    else if (encoding === "gzip" || encoding === "x-gzip") stages = [createGunzip()];
    else if (encoding === "deflate") stages = [createInflate()];
    else if (encoding === "br") stages = [createBrotliDecompress()];
    else {
      upstream.destroy();
      rec({ host: url.host, status: 502, decision: "error", reason: "unsupported-encoding", upstreamStatus: status });
      send(res, 502, "unsupported-encoding");
      return;
    }
    const collect = new ByteCap(cap);
    try {
      await pipeline([upstream, ...stages, collect] as [Readable, ...NodeJS.ReadWriteStream[], Writable]);
    } catch {
      rec({ host: url.host, status: 502, decision: "error", reason: collect.exceeded ? "response-too-large" : "stream-failed", upstreamStatus: status, bytes: collect.seen });
      send(res, 502, collect.exceeded ? "response-too-large" : "stream-failed");
      return;
    }
    const base = `http://${req.headers.host as string}${routePrefix(acc.registry)}`;
    const rewritten = rewritePackument(Buffer.concat(collect.chunks), acc.name, base);
    if (!rewritten) {
      rec({ host: url.host, status: 502, decision: "error", reason: "packument-not-json", upstreamStatus: status, bytes: collect.seen });
      send(res, 502, "packument-not-json");
      return;
    }
    learn(acc.registry, acc.name, rewritten.learned);
    if (discoveryOn) for (const n of rewritten.declared) if (declared.size < MAX_DECLARED) declared.add(n);
    const etag = weakEtag(rewritten.body);
    if (etagMatches(typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : undefined, etag)) {
      res.writeHead(304, { ...outCommon, etag });
      res.end();
      rec({ host: url.host, status: 304, decision: "allow", reason: "not-modified", upstreamStatus: status, bytes: 0 });
      return;
    }
    res.writeHead(200, { ...outCommon, "content-type": ct, etag, "content-length": rewritten.body.length });
    res.end(rewritten.body);
    rec({ host: url.host, status: 200, decision: "allow", reason: "forwarded", upstreamStatus: status, bytes: rewritten.body.length });
  }

  // ---- per-socket serialisation: one in-flight request per connection, pipelined ones wait their turn ----
  const socketState = new WeakMap<Socket, SocketState>();
  function run(req: IncomingMessage, res: ServerResponse, st: SocketState): void {
    st.busy = true;
    const ac = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) ac.abort();
    };
    res.on("close", onClose);
    serve(req, res, ac)
      .catch(() => {
        if (!res.headersSent) send(res, 502, "upstream-error");
        else res.destroy();
      })
      .finally(() => {
        res.off("close", onClose);
        st.busy = false;
        for (let next = st.queue.shift(); next; next = st.queue.shift()) {
          if (next.res.destroyed || next.res.writableEnded) continue;
          run(next.req, next.res, st);
          return;
        }
      });
  }

  const headersTimeout = Math.min(config.limits.requestTimeoutMs, 30_000);
  const server = http.createServer({
    maxHeaderSize: config.limits.maxHeaderBytes,
    headersTimeout,
    requestTimeout: config.limits.requestTimeoutMs,
    // Idle keep-alive reuse must survive gaps between resolve and fetch phases (clients keep sockets pooled).
    keepAliveTimeout: config.limits.keepAliveTimeoutMs,
    connectionsCheckingInterval: Math.max(10, Math.min(1000, Math.floor(config.limits.requestTimeoutMs / 2))),
  });
  server.maxConnections = config.limits.maxConnections;

  const perSource = new Map<string, number>();
  let refusedConnections = 0;
  server.on("connection", (s: Socket) => {
    const ip = s.remoteAddress ?? "?";
    const n = (perSource.get(ip) ?? 0) + 1;
    if (n > config.limits.maxConnectionsPerSource) {
      refusedConnections++;
      if (refusedConnections % 100 === 1) {
        audit.record({ method: "?", class: "denied", registry: null, host: null, status: 0, decision: "deny", reason: "connection-limit" });
      }
      s.destroy();
      return;
    }
    perSource.set(ip, n);
    s.once("close", () => {
      const left = (perSource.get(ip) ?? 1) - 1;
      if (left <= 0) perSource.delete(ip);
      else perSource.set(ip, left);
    });
    track(s);
  });

  server.on("request", (req, res) => {
    let st = socketState.get(req.socket);
    if (!st) {
      st = { busy: false, queue: [] };
      socketState.set(req.socket, st);
    }
    if (!st.busy) {
      run(req, res, st);
      return;
    }
    if (st.dropped) return;
    if (st.queue.length >= MAX_PIPELINED) {
      st.dropped = true;
      st.queue.length = 0;
      audit.record({ method: req.method ?? "?", class: "denied", registry: null, host: null, status: 0, decision: "deny", reason: "pipeline-limit" });
      req.socket.destroy();
      return;
    }
    st.queue.push({ req, res });
  });

  server.on("connect", (req, socket, head) =>
    handleConnect(req, socket as Socket, head, {
      allowHosts: config.allowHosts,
      allowPrivateHosts: config.allowPrivateHosts,
      limits: config.limits,
      resolver,
      audit,
      tryAcquire: () => tunnels.tryAcquire(),
      release: () => tunnels.release(),
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
    server.listen({ port: config.listen.port, host: config.listen.host, backlog: Math.max(511, config.limits.maxConnections) }, () => {
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
    discoveredNames: () => [...discovered].sort(),
    deniedPackages: () => [...denied].sort(),
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      gate.dispose();
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
