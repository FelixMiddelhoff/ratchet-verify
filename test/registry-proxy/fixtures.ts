import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import { parseConfig, type ProxyConfig } from "../../src/sandbox/registry-proxy/config.js";
import type { DialTarget, NameResolver, TestDialSeam } from "../../src/sandbox/registry-proxy/dial.js";
import { startRegistryProxy, type ProxyOptions, type RegistryProxy } from "../../src/sandbox/registry-proxy/server.js";

// Test-only self-signed certificate for CN=localhost / SAN registry.test (valid to 2126).
// It protects nothing: it exists so the proxy's real https upstream code path runs against a loopback fixture.
export const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDMDCCAhigAwIBAgIUfMbhV9ZETd9XFvdKpFima/pT+NEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkyNDExNDE1NloYDzIxMjYw
ODMxMTE0MTU2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDM/sburvV8c1L766iEpse8XYk/NcWYTHd1Qg0x37d0
k5WHgDp3q79NjEYDaCZSqPvpChyqFGCZtIeQ3oWx7hmZ3O18CW7eThwhj4NVvHO7
wZaPuGD+A8A+LtTNF5QziJ6QB3Xg1HOE8yDxUR4sf9uFPz0gdY2n47h88jmw2jco
Xoe7NqOwQ+/laz2+UtGMF82zBz7PL8nMjpZtQSEbejv2CzV/6/Q851dLsBnYFBWR
DMJN6D+qovaIqGEB7JWfV9cMqsD+ovi76Wz8HjpgCIlGlAEalXCprBl7qk6r5BRV
Q7ogLYfwMkyEErvTaf8U+6AAHV9LkOiztdW40OXpN/QLAgMBAAGjeDB2MB0GA1Ud
DgQWBBReOrZyNCsMUrAZO/7KndINTVEnxjAfBgNVHSMEGDAWgBReOrZyNCsMUrAZ
O/7KndINTVEnxjAPBgNVHRMBAf8EBTADAQH/MCMGA1UdEQQcMBqCCWxvY2FsaG9z
dIINcmVnaXN0cnkudGVzdDANBgkqhkiG9w0BAQsFAAOCAQEAoET6U5e08dx+ccmP
6xoVyECvsCNejT/+KXGcE9ZDPkbPjSDHNffPeVwcoYIpEYXhEF3WLeqOnq+p9VEm
/aTJrVfFzXPtqnPHyfkKdh24ji9SmNcNDuSoaAKU33nFxtfFmaDUGj56UjskDgnl
+eL0OV9sY1lt2fYlg+vOdumqKwe+GAxuEbVymfVgCse+sfahXzVdFa/h2s6IKUSZ
oVXKZ5YWpf+Vpasq+al3nQZKxJ0JWcAcay3ixFSRqbOQHyUFgRXbDiQnE9ilZd8o
jEe+Q/y6mxFpSLd78lcnIm7f9njSZrd0bodpGaC+kh1lckPN7kfX/Gzsb13M7V9T
U8t2QQ==
-----END CERTIFICATE-----
`;
export const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDM/sburvV8c1L7
66iEpse8XYk/NcWYTHd1Qg0x37d0k5WHgDp3q79NjEYDaCZSqPvpChyqFGCZtIeQ
3oWx7hmZ3O18CW7eThwhj4NVvHO7wZaPuGD+A8A+LtTNF5QziJ6QB3Xg1HOE8yDx
UR4sf9uFPz0gdY2n47h88jmw2jcoXoe7NqOwQ+/laz2+UtGMF82zBz7PL8nMjpZt
QSEbejv2CzV/6/Q851dLsBnYFBWRDMJN6D+qovaIqGEB7JWfV9cMqsD+ovi76Wz8
HjpgCIlGlAEalXCprBl7qk6r5BRVQ7ogLYfwMkyEErvTaf8U+6AAHV9LkOiztdW4
0OXpN/QLAgMBAAECggEABhS2TIP/uWzjJcLffzBkrM1wtjbW3PcYQau8QjMVks+k
nFnI0SbD1R/vHRTCCGZa//zFZyxRChFmRn1DWNGFyDmns6vm5ZEoRFZTb3/YeW9q
NVmawifU3MvjgdvUu62MJPqMNZ7zeCuvfAO+uodVfT2F/t/EOitT4IsZUYoIqG8e
xTZyN5xbKVWFcCajOJS1B+19THHG2zYKXukGoEGKknwslenb2VyKmKoJFYLnOsC0
ey7FOyTBqN8FdG1Oe4+pMZolT3vplr988stusU8BKTW173g5sqF3GsfNLE27k6x6
u1UBqPFPjU0C1I4CGEANGmmlvYKaafB3hMvGKYx2kQKBgQDoH+Hb2ojh5uBA9EAq
4uYh8CONrOnXCQP009a+/gErIM/FGmHejkHoTYU7w/1+NhuzBC3KvJu7RxYO0xkC
AtIXCr6MLLDwrsVIXRw1/kxbceZ4ARv6Mx34hV46ah6NfsKGua4rFoTKe//98F+z
W4/n5Y8VLlJm82nKA68bt+6uIwKBgQDiFIweV8r3MUqUqabA/roeeEwYZj8oYvqg
GsW3z+8Dv71mjYMuQGTYJ2gCnUAqt+jUWBMxCWb/31NZ7+Mgh4NpeZGcgM7sjErs
kOldB5KBZQ3dQZKXlAxXjT6KG59RwFkmpKjufURFryg5UC69M2a2aybzezqr9WqA
LVHcCFRc+QKBgEdNO9CPwUo65BmvrWI/DlfQbute+PlvsIJs6+MBHRTFYGz4HKYD
ZqVX4pwoKN6y+jE0EGjdJK0TOehV2bGvch9X0o42UCeuV7VRvI+tTIEubI/iL1jc
iNFFDlu9KyNlk5VUxfZAVYvpKQo04wCyGHMwJZJpBzDOhmliVlCaYDunAoGBAMrw
oNq3+iSs5YLPSzXhMpcZa01XswgA2XMQtT0L9UTLQCwniYLiIOP7c50tJSVzkxfR
u+B/zSqQgNSxxpMzsd3jV7dB1P137eWvKxvsKTHn0Ws0am+QYQfSbToyE3CiFiTf
GBmE7t0Snyvbcyk5U9EaHIvhqUgk86X9iIbYH0qZAoGACG7TXmamuAd23uEQ7Tq2
XZ14B/ijgD6VEdaMBnvjQ4+uzfAdp6G3rtty3EtSGy2SUoL1GyKRp8k/d5aADHFD
/eXkaq8RMzm71T2XhhRbbJQWyYRvc5EhnvtrNbrrnFuNG/FUzuXW5S7ec5jhf0s2
VbLqm59ruaHTH9x2eJZNVn0=
-----END PRIVATE KEY-----
`;

