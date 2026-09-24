import assert from "node:assert/strict";
import net from "node:net";
import { describe, test } from "node:test";
import { ConfigError, parseConfig } from "../../src/sandbox/registry-proxy/config.js";
import { BlockedAddressError, classifyAddress, resolveVetted, type NameResolver } from "../../src/sandbox/registry-proxy/netguard.js";
import { startRegistryProxy } from "../../src/sandbox/registry-proxy/server.js";
import { CANARY, TEST_CERT, Upstream, get, raw, redirectTo, startWorld, statusOf } from "./fixtures.js";

// These tests call the REAL guard (netguard.ts) through the real dial/connect paths: no mock of the check itself.

describe("destination guard: address classification (IPv4, IPv6 and every embedding form)", () => {
  const table: [string, "public" | "private" | "never"][] = [
    // public
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["93.184.216.34", "public"],
    ["172.15.255.255", "public"],
    ["172.32.0.1", "public"],
    ["100.63.255.255", "public"],
    ["100.128.0.1", "public"],
    ["169.253.255.255", "public"],
    ["169.255.0.1", "public"],
    ["192.169.0.1", "public"],
    ["11.0.0.1", "public"],
    ["223.255.255.255", "public"],
    ["2606:4700:4700::1111", "public"],
    ["2001:4860:4860::8888", "public"],
    ["2a00:1450:4001:81b::200e", "public"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::808:808", "public"],
    ["2002:808:808::", "public"],
    // private (loopback, RFC1918, CGNAT, ULA)
    ["127.0.0.1", "private"],
    ["127.255.255.254", "private"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["100.64.0.1", "private"],
    ["100.127.255.255", "private"],
    ["::1", "private"],
    ["fc00::1", "private"],
    ["fd12:3456:789a::1", "private"],
    ["fdff:ffff:ffff::1", "private"],
    ["::ffff:127.0.0.1", "private"],
    ["::ffff:10.1.2.3", "private"],
    ["::ffff:7f00:1", "private"],
    ["::ffff:c0a8:101", "private"],
    ["0:0:0:0:0:ffff:127.0.0.1", "private"],
    ["64:ff9b::7f00:1", "private"],
    ["64:ff9b::a00:1", "private"],
    ["2002:7f00:1::", "private"],
    ["2002:c0a8:101::1", "private"],
    // never, even with allowPrivateAddresses
    ["0.0.0.0", "never"],
    ["0.1.2.3", "never"],
    ["169.254.169.254", "never"],
    ["169.254.0.1", "never"],
    ["169.254.255.255", "never"],
    ["224.0.0.1", "never"],
    ["239.255.255.255", "never"],
    ["240.0.0.1", "never"],
    ["255.255.255.255", "never"],
    ["192.0.0.1", "never"],
    ["192.0.2.1", "never"],
    ["192.88.99.1", "never"],
    ["198.18.0.1", "never"],
    ["198.19.255.255", "never"],
    ["198.51.100.7", "never"],
    ["203.0.113.9", "never"],
    ["::", "never"],
    ["::2", "never"],
    ["::a00:1", "never"],
    ["::169.254.169.254", "never"],
    ["::ffff:169.254.169.254", "never"],
    ["::ffff:a9fe:a9fe", "never"],
    ["::ffff:0.0.0.0", "never"],
    ["::ffff:224.0.0.1", "never"],
    ["fe80::1", "never"],
    ["febf:ffff::1", "never"],
    ["fec0::1", "never"],
    ["ff02::1", "never"],
    ["ff00::", "never"],
    ["2001:db8::1", "never"],
    ["2001::1", "never"],
    ["2001:2::1", "never"],
    ["2001:10::1", "never"],
    ["64:ff9b:1::1", "never"],
    ["64:ff9b::a9fe:a9fe", "never"],
    ["64:ff9b::e000:1", "never"],
    ["2002:a9fe:a9fe::", "never"],
    ["2002:0:0::1", "never"],
    ["100::1", "never"],
    ["3fff::1", "never"],
    ["5f00::1", "never"],
    ["4000::1", "never"],
    // not an address at all: refused
    ["fe80::1%eth0", "never"],
    ["1.2.3", "never"],
    ["127.1", "never"],
    ["2130706433", "never"],
    ["0x7f.0.0.1", "never"],
    ["017700000001", "never"],
    ["localhost", "never"],
    ["", "never"],
    ["[::1]x", "never"],
  ];
  for (const [ip, expected] of table) {
    test(`${JSON.stringify(ip)} -> ${expected}`, () => assert.equal(classifyAddress(ip), expected));
  }
  test("bracketed IPv6 (URL.hostname form) is classified like the bare literal", () => {
    assert.equal(classifyAddress("[::1]"), "private");
    assert.equal(classifyAddress("[2606:4700:4700::1111]"), "public");
    assert.equal(classifyAddress("[fe80::1]"), "never");
  });
});

function scripted(answers: Record<string, string[][]>): NameResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve4: async (h) => {
      calls.push(h);
      const list = answers[h];
      if (!list || list.length === 0) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
      return list.length > 1 ? (list.shift() as string[]) : (list[0] as string[]);
    },
  };
}

