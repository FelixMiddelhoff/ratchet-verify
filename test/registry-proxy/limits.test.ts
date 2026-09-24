import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { describe, test } from "node:test";
import { Counter, Gate } from "../../src/sandbox/registry-proxy/gate.js";
import { DEFAULT_LIMITS } from "../../src/sandbox/registry-proxy/config.js";
import { get, okJson, startWorld, statusOf, type World, type WorldOptions } from "./fixtures.js";

async function withWorld(body: (w: World) => Promise<void>, opts: WorldOptions = {}): Promise<void> {
  const w = await startWorld(opts);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tarball = (i: number): string => `/pkg-${i}/-/pkg-${i}-1.0.0.tgz`;
const manyPackages = (n: number): string[] => Array.from({ length: n }, (_v, i) => `pkg-${i}`);

describe("Gate and Counter (unit)", () => {
  test("Gate: slots, FIFO hand-over, queue-full, wait timeout, abort while waiting, dispose", async () => {
    const g = new Gate(2, 2, 60);
    assert.equal(await g.acquire(), "ok");
    assert.equal(await g.acquire(), "ok");
    const order: string[] = [];
    const w1 = g.acquire().then((r) => order.push(`w1:${r}`));
    const w2 = g.acquire().then((r) => order.push(`w2:${r}`));
    assert.equal(g.queued, 2);
    assert.equal(await g.acquire(), "queue-full");
    g.release();
    await w1;
    assert.equal(g.active, 2, "the slot was handed over, not freed and re-taken");
    g.release();
    await w2;
    assert.deepEqual(order, ["w1:ok", "w2:ok"], "FIFO");
    assert.equal(g.queued, 0);
  });

  test("Gate: timeout and abort", async () => {
    const g = new Gate(1, 5, 50);
    assert.equal(await g.acquire(), "ok");
    const t0 = Date.now();
    assert.equal(await g.acquire(), "timeout");
    assert.ok(Date.now() - t0 >= 40);
    const ac = new AbortController();
    const p = g.acquire(ac.signal);
    ac.abort();
    assert.equal(await p, "aborted");
    assert.equal(g.queued, 0);
    assert.equal(await g.acquire(AbortSignal.abort()), "aborted");
    const g2 = new Gate(1, 5, 5000);
    await g2.acquire();
    const pending = g2.acquire();
    g2.dispose();
    assert.equal(await pending, "aborted");
  });

  test("Counter caps and releases", () => {
    const c = new Counter(2);
    assert.ok(c.tryAcquire() && c.tryAcquire());
    assert.ok(!c.tryAcquire());
    c.release();
    assert.ok(c.tryAcquire());
    c.release();
    c.release();
    c.release();
    assert.ok(c.tryAcquire(), "release never goes below zero");
  });

  test("defaults: 128 concurrent, bounded queue, keep-alive 65 s, sane connection caps", () => {
    assert.equal(DEFAULT_LIMITS.maxConcurrent, 128);
    assert.ok(DEFAULT_LIMITS.maxQueued >= 512);
    assert.equal(DEFAULT_LIMITS.keepAliveTimeoutMs, 65_000);
    assert.ok(DEFAULT_LIMITS.maxConnections >= DEFAULT_LIMITS.maxConnectionsPerSource);
    assert.ok(DEFAULT_LIMITS.maxConnectionsPerSource >= 256);
  });
});

describe("D3: bounded queue instead of a hard 503 cap", () => {
  test("berry scenario: 100 parallel tarball requests on 100 sockets, no retries, every one succeeds (default limits)", () =>
    withWorld(
      async (w) => {
        w.registry.handler = (_q, res) => {
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            res.end("tgz");
          }, 40);
        };
        const replies = await Promise.all(Array.from({ length: 100 }, (_v, i) => get(w.proxy.port, tarball(i))));
        assert.deepEqual(replies.map((r) => r.status).filter((s) => s !== 200), []);
        assert.equal(w.registry.hits.length, 100);
      },
      { config: (b) => ({ ...b, packages: { allow: manyPackages(100) }, limits: { requestTimeoutMs: 10_000 } }) },
    ));

  test("a burst well beyond maxConcurrent queues and drains (180 requests, 128 slots)", () =>
    withWorld(
      async (w) => {
        w.registry.handler = (_q, res) => setTimeout(() => okJson(_q, res), 30);
        const replies = await Promise.all(Array.from({ length: 180 }, (_v, i) => get(w.proxy.port, tarball(i % 100))));
        assert.equal(replies.filter((r) => r.status === 200).length, 180);
      },
      { config: (b) => ({ ...b, packages: { allow: manyPackages(100) }, limits: { requestTimeoutMs: 20_000 } }) },
    ));

  test("waiters are served FIFO as slots free up", () =>
    withWorld(
      async (w) => {
        const seen: string[] = [];
        w.registry.handler = (q, res) => {
          seen.push(q.url ?? "");
          setTimeout(() => okJson(q, res), 40);
        };
        const rs = [];
        for (let i = 0; i < 4; i++) {
          rs.push(get(w.proxy.port, tarball(i)));
          await sleep(15);
        }
        assert.deepEqual((await Promise.all(rs)).map((r) => r.status), [200, 200, 200, 200]);
        assert.deepEqual(seen, [0, 1, 2, 3].map(tarball));
      },
      { config: (b) => ({ ...b, packages: { allow: manyPackages(4) }, limits: { maxConcurrent: 1, requestTimeoutMs: 10_000 } }) },
    ));

  test("waiting longer than queueWaitMs gives 503 queue-timeout with Retry-After; the audit says so", () =>
    withWorld(
      async (w) => {
        w.registry.handler = () => undefined; // hangs: holds the only slot
        const first = get(w.proxy.port, "/left-pad").catch(() => undefined);
        await sleep(50);
        const t0 = Date.now();
        const second = await get(w.proxy.port, "/left-pad");
        assert.equal(second.status, 503);
        assert.equal(second.headers["retry-after"], "1");
        assert.ok(Date.now() - t0 >= 150 && Date.now() - t0 < 1500, `waited ${Date.now() - t0}`);
        assert.equal(w.proxy.audit().find((e) => e.status === 503)?.reason, "queue-timeout");
        assert.equal(w.registry.hits.length, 1, "the timed-out request never reached the upstream");
        await first;
      },
      { config: (b) => ({ ...b, limits: { maxConcurrent: 1, queueWaitMs: 200, requestTimeoutMs: 1500 } }) },
    ));

  test("queue full: 503 queue-full immediately; queued clients that hang up free their place", () =>
    withWorld(
      async (w) => {
        w.registry.handler = () => undefined;
        const held = get(w.proxy.port, "/left-pad").catch(() => undefined);
        await sleep(50);
        const queued = http.get({ host: "127.0.0.1", port: w.proxy.port, path: "/left-pad", agent: false });
        queued.on("error", () => undefined);
        await sleep(50);
        const full = await get(w.proxy.port, "/left-pad");
        assert.equal(full.status, 503);
        assert.equal(w.proxy.audit().at(-1)?.reason, "queue-full");
        queued.destroy();
        await sleep(100);
        w.registry.handler = okJson;
        // slot still held by the hanging one; but the queue has room again (the aborted waiter left it)
        const again = http.get({ host: "127.0.0.1", port: w.proxy.port, path: "/left-pad", agent: false });
        again.on("error", () => undefined);
        await sleep(100);
        const stillFull = await get(w.proxy.port, "/left-pad");
        assert.equal(stillFull.status, 503);
        again.destroy();
        await held;
      },
      { config: (b) => ({ ...b, limits: { maxConcurrent: 1, maxQueued: 1, queueWaitMs: 5000, requestTimeoutMs: 1200 } }) },
    ));

  test("denied requests never wait in the queue (a saturated proxy still answers policy denials at once)", () =>
    withWorld(
      async (w) => {
        w.registry.handler = () => undefined;
        const held = get(w.proxy.port, "/left-pad").catch(() => undefined);
        await sleep(50);
        const t0 = Date.now();
        assert.equal((await get(w.proxy.port, "/nope")).status, 403);
        assert.equal((await get(w.proxy.port, "/left-pad", {}, "POST")).status, 405);
        assert.ok(Date.now() - t0 < 500);
        await held;
      },
      { config: (b) => ({ ...b, limits: { maxConcurrent: 1, queueWaitMs: 5000, requestTimeoutMs: 800 } }) },
    ));
});

