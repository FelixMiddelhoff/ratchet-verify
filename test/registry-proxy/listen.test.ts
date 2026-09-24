import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, test } from "node:test";
import { clientInCidrs, parseClientCidr } from "../../src/sandbox/registry-proxy/clients.js";
import { ConfigError, parseConfig } from "../../src/sandbox/registry-proxy/config.js";
import { resolveListenHost } from "../../src/sandbox/registry-proxy/server.js";
import { get, raw, startWorld, statusOf } from "./fixtures.js";

const base = {
  registries: [{ id: "main", upstream: "https://registry.test" }],
  dns: ["1.1.1.1"],
};

const iface = (address: string, family: "IPv4" | "IPv6" | number = "IPv4"): NetworkInterfaceInfo =>
  ({ address, family, internal: false, cidr: null, mac: "", netmask: "" }) as unknown as NetworkInterfaceInfo;

describe("threat: proxy reachable from the default bridge (listen address and client ranges)", () => {
  test("a wildcard listen address is refused in every spelling", () => {
    for (const host of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::0"]) {
      assert.throws(() => parseConfig({ ...base, listen: { host, port: 3128 } }), /wildcard/, host);
    }
  });

  test("listen.host and listen.cidr are mutually exclusive; cidr must be an IPv4 /8-/30", () => {
    assert.throws(() => parseConfig({ ...base, listen: { host: "10.1.2.3", cidr: "10.1.2.0/24" } }), /mutually exclusive/);
    for (const cidr of ["10.1.2.0/7", "10.1.2.0/31", "10.1.2.0", "fd00::/64", "nonsense", "10.1.2.0/24/1", "300.1.1.0/24"]) {
      assert.throws(() => parseConfig({ ...base, listen: { cidr } }), ConfigError, cidr);
    }
  });

  test("a non-loopback listen host needs explicit client ranges; loopback and cidr do not", () => {
    assert.throws(() => parseConfig({ ...base, listen: { host: "10.1.2.3" } }), /allowClients/);
    assert.doesNotThrow(() => parseConfig({ ...base, listen: { host: "10.1.2.3" }, allowClients: ["10.1.2.0/24"] }));
    assert.doesNotThrow(() => parseConfig({ ...base, listen: { host: "127.0.0.1" } }));
    const cfg = parseConfig({ ...base, listen: { cidr: "10.1.2.0/24" } });
    assert.equal(cfg.allowClients.length, 1);
    assert.throws(() => parseConfig({ ...base, listen: { cidr: "10.1.2.0/24" }, allowClients: ["nope"] }), /allowClients\[0\]/);
  });

  test("resolveListenHost binds the ONE local address inside the range, never a wildcard", () => {
    const listen = parseConfig({ ...base, listen: { cidr: "10.201.5.0/24" } }).listen;
    const pick = (ifaces: Record<string, NetworkInterfaceInfo[]>): string => resolveListenHost(listen, () => ifaces);
    // sidecar shape: internal-net address, default-bridge address, loopback
    assert.equal(pick({ lo: [iface("127.0.0.1")], eth0: [iface("10.201.5.2")], eth1: [iface("172.17.0.4")] }), "10.201.5.2");
    assert.equal(pick({ eth0: [iface("10.201.5.7", 4)] }), "10.201.5.7", "numeric family (older node) is understood");
    assert.throws(() => pick({ lo: [iface("127.0.0.1")], eth1: [iface("172.17.0.4")] }), /found 0/, "no address in the range: fail, no fallback");
    assert.throws(() => pick({ a: [iface("10.201.5.2")], b: [iface("10.201.5.3")] }), /found 2/, "ambiguous: fail");
    assert.throws(() => pick({ a: [iface("fd00::1", "IPv6")] }), /found 0/, "IPv6 is ignored");
  });

  test("the client range matches exactly, including IPv4-mapped peers", () => {
    const range = [parseClientCidr("10.201.5.0/24")!];
    assert.ok(clientInCidrs("10.201.5.9", range));
    assert.ok(clientInCidrs("::ffff:10.201.5.9", range));
    for (const outside of ["10.201.6.9", "172.17.0.2", "127.0.0.1", "::1", "not-an-ip", undefined]) {
      assert.ok(!clientInCidrs(outside, range), String(outside));
    }
  });

  test("a peer outside allowClients is dropped before a byte is parsed: HTTP and CONNECT", async () => {
    const world = await startWorld({ config: (b) => ({ ...b, allowClients: ["10.99.0.0/16"] }) });
    try {
      await assert.rejects(get(world.proxy.port, "/left-pad"), "no HTTP response at all");
      assert.equal(await raw(world.proxy.port, "GET /left-pad HTTP/1.1\r\nHost: x\r\n\r\n", 500), "");
      assert.equal(await raw(world.proxy.port, "CONNECT registry.test:443 HTTP/1.1\r\nHost: registry.test:443\r\n\r\n", 500), "");
      assert.equal(world.totalHits(), 0, "nothing reached any upstream");
      assert.ok(world.proxy.audit().some((e) => e.reason === "client-not-allowed"), "the refusal is audited");
    } finally {
      await world.close();
    }
  });

  test("a peer inside allowClients is served normally", async () => {
    const world = await startWorld({ config: (b) => ({ ...b, allowClients: ["127.0.0.0/8"] }) });
    try {
      const reply = await get(world.proxy.port, "/left-pad");
      assert.ok(reply.status > 0 && reply.status !== 0);
      assert.notEqual(statusOf(await raw(world.proxy.port, "GET /left-pad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", 800)), 0);
    } finally {
      await world.close();
    }
  });
});