describe("destination guard: resolveVetted", () => {
  test("public answer passes and is returned as THE address to connect to", async () => {
    const r = scripted({ "a.test": [["93.184.216.34"]] });
    assert.deepEqual(await resolveVetted("a.test", r, false), { address: "93.184.216.34", family: 4 });
  });

  test("DNS rebinding: public first, private second. The first (vetted) answer is used, the name is resolved exactly once", async () => {
    const r = scripted({ "rebind.test": [["93.184.216.34"], ["127.0.0.1"]] });
    const first = await resolveVetted("rebind.test", r, false);
    assert.equal(first.address, "93.184.216.34");
    assert.equal(r.calls.length, 1, "the vetted address is connected to directly, no second lookup happens");
    await assert.rejects(resolveVetted("rebind.test", r, false), (e: unknown) => e instanceof BlockedAddressError, "the private answer is refused when it does come back");
  });

  test("a mixed answer (one public, one private) is refused as a whole", async () => {
    const r = scripted({ "mix.test": [["93.184.216.34", "10.0.0.5"]] });
    await assert.rejects(resolveVetted("mix.test", r, false), BlockedAddressError);
  });

  for (const [ip, klass] of [
    ["127.0.0.1", "private"],
    ["10.1.2.3", "private"],
    ["169.254.169.254", "never"],
    ["::ffff:169.254.169.254", "never"],
    ["0.0.0.0", "never"],
  ] as const) {
    test(`name resolving to ${ip} (${klass}) is refused by default`, async () => {
      await assert.rejects(resolveVetted("x.test", scripted({ "x.test": [[ip]] }), false), (e: unknown) => e instanceof BlockedAddressError && e.addressClass === klass);
    });
  }

  test("allowPrivate admits loopback/RFC1918/ULA but never link-local, metadata, multicast or unspecified", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.5", "192.168.9.9", "100.64.1.1"]) {
      assert.equal((await resolveVetted("x.test", scripted({ "x.test": [[ip]] }), true)).address, ip);
    }
    for (const ip of ["169.254.169.254", "224.0.0.1", "0.0.0.0", "240.0.0.1", "192.0.2.5"]) {
      await assert.rejects(resolveVetted("x.test", scripted({ "x.test": [[ip]] }), true), BlockedAddressError, ip);
    }
    const v6 = { resolve4: async () => [], resolve6: async () => ["fd00::5"] };
    assert.equal((await resolveVetted("x.test", v6, true)).family, 6);
    await assert.rejects(resolveVetted("x.test", { resolve4: async () => [], resolve6: async () => ["fe80::1"] }, true), BlockedAddressError);
  });

  test("IP-literal hosts are vetted directly (v4, bracketed v6), never sent to the resolver", async () => {
    const r = scripted({});
    await assert.rejects(resolveVetted("127.0.0.1", r, false), BlockedAddressError);
    await assert.rejects(resolveVetted("[::1]", r, false), BlockedAddressError);
    await assert.rejects(resolveVetted("[::ffff:7f00:1]", r, false), BlockedAddressError);
    assert.equal((await resolveVetted("8.8.8.8", r, false)).address, "8.8.8.8");
    assert.equal(r.calls.length, 0);
  });

  test("unresolvable names fail with ENOTFOUND, not with an address", async () => {
    await assert.rejects(resolveVetted("nx.test", scripted({}), false), (e: unknown) => (e as { code?: string }).code === "ENOTFOUND");
  });
});