describe("D3: one in-flight request per socket (pipelining cannot starve other clients)", () => {
  test("a client pipelining many hanging requests holds ONE slot; another client is served", () =>
    withWorld(
      async (w) => {
        w.registry.handler = (q, res) => {
          if (q.url === "/@scope%2Fpkg") return; // hang
          okJson(q, res);
        };
        const s = net.connect(w.proxy.port, "127.0.0.1");
        s.on("error", () => undefined);
        s.on("data", () => undefined);
        await new Promise<void>((r) => s.once("connect", () => r()));
        s.write("GET /@scope%2Fpkg HTTP/1.1\r\nHost: a\r\n\r\n".repeat(6));
        await sleep(250);
        assert.equal(w.registry.hits.filter((h) => h.url === "/@scope%2Fpkg").length, 1, "pipelined requests are serialised per socket");
        const t0 = Date.now();
        const other = await get(w.proxy.port, "/left-pad");
        assert.equal(other.status, 200);
        assert.ok(Date.now() - t0 < 1000);
        s.destroy();
      },
      { config: (b) => ({ ...b, limits: { maxConcurrent: 2, requestTimeoutMs: 3000 } }) },
    ));

  test("well-behaved pipelining still works: responses come back in order", () =>
    withWorld(async (w) => {
      w.registry.handler = (q, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: q.url }));
      };
      const s = net.connect(w.proxy.port, "127.0.0.1");
      let out = "";
      s.on("data", (d) => (out += d.toString("latin1")));
      await new Promise<void>((r) => s.once("connect", () => r()));
      s.write("GET /left-pad HTTP/1.1\r\nHost: a\r\n\r\nGET /left-pad/-/left-pad-1.0.0.tgz HTTP/1.1\r\nHost: a\r\n\r\nGET /left-pad HTTP/1.1\r\nHost: a\r\n\r\n");
      for (let i = 0; i < 50 && (out.match(/HTTP\/1\.1 200/g)?.length ?? 0) < 3; i++) await sleep(40);
      assert.equal(out.match(/HTTP\/1\.1 200/g)?.length, 3);
      const urls = [...out.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]);
      assert.equal(urls.length, 3);
      assert.equal(w.registry.hits.length, 3);
      s.destroy();
    }));

  test("an absurd pipeline depth drops the connection (bounded per-socket queue)", () =>
    withWorld(
      async (w) => {
        w.registry.handler = () => undefined;
        const s = net.connect(w.proxy.port, "127.0.0.1");
        s.on("error", () => undefined);
        s.on("data", () => undefined);
        const closed = new Promise<boolean>((r) => {
          s.on("close", () => r(true));
          setTimeout(() => r(false), 3000);
        });
        await new Promise<void>((r) => s.once("connect", () => r()));
        s.write("GET /left-pad HTTP/1.1\r\nHost: a\r\n\r\n".repeat(60));
        assert.equal(await closed, true);
        assert.ok(w.proxy.audit().some((e) => e.reason === "pipeline-limit"));
      },
      { config: (b) => ({ ...b, limits: { requestTimeoutMs: 5000 } }) },
    ));
});

