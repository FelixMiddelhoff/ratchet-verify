import assert from "node:assert/strict";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { inspect } from "node:util";
import { after, before, describe, test } from "node:test";
import { ConfigError, configSecrets, parseConfig } from "../../src/sandbox/registry-proxy/config.js";
import type { DialTarget, TestDialSeam } from "../../src/sandbox/registry-proxy/dial.js";
import { startRegistryProxy, type RegistryProxy } from "../../src/sandbox/registry-proxy/server.js";
import { ClientCertificate, createRedactor } from "../../src/sandbox/registry-proxy/secret.js";
import { get, PUBLIC_RESOLVER, TEST_CERT, TEST_KEY } from "./fixtures.js";
import { CLIENT_CA, CLIENT_CERT, CLIENT_KEY, CLIENT_KEY_ENCRYPTED } from "./mtls-fixtures.js";

/** threat: a registry that demands mutual TLS gets the client certificate from the proxy, and only from the proxy, only for its own origin. */

interface Seen {
  url: string;
  authorized: boolean;
  peerCn: string | undefined;
}

/** An https upstream that verifies client certificates against the test client CA (or, `strict: false`, only records what was presented). */
async function mtlsServer(strict: boolean, handler: (url: string, res: import("node:http").ServerResponse) => void): Promise<{ port: number; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT, ca: CLIENT_CA, requestCert: true, rejectUnauthorized: strict }, (req, res) => {
    const socket = req.socket as Socket & { authorized?: boolean; getPeerCertificate(): { subject?: { CN?: string } } };
    seen.push({ url: req.url ?? "", authorized: socket.authorized === true, peerCn: socket.getPeerCertificate().subject?.CN });
    handler(req.url ?? "", res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const ok = (_url: string, res: import("node:http").ServerResponse): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"name":"left-pad"}');
};