describe("destination guard: config", () => {
  const base = (over: Record<string, unknown>): unknown => ({ registries: [{ id: "main", upstream: "https://registry.example.com" }], dns: ["127.0.0.1"], ...over });
  test("IP-literal and numeric-looking upstream hosts are refused unless allowPrivateAddresses", () => {
    for (const up of ["https://127.0.0.1", "https://10.0.0.5:8443", "https://[::1]", "https://[fd00::1]:8443", "https://8.8.8.8", "https://2130706433", "https://0x7f.1", "https://127.1"]) {
      assert.throws(() => parseConfig(base({ registries: [{ id: "main", upstream: up }] })), ConfigError, up);
      assert.doesNotThrow(() => parseConfig(base({ registries: [{ id: "main", upstream: up, allowPrivateAddresses: true }] })), up);
    }
  });
  test("a numeric last label that the URL parser rejects outright is refused too", () => {
    assert.throws(() => parseConfig(base({ registries: [{ id: "main", upstream: "https://foo.0x10", allowPrivateAddresses: true }] })), ConfigError);
  });
  test("IP-literal allowHosts entries need the explicit per-entry option; the option is per entry, not global", () => {
    for (const h of ["127.0.0.1:443", "10.0.0.5:9000", "2130706433:443", "0x7f.1:443", "host.42:443"]) {
      assert.throws(() => parseConfig(base({ allowHosts: [h] })), ConfigError, h);
    }
    const cfg = parseConfig(base({ allowHosts: ["cdn.example.com:443", { host: "10.0.0.5:9000", allowPrivateAddresses: true }, { host: "art.corp:443", allowPrivateAddresses: true }] }));
    assert.deepEqual([...cfg.allowHosts].sort(), ["art.corp:443", "cdn.example.com:443", "10.0.0.5:9000"].sort());
    assert.deepEqual([...cfg.allowPrivateHosts].sort(), ["10.0.0.5:9000", "art.corp:443"]);
    assert.equal(cfg.allowPrivateHosts.has("cdn.example.com:443"), false);
    assert.equal(cfg.registries[0]?.allowPrivateAddresses, false);
    assert.throws(() => parseConfig(base({ allowHosts: [{ host: "a.example.com:443", allowPrivateAddresses: "yes" }] })), ConfigError);
    assert.throws(() => parseConfig(base({ allowHosts: [{ host: "a.example.com:443", extra: 1 }] })), ConfigError);
    assert.throws(() => parseConfig(base({ registries: [{ id: "main", upstream: "https://registry.example.com", allowPrivateAddresses: 1 }] })), ConfigError);
  });
});

async function proxyWithResolver(over: Record<string, unknown>, resolver: NameResolver, tls = false) {
  const cfg = parseConfig({ dns: ["127.0.0.1"], limits: { requestTimeoutMs: 3000 }, packages: { allow: ["left-pad"] }, ...over });
  return startRegistryProxy(cfg, { resolver, ...(tls ? { testTlsCa: TEST_CERT } : {}) });
}