/** Every name resolves to a routable public address; the seam then redirects the physical socket to loopback. The guard still runs on the logical answer. */
export const PUBLIC_RESOLVER: NameResolver = { resolve4: async () => ["93.184.216.34"] };

/** Canary secret: must never appear in any output of the proxy. */
export const CANARY = "CANARY-tok-9f3a7c21d4b85e60aa17";

export interface Hit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}
export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export class Upstream {
  readonly hits: Hit[] = [];
  handler: Handler;
  port = 0;
  private constructor(private readonly server: http.Server | https.Server, handler: Handler) {
    this.handler = handler;
  }
  static async start(kind: "http" | "https", handler: Handler = okJson): Promise<Upstream> {
    let self: Upstream | undefined;
    const onRequest: Handler = (req, res) => {
      self?.hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      self?.handler(req, res);
    };
    const server = kind === "https" ? https.createServer({ key: TEST_KEY, cert: TEST_CERT }, onRequest) : http.createServer(onRequest);
    self = new Upstream(server, handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    self.port = (server.address() as net.AddressInfo).port;
    return self;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export const okJson: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"name":"left-pad"}');
};

export const redirectTo =
  (location: string, status = 302): Handler =>
  (_req, res) => {
    res.writeHead(status, { location });
    res.end();
  };

export interface World {
  proxy: RegistryProxy;
  registry: Upstream;
  cdn: Upstream;
  evil: Upstream;
  config: ProxyConfig;
  close(): Promise<void>;
  /** Everything the fixture upstreams saw, flattened (for "never reached upstream" assertions). */
  totalHits(): number;
}

export interface WorldOptions {
  config?: (base: Record<string, unknown>) => Record<string, unknown>;
  proxy?: ProxyOptions;
}

/**
 * Logical hosts: registry.test:443 (https fixture, gets the credential), cdn.test:443 (http fixture),
 * evil.test:443 (http fixture, never allowlisted unless a test adds it). The test seam routes them to loopback.
 */
export async function startWorld(opts: WorldOptions = {}): Promise<World> {
  const registry = await Upstream.start("https");
  const cdn = await Upstream.start("http");
  const evil = await Upstream.start("http");
  const base: Record<string, unknown> = {
    registries: [{ id: "main", upstream: "https://registry.test", credential: { type: "bearer", secret: CANARY } }],
    allowHosts: ["cdn.test:443"],
    packages: { allow: ["left-pad", "@scope/pkg"] },
    dns: ["127.0.0.1"],
    limits: { requestTimeoutMs: 5000 },
  };
  const config = parseConfig(opts.config ? opts.config(base) : base);
  const table: Record<string, DialTarget> = {
    "registry.test:443": { protocol: "https:", hostname: "127.0.0.1", port: registry.port, servername: "registry.test", ca: TEST_CERT },
    "cdn.test:443": { protocol: "http:", hostname: "127.0.0.1", port: cdn.port },
    "evil.test:443": { protocol: "http:", hostname: "127.0.0.1", port: evil.port },
  };
  const testDial: TestDialSeam = (l) => table[`${l.hostname}:${l.port}`];
  const proxy = await startRegistryProxy(config, { testDial, resolver: PUBLIC_RESOLVER, ...opts.proxy });
  return {
    proxy,
    registry,
    cdn,
    evil,
    config,
    totalHits: () => registry.hits.length + cdn.hits.length + evil.hits.length,
    async close() {
      await proxy.close();
      await Promise.all([registry.close(), cdn.close(), evil.close()]);
    },
  };
}

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Sends raw bytes and returns everything received until the peer closes (or `waitMs` passes). */
export function raw(port: number, payload: string, waitMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(payload));
    let out = "";
    s.on("data", (d) => (out += d.toString("latin1")));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
    setTimeout(() => {
      s.destroy();
      resolve(out);
    }, waitMs);
  });
}

export const statusOf = (rawResponse: string): number => Number(/^HTTP\/1\.\d (\d{3})/.exec(rawResponse)?.[1] ?? 0);