/** Opens n idle sockets in waves (a single burst would overflow the OS accept backlog and refuse connections before the proxy sees them). */
async function openIdleSockets(port: number, n: number): Promise<{ alive: () => number; destroyAll: () => void }> {
  const sockets: net.Socket[] = [];
  let closed = 0;
  for (let i = 0; i < n; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, n - i) }, () =>
        new Promise<void>((resolve) => {
          const s = net.connect(port, "127.0.0.1");
          sockets.push(s);
          s.on("error", () => undefined);
          s.on("close", () => closed++);
          s.once("connect", () => resolve());
          s.once("close", () => resolve());
        }),
      ),
    );
    await sleep(5);
  }
  await sleep(500);
  return { alive: () => n - closed, destroyAll: () => sockets.forEach((s) => s.destroy()) };
}

describe("D3: connection caps", () => {
  test("3000 idle connections from one source are capped by the per-source limit (default), the proxy recovers when they go", async () => {
    const w = await startWorld();
    try {
      const flood = await openIdleSockets(w.proxy.port, 3000);
      const alive = flood.alive();
      assert.equal(alive, DEFAULT_LIMITS.maxConnectionsPerSource, `${alive} sockets stayed open`);
      assert.ok(w.proxy.audit().some((e) => e.reason === "connection-limit"));
      flood.destroyAll();
      await sleep(300);
      assert.equal((await get(w.proxy.port, "/left-pad")).status, 200);
    } finally {
      await w.close();
    }
  });

  test("per-source limit is configurable and does not throttle a second source-less client once slots free up", () =>
    withWorld(
      async (w) => {
        const flood = await openIdleSockets(w.proxy.port, 20);
        assert.equal(flood.alive(), 5);
        flood.destroyAll();
        await sleep(200);
        const again = await openIdleSockets(w.proxy.port, 5);
        assert.equal(again.alive(), 5, "closed connections are released from the per-source count");
        again.destroyAll();
      },
      { config: (b) => ({ ...b, limits: { maxConnectionsPerSource: 5, requestTimeoutMs: 5000 } }) },
    ));

  test("server.maxConnections is a hard cap on open sockets overall", () =>
    withWorld(
      async (w) => {
        const flood = await openIdleSockets(w.proxy.port, 30);
        assert.ok(flood.alive() <= 4, `${flood.alive()} open`);
        flood.destroyAll();
      },
      { config: (b) => ({ ...b, limits: { maxConnections: 4, maxConnectionsPerSource: 100, requestTimeoutMs: 5000 } }) },
    ));
});