describe("destination guard: applied on every dial path (no test seam, real sockets)", () => {
  test("registry name resolving to loopback: 403 blocked-address, the fixture is never contacted, no credential leaves", async () => {
    const up = await Upstream.start("https");
    const proxy = await proxyWithResolver({ registries: [{ id: "main", upstream: `https://registry.test:${up.port}`, credential: { type: "bearer", secret: CANARY } }] }, { resolve4: async () => ["127.0.0.1"] }, true);
    try {
      const r = await get(proxy.port, "/left-pad");
      assert.equal(r.status, 403);
      assert.equal(up.hits.length, 0);
      const e = proxy.audit().at(-1);
      assert.deepEqual([e?.decision, e?.reason, e?.registry], ["deny", "blocked-address", "main"]);
    } finally {
      await proxy.close();
      await up.close();
    }
  });

  test("cloud metadata address is refused even for a registry that opted into private addresses", async () => {
    const proxy = await proxyWithResolver({ registries: [{ id: "main", upstream: "https://registry.test", allowPrivateAddresses: true }] }, { resolve4: async () => ["169.254.169.254"] });
    try {
      const r = await get(proxy.port, "/left-pad");
      assert.equal(r.status, 403);
      assert.equal(proxy.audit().at(-1)?.reason, "blocked-address");
    } finally {
      await proxy.close();
    }
  });

  test("an explicitly allowed private registry works end to end, credential attached, the guard still applies to other registries", async () => {
    const up = await Upstream.start("https");
    const proxy = await proxyWithResolver(
      {
        registries: [
          { id: "corp", default: true, upstream: `https://registry.test:${up.port}`, allowPrivateAddresses: true, credential: { type: "bearer", secret: CANARY } },
          { id: "other", upstream: `https://other.test:${up.port}`, credential: { type: "bearer", secret: "OTHER-secret-12345" } },
        ],
      },
      { resolve4: async () => ["127.0.0.1"] },
      true,
    );
    try {
      const ok = await get(proxy.port, "/left-pad");
      assert.equal(ok.status, 200);
      assert.equal(up.hits[0]?.headers.authorization, `Bearer ${CANARY}`);
      const blocked = await get(proxy.port, "/_r/other/left-pad");
      assert.equal(blocked.status, 403, "the opt-in is per registry");
      assert.equal(up.hits.length, 1);
    } finally {
      await proxy.close();
      await up.close();
    }
  });

  test("redirect to an allowlisted host that resolves privately is refused; an explicit per-host opt-in allows exactly that host", async () => {
    const cdn = await Upstream.start("http");
    const world = (allowHosts: unknown[]) =>
      startWorld({
        config: (b) => ({ ...b, allowHosts }),
        proxy: { resolver: { resolve4: async (h) => (h === "cdn.test" ? ["10.9.8.7"] : ["93.184.216.34"]) } },
      });
    let w = await world(["cdn.test:443"]);
    try {
      w.registry.handler = redirectTo("https://cdn.test/blob");
      const r = await get(w.proxy.port, "/left-pad/-/left-pad-1.3.0.tgz");
      assert.equal(r.status, 403);
      assert.equal(w.cdn.hits.length, 0);
      assert.equal(w.proxy.audit().at(-1)?.reason, "blocked-address");
    } finally {
      await w.close();
    }
    w = await world([{ host: "cdn.test:443", allowPrivateAddresses: true }]);
    try {
      w.registry.handler = redirectTo("https://cdn.test/blob");
      w.cdn.handler = (_q, res) => {
        res.writeHead(200);
        res.end("BLOB");
      };
      const r = await get(w.proxy.port, "/left-pad/-/left-pad-1.3.0.tgz");
      assert.equal(r.status, 200);
      assert.equal(r.body, "BLOB");
    } finally {
      await w.close();
      await cdn.close();
    }
  });

  test("redirect targets given as IP literals in any spelling are refused (not allowlisted, cannot be allowlisted without the opt-in)", async () => {
    const w = await startWorld();
    try {
      for (const loc of ["https://127.0.0.1/x", "https://[::1]/x", "https://[::ffff:7f00:1]/x", "https://0x7f.1/x", "https://2130706433/x", "https://169.254.169.254/latest/meta-data", "https://[fe80::1]/x", "https://0177.0.0.1/x"]) {
        w.registry.handler = redirectTo(loc);
        const r = await get(w.proxy.port, "/left-pad/-/left-pad-1.3.0.tgz");
        assert.equal(r.status, 403, loc);
      }
      assert.equal(w.cdn.hits.length + w.evil.hits.length, 0);
    } finally {
      await w.close();
    }
  });

  test("DNS rebinding through the proxy: every upstream request resolves exactly once and a later private answer is refused", async () => {
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    const calls: string[] = [];
    const w = await startWorld({
      proxy: {
        resolver: {
          resolve4: async (h) => {
            calls.push(h);
            return (answers.length > 1 ? answers.shift() : answers[0]) as string[];
          },
        },
      },
    });
    try {
      const first = await get(w.proxy.port, "/left-pad");
      assert.equal(first.status, 200);
      assert.deepEqual(calls, ["registry.test"], "one resolution per upstream connection");
      const second = await get(w.proxy.port, "/left-pad");
      assert.equal(second.status, 403);
      assert.equal(w.registry.hits.length, 1);
    } finally {
      await w.close();
    }
  });

  test("CONNECT: allowlisted name resolving to a private/link-local address is refused; per-entry opt-in reaches it", async () => {
    const inner = net.createServer((s) => s.end("INTERNAL-SERVICE-REACHED"));
    await new Promise<void>((r) => inner.listen(0, "127.0.0.1", r));
    const port = (inner.address() as net.AddressInfo).port;
    let reached = 0;
    inner.on("connection", () => reached++);
    const resolver = (ip: string): NameResolver => ({ resolve4: async () => [ip] });
    const mk = (allowHosts: unknown[], ip: string) => proxyWithResolver({ registries: [{ id: "main", upstream: "https://registry.example.com" }], allowHosts }, resolver(ip));
    try {
      let p = await mk([`priv.test:${port}`], "127.0.0.1");
      let res = await raw(p.port, `CONNECT priv.test:${port} HTTP/1.1\r\nHost: x\r\n\r\n`, 800);
      assert.equal(statusOf(res), 403);
      assert.ok(!res.includes("INTERNAL-SERVICE-REACHED"));
      assert.equal(reached, 0);
      assert.equal(p.audit().at(-1)?.reason, "blocked-address");
      await p.close();

      p = await mk([{ host: `priv.test:${port}`, allowPrivateAddresses: true }], "169.254.169.254");
      res = await raw(p.port, `CONNECT priv.test:${port} HTTP/1.1\r\nHost: x\r\n\r\n`, 800);
      assert.equal(statusOf(res), 403, "opt-in never covers link-local / metadata");
      await p.close();

      p = await mk([{ host: `priv.test:${port}`, allowPrivateAddresses: true }], "127.0.0.1");
      res = await raw(p.port, `CONNECT priv.test:${port} HTTP/1.1\r\nHost: x\r\n\r\n`, 800);
      assert.equal(statusOf(res), 200);
      assert.ok(res.includes("INTERNAL-SERVICE-REACHED"));
      await p.close();
    } finally {
      inner.close();
    }
  });
});
