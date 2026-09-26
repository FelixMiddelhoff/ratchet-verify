import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { parseConfig, DEFAULT_LIMITS } from "../../src/sandbox/registry-proxy/config.js";
import { startRegistryProxy } from "../../src/sandbox/registry-proxy/server.js";
import { PUBLIC_RESOLVER } from "./fixtures.js";

// threat (review MEDIUM-1): a CDN listed only so tarball redirects can be followed must not become a raw tunnel target for the sandbox.

function connectStatus(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let data = "";
    socket.on("data", (d) => {
      data += d.toString();
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0)));
  });
}

test("a host in allowHosts (redirects/tarballs) is refused for CONNECT unless it is also in connectHosts", async () => {
  let dials = 0;
  const cfg = parseConfig({
    registries: [{ id: "main", upstream: "https://registry.test" }],
    allowHosts: ["cdn.test:443", "both.test:443"],
    connectHosts: ["both.test:443"],
    packages: { allow: ["left-pad"] },
    dns: ["127.0.0.1"],
    limits: { connectTimeoutMs: 500 },
  });
  const proxy = await startRegistryProxy(cfg, {
    resolver: PUBLIC_RESOLVER,
    testDial: (l) => {
      dials++;
      return l.hostname === "both.test" ? { protocol: "http:", hostname: "127.0.0.1", port: 9 } : undefined;
    },
  });
  try {
    assert.equal(await connectStatus(proxy.port, "cdn.test:443"), 403, "redirect-only host is not a tunnel target");
    assert.equal(dials, 0, "nothing was dialled for the refused host");
    assert.notEqual(await connectStatus(proxy.port, "both.test:443"), 403, "an explicit connectHosts entry is allowed through the gate");
    assert.ok(proxy.audit().some((e) => e.class === "connect" && e.decision === "deny" && e.host === "cdn.test:443"));
  } finally {
    await proxy.close();
  }
});

test("tunnels have a default byte cap (not unlimited), and connectHosts default to none", () => {
  assert.ok(DEFAULT_LIMITS.maxConnectBytes > 0 && DEFAULT_LIMITS.maxConnectBytes <= 8 * 1024 ** 3);
  const cfg = parseConfig({ registries: [{ id: "main", upstream: "https://registry.test" }], allowHosts: ["cdn.test:443"], dns: ["1.1.1.1"] });
  assert.equal(cfg.connectHosts.size, 0);
});