describe("D3: keep-alive reuse after idle gaps (compat: stale pooled socket must not ECONNRESET)", () => {
  test("idle 1.9 s .. 10 s between requests on a pooled socket: every request succeeds and the socket is reused", { timeout: 60_000 }, async () => {
    const w = await startWorld();
    try {
      const results: string[] = [];
      const req = (agent: http.Agent): Promise<string> =>
        new Promise((resolve) => {
          const q = http.request({ host: "127.0.0.1", port: w.proxy.port, path: "/left-pad", agent }, (res) => {
            res.resume();
            res.on("end", () => resolve(`${res.statusCode}:${q.socket?.localPort}`));
          });
          q.on("error", (e: NodeJS.ErrnoException) => resolve(`ERR ${e.code}`));
          q.end();
        });
      await Promise.all(
        [1900, 2300, 3000, 5000, 10_000].map(async (gap) => {
          const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
          const first = await req(agent);
          await sleep(gap);
          const second = await req(agent);
          results.push(`${gap}: ${first} -> ${second}`);
          agent.destroy();
          assert.ok(first.startsWith("200:") && second.startsWith("200:"), `${gap} ms gap: ${first} -> ${second}`);
          assert.equal(first, second, `${gap} ms gap: the pooled socket was reused (same local port)`);
        }),
      );
      assert.equal(results.length, 5);
      const ka = await new Promise<string | undefined>((resolve) => {
        http.get({ host: "127.0.0.1", port: w.proxy.port, path: "/left-pad", agent: new http.Agent({ keepAlive: true }) }, (res) => {
          res.resume();
          resolve(String(res.headers["keep-alive"]));
        });
      });
      assert.match(String(ka), /timeout=65/);
    } finally {
      await w.close();
    }
  });
});

test("statusOf helper sanity (keeps the import used)", () => assert.equal(statusOf("HTTP/1.1 204 x"), 204));

describe("D3: new limits are validated", () => {
  const base = { registries: [{ id: "main", upstream: "https://registry.example.com" }], dns: ["127.0.0.1"] };
  test("ranges and types", async () => {
    const { parseConfig } = await import("../../src/sandbox/registry-proxy/config.js");
    const ok = parseConfig({ ...base, limits: { maxQueued: 0, queueWaitMs: 1, maxTunnels: 1, maxConnections: 1, maxConnectionsPerSource: 1, keepAliveTimeoutMs: 1000, maxPackumentBytes: 1024 } });
    assert.equal(ok.limits.maxQueued, 0);
    for (const bad of [{ maxQueued: -1 }, { queueWaitMs: 0 }, { maxTunnels: 0 }, { maxConnections: 0 }, { maxConnectionsPerSource: 70_000 }, { keepAliveTimeoutMs: 10 }, { maxPackumentBytes: 10 }, { maxQueued: 1.5 }, { maxConcurrent: "128" }]) {
      assert.throws(() => parseConfig({ ...base, limits: bad }), /config\.limits\./, JSON.stringify(bad));
    }
    assert.equal(parseConfig(base).limits.maxConcurrent, 128);
  });
});