describe("mutual TLS to the upstream registry", () => {
  let registry: Awaited<ReturnType<typeof mtlsServer>>;
  let other: Awaited<ReturnType<typeof mtlsServer>>;
  const proxies: RegistryProxy[] = [];

  before(async () => {
    registry = await mtlsServer(true, ok);
    other = await mtlsServer(false, ok);
  });
  after(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await registry.close();
    await other.close();
  });

  const start = async (withCert: boolean): Promise<RegistryProxy> => {
    const config = parseConfig({
      registries: [
        { id: "main", upstream: "https://registry.test", ...(withCert ? { clientCertificate: { cert: CLIENT_CERT, key: CLIENT_KEY } } : {}) },
      ],
      allowHosts: ["other.test:443"],
      packages: { allow: ["left-pad"] },
      dns: ["127.0.0.1"],
      limits: { requestTimeoutMs: 5000 },
    });
    const table: Record<string, DialTarget> = {
      "registry.test:443": { protocol: "https:", hostname: "127.0.0.1", port: registry.port, servername: "registry.test", ca: TEST_CERT },
      "other.test:443": { protocol: "https:", hostname: "127.0.0.1", port: other.port, servername: "other.test", ca: TEST_CERT },
    };
    const testDial: TestDialSeam = (l) => table[`${l.hostname}:${l.port}`];
    const proxy = await startRegistryProxy(config, { testDial, resolver: PUBLIC_RESOLVER });
    proxies.push(proxy);
    return proxy;
  };

  test("with a client certificate the registry accepts the request and sees the certificate's subject", async () => {
    const before = registry.seen.length;
    const proxy = await start(true);
    const reply = await get(proxy.port, "/left-pad");
    assert.equal(reply.status, 200, reply.body);
    const seen = registry.seen.slice(before);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.authorized, true);
    assert.equal(seen[0]!.peerCn, "ratchet-test-client");
  });

  test("without one the registry refuses the handshake and the client gets a generic error, not TLS details", async () => {
    const proxy = await start(false);
    const reply = await get(proxy.port, "/left-pad");
    assert.ok(reply.status >= 500, String(reply.status));
    assert.ok(!reply.body.includes("certificate"), reply.body);
  });

  test("after a cross-origin redirect the certificate is not presented to the other host", async () => {
    other.seen.length = 0;
    // The registry answers the packument with a redirect to the allowlisted other host.
    const redirecting = await mtlsServer(true, (_url, res) => {
      res.writeHead(302, { location: "https://other.test/left-pad" });
      res.end();
    });
    try {
      const config = parseConfig({
        registries: [{ id: "main", upstream: "https://registry.test", clientCertificate: { cert: CLIENT_CERT, key: CLIENT_KEY } }],
        allowHosts: ["other.test:443"],
        packages: { allow: ["left-pad"] },
        dns: ["127.0.0.1"],
        limits: { requestTimeoutMs: 5000 },
      });
      const table: Record<string, DialTarget> = {
        "registry.test:443": { protocol: "https:", hostname: "127.0.0.1", port: redirecting.port, servername: "registry.test", ca: TEST_CERT },
        "other.test:443": { protocol: "https:", hostname: "127.0.0.1", port: other.port, servername: "other.test", ca: TEST_CERT },
      };
      const p2 = await startRegistryProxy(config, { testDial: (l) => table[`${l.hostname}:${l.port}`], resolver: PUBLIC_RESOLVER });
      proxies.push(p2);
      await get(p2.port, "/left-pad");
      assert.equal(redirecting.seen[0]?.peerCn, "ratchet-test-client", "the registry itself got the certificate");
      for (const s of other.seen) assert.equal(s.peerCn, undefined, "the redirect target must not receive the certificate");
    } finally {
      await redirecting.close();
    }
  });

  test("the key never appears in the config's serialised forms, in audit output or in what the proxy answers", async () => {
    const proxy = await start(true);
    const reply = await get(proxy.port, "/left-pad");
    const config = parseConfig({ registries: [{ id: "main", upstream: "https://registry.test", clientCertificate: { cert: CLIENT_CERT, key: CLIENT_KEY } }], dns: ["1.1.1.1"] });
    const body = CLIENT_KEY.split("\n").filter((l) => !l.startsWith("-----"))[1]!;
    const haystack = [JSON.stringify(config), inspect(config, { depth: 10 }), JSON.stringify(proxy.audit()), reply.body, JSON.stringify(reply.headers), String(config.registries[0]!.clientCertificate)].join("\n");
    assert.ok(!haystack.includes(body), "no key line anywhere");
    assert.ok(!haystack.includes("PRIVATE KEY"));
    const redact = createRedactor(configSecrets(config));
    assert.ok(!redact(`leak: ${CLIENT_KEY}`).includes(body));
    assert.ok(!redact(`leak: ${CLIENT_KEY.replace(/\n/g, "")}`).includes(body));
    assert.ok(!redact(`leak: ${body}`).includes(body));
  });
});

describe("client certificate validation", () => {
  test("an encrypted key, a non-PEM value and a missing half are refused; messages carry no key material", () => {
    const attempts: unknown[] = [
      { cert: CLIENT_CERT, key: CLIENT_KEY_ENCRYPTED },
      { cert: "not a certificate", key: CLIENT_KEY },
      { cert: CLIENT_CERT, key: "not a key" },
      { cert: CLIENT_CERT },
      { cert: CLIENT_CERT, key: CLIENT_KEY, extra: 1 },
    ];
    for (const clientCertificate of attempts) {
      assert.throws(
        () => parseConfig({ registries: [{ id: "main", upstream: "https://r.example", clientCertificate }], dns: ["1.1.1.1"] }),
        (e: unknown) => e instanceof ConfigError && !e.message.includes("MII") && !e.message.includes("PRIVATE KEY"),
      );
    }
    assert.throws(() => new ClientCertificate(CLIENT_CERT, CLIENT_KEY_ENCRYPTED), /unencrypted/);
    assert.doesNotThrow(() => new ClientCertificate(CLIENT_CERT, CLIENT_KEY));
  });

  test("ClientCertificate never serialises the key", () => {
    const c = new ClientCertificate(CLIENT_CERT, CLIENT_KEY);
    for (const o of [JSON.stringify(c), String(c), inspect(c), inspect([c], { depth: 9 }), JSON.stringify({ ...c })]) {
      assert.ok(!o.includes("MIIE") && !o.includes("PRIVATE KEY"), o);
    }
  });
});
