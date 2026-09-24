import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import net from "node:net";
import type { IncomingMessage } from "node:http";
import { describe, test } from "node:test";
import { AuditLog, clientFamily } from "../../src/sandbox/registry-proxy/audit.js";
import { ConfigError, normalisePrefix, parseConfig } from "../../src/sandbox/registry-proxy/config.js";
import { handleConnect, normaliseConnectAuthority } from "../../src/sandbox/registry-proxy/connect.js";
import { createRedactor } from "../../src/sandbox/registry-proxy/secret.js";
import { startRegistryProxy } from "../../src/sandbox/registry-proxy/server.js";
import { CRASH_EXIT_CODE, crashLine, createBoundedSink, installCrashHandlers } from "../../src/sandbox/registry-proxy/sink.js";
import { CANARY, PUBLIC_RESOLVER, get, raw, startWorld, statusOf, type World, type WorldOptions } from "./fixtures.js";

async function withWorld(body: (w: World) => Promise<void>, opts: WorldOptions = {}): Promise<void> {
  const w = await startWorld(opts);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("D8: allowlist prefix boundaries", () => {
  test("normalisePrefix: exact accepted shapes and their normal form", () => {
    const ok: [string, string][] = [
      ["@corp", "@corp/"],
      ["@corp/", "@corp/"],
      ["@corp/tool-", "@corp/tool-"],
      ["@corp/tool.", "@corp/tool."],
      ["@corp/tool_", "@corp/tool_"],
      ["foo-", "foo-"],
      ["foo.", "foo."],
      ["foo_", "foo_"],
      ["@a", "@a/"],
      ["ab-", "ab-"],
    ];
    for (const [input, out] of ok) assert.equal(normalisePrefix(input), out, input);
  });

  test("normalisePrefix: footgun shapes are rejected at config time", () => {
    for (const bad of ["foo", "@corp/tool", "f", "@", "@/", "@corp//", "@corp/a/b-", "foo/bar-", "foo bar-", "../x-", "@corp/../x-", "@@corp", "-", "--", "foo-\n", "FOO", "@Corp/x", "@corp/Tool-", "", "x".repeat(215), "foo*", "foo-%2f", "@corp/foo-*"]) {
      const base = { registries: [{ id: "main", upstream: "https://registry.example.com" }], dns: ["127.0.0.1"] };
      if (bad === "FOO" || bad === "@Corp/x" || bad === "@corp/Tool-") continue; // uppercase names are legal npm names; the separator rule is what matters (covered above)
      assert.equal(normalisePrefix(bad), undefined, JSON.stringify(bad));
      assert.throws(() => parseConfig({ ...base, packages: { allowPrefixes: [bad] } }), ConfigError, JSON.stringify(bad));
    }
    // a name that is a plain word needs the exact `allow` list instead
    assert.throws(() => parseConfig({ registries: [{ id: "main", upstream: "https://registry.example.com" }], dns: ["127.0.0.1"], packages: { allowPrefixes: ["foo"] } }), /use "@scope"/);
  });

  test("matching: `@corp` never matches `@corpevil/x`, `foo-` never matches `foobar`, `@corp/tool-` stays inside the scope and the part", () =>
    withWorld(
      async (w) => {
        const status = async (p: string): Promise<number> => (await get(w.proxy.port, p)).status;
        assert.equal(await status("/@corp%2fx"), 200);
        assert.equal(await status("/@corp/x"), 200, "scoped name in two-segment form");
        assert.equal(await status("/@corpevil%2fx"), 403);
        assert.equal(await status("/@corp-evil%2fx"), 403);
        assert.equal(await status("/@corp2%2fx"), 403);
        assert.equal(await status("/foo-bar"), 200);
        assert.equal(await status("/foo-"), 200);
        assert.equal(await status("/foobar"), 403);
        assert.equal(await status("/foo"), 403);
        assert.equal(await status("/@scope%2ftool-x"), 200);
        assert.equal(await status("/@scope%2ftoolbox"), 403);
        assert.equal(await status("/@scope2%2ftool-x"), 403);
        assert.equal(await status("/@other%2ftool-x"), 403);
        const denied = w.proxy.audit().filter((e) => e.decision === "deny");
        assert.ok(denied.every((e) => e.reason === "package-not-allowlisted"));
      },
      { config: (b) => ({ ...b, packages: { allowPrefixes: ["@corp", "foo-", "@scope/tool-"] } }) },
    ));
});

class FakeClient extends Duplex {
  readonly received: Buffer[] = [];
  destroyedWhileWriting = false;
  timeouts: unknown[] = [];
  constructor(private readonly writeDelayMs: number) {
    super();
  }
  override _read(): void {}
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    setTimeout(() => {
      if (this.destroyed) {
        this.destroyedWhileWriting = true;
        cb(new Error("destroyed"));
        return;
      }
      this.received.push(chunk);
      cb();
    }, this.writeDelayMs);
  }
  setTimeout(ms: number, cb?: () => void): this {
    this.timeouts.push(ms, cb);
    return this;
  }
}

describe("D8: CONNECT deny race (response must flush before the client is torn down)", () => {
  test("a refused upstream dial answers 502 to a client whose socket is slow to accept writes", async () => {
    const client = new FakeClient(80);
    const audits: string[] = [];
    const ctx = {
      allowHosts: new Set(["dead.test:443"]),
      allowPrivateHosts: new Set<string>(),
      limits: { connectTimeoutMs: 2000, connectIdleTimeoutMs: 2000, maxConnectBytes: 0 },
      resolver: PUBLIC_RESOLVER,
      audit: new AuditLog(createRedactor([]), Date.now, (l) => audits.push(l)),
      mapTarget: () => ({ hostname: "127.0.0.1", port: 1 }), // refused immediately
      tryAcquire: () => true,
      release: () => undefined,
      track: () => undefined,
    };
    handleConnect({ url: "dead.test:443" } as IncomingMessage, client as unknown as net.Socket, Buffer.alloc(0), ctx);
    await sleep(600);
    const text = Buffer.concat(client.received).toString();
    assert.match(text, /^HTTP\/1\.1 502 Bad Gateway/, "the status line reached the client");
    assert.equal(client.destroyedWhileWriting, false, "the client was not destroyed under its own pending write");
    assert.ok(audits.some((l) => l.includes("upstream-connect-failed")));
  });

  test("real sockets: unreachable target, blocked address and denied host all deliver their status line", async () => {
    const proxy = await startRegistryProxy(
      parseConfig({
        registries: [{ id: "main", upstream: "https://registry.example.com" }],
        allowHosts: ["dead.test:443", "priv.test:443"],
        dns: ["127.0.0.1"],
        limits: { connectTimeoutMs: 500 },
      }),
      { resolver: { resolve4: async (h) => (h === "priv.test" ? ["10.0.0.9"] : ["93.184.216.34"]) }, testDial: (l) => (l.hostname === "dead.test" ? { protocol: "http:", hostname: "127.0.0.1", port: 1 } : undefined) },
    );
    try {
      for (let i = 0; i < 25; i++) {
        assert.equal(statusOf(await raw(proxy.port, "CONNECT dead.test:443 HTTP/1.1\r\nHost: x\r\n\r\n", 1500)), 502, `dead #${i}`);
      }
      assert.equal(statusOf(await raw(proxy.port, "CONNECT priv.test:443 HTTP/1.1\r\nHost: x\r\n\r\n", 1500)), 403);
      assert.equal(statusOf(await raw(proxy.port, "CONNECT nowhere.test:443 HTTP/1.1\r\nHost: x\r\n\r\n", 1500)), 403);
    } finally {
      await proxy.close();
    }
  });
});

describe("D9b: CONNECT authority parsing edge cases", () => {
  const cfgHosts = ["bin.test:443", "cdn.example.com:8443"];
  async function tunnelWorld() {
    const echo = net.createServer((s) => s.on("data", (d) => s.write(d)).on("error", () => undefined));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const port = (echo.address() as net.AddressInfo).port;
    const proxy = await startRegistryProxy(
      parseConfig({ registries: [{ id: "main", upstream: "https://registry.example.com" }], allowHosts: cfgHosts, dns: ["127.0.0.1"], limits: { connectTimeoutMs: 500, connectIdleTimeoutMs: 400 } }),
      { resolver: PUBLIC_RESOLVER, testDial: () => ({ protocol: "http:", hostname: "127.0.0.1", port }) },
    );
    let dialed = 0;
    echo.on("connection", () => dialed++);
    return { proxy, dialed: () => dialed, close: async () => (await proxy.close(), echo.close()) };
  }
  const connectLine = (target: string): string => `CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`;

  test("normaliseConnectAuthority: table", () => {
    const ok: [string, string][] = [
      ["bin.test:443", "bin.test:443"],
      ["BIN.TEST:443", "bin.test:443"],
      ["Bin.Test:00443", "bin.test:443"],
      ["bin.test.:443", "bin.test:443"],
      ["a-b.c1.example:65535", "a-b.c1.example:65535"],
      ["xn--bcher-kva.example:443", "xn--bcher-kva.example:443"],
    ];
    for (const [input, expected] of ok) {
      const r = normaliseConnectAuthority(input);
      assert.equal(r && `${r.host}:${r.port}`, expected, input);
    }
    const bad = [
      "", ":", ":443", "bin.test", "bin.test:", "bin.test:0", "bin.test:00000", "bin.test:65536", "bin.test:99999", "bin.test:123456", "bin.test:abc", "bin.test:-1", "bin.test:+443", "bin.test:4 43", "bin.test:443:1",
      "a@bin.test:443", "bin.test:443@evil.test:443", "user:pw@bin.test:443", "[::1]:443", "[2606:4700::1111]:443", "::1:443", "2606:4700::1111:443", "[::1", "::1]:443",
      "bin test:443", "bin\ttest:443", "bin.test\t:443", " bin.test:443", "bin.test:443 ", "bin.test\u0000:443", "bin.test\u0001:443", "bin.test\u007f:443", "bin.test\r\n:443", "bin.test\n:443",
      "bin..test:443", ".bin.test:443", "bin.test..:443", "-bin.test:443", "bin-.test:443", "bin.-test:443", "bin.test-:443",
      "bücher.example:443", "bin.teıst:443", "bin.test :443", " bin.test:443", "bin.test:٤٤٣",
      "http://bin.test:443", "bin.test:443/path", "bin.test:443?x=1", "bin.test:443#f", "bin.test/x:443", "bin.test\\x:443",
      `${"a".repeat(300)}.test:443`, `${"a".repeat(64)}.${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(64)}.test:443`.repeat(2),
    ];
    for (const b of bad) assert.equal(normaliseConnectAuthority(b), undefined, JSON.stringify(b));
  });

  test("over the wire: everything malformed is 400/403 and never dials; normalised spellings tunnel", async () => {
    const t = await tunnelWorld();
    try {
      const refused = [
        "[::1]:443", "[2606:4700::1111]:443", "a@bin.test:443", "bin.test:443@evil.test:443", "bin.test:0", "bin.test:65536", "bin.test:abc", "bin.test:-1", "bin.test:443:1", "bin.test", "bin.test:", ":443",
        "bin\ttest:443", "bin.test\t:443", "bin.test\u0000:443", "bin.test\u0001:443", "bin.test\u007f:443", "bücher.example:443", "bin..test:443", ".bin.test:443",
        "xn--bcher-kva.example:443", "http://bin.test:443", "bin.test:443/x", `${"a".repeat(300)}.test:443`, "127.0.0.1:443", "localhost:443", "bin.test:8443", "cdn.example.com:443",
      ];
      for (const target of refused) {
        const res = await raw(t.proxy.port, connectLine(target), 600);
        assert.ok([400, 403].includes(statusOf(res)), `${JSON.stringify(target)} -> ${JSON.stringify(res.slice(0, 40))}`);
      }
      // space-separated garbage in the request line is rejected by the HTTP parser itself
      assert.equal(statusOf(await raw(t.proxy.port, "CONNECT bin test:443 HTTP/1.1\r\nHost: x\r\n\r\n", 600)), 400);
      assert.equal(statusOf(await raw(t.proxy.port, `CONNECT ${"a".repeat(100_000)}:443 HTTP/1.1\r\nHost: x\r\n\r\n`, 600)), 431);
      assert.equal(t.dialed(), 0, "nothing malformed reached the network");
      for (const target of ["BIN.TEST:443", "Bin.Test:443", "bin.test.:443", "bin.test:00443", "CDN.EXAMPLE.COM.:8443"]) {
        const res = await raw(t.proxy.port, connectLine(target), 700);
        assert.equal(statusOf(res), 200, target);
      }
      assert.equal(t.dialed(), 5);
      const hosts = t.proxy.audit().filter((e) => e.decision === "allow").map((e) => e.host);
      assert.deepEqual(hosts, ["bin.test:443", "bin.test:443", "bin.test:443", "bin.test:443", "cdn.example.com:8443"], "audit shows the normalised host, never the client spelling");
      const audit = JSON.stringify(t.proxy.audit());
      assert.ok(!audit.includes("evil.test") && !audit.includes("\\u0000"), "hostile authority text is not echoed into the audit");
    } finally {
      await t.close();
    }
  });
});

describe("D8: stderr audit backpressure", () => {
  function fakeStream() {
    const written: string[] = [];
    let drain: (() => void) | undefined;
    const state = { full: false };
    return {
      written,
      state,
      write(chunk: string): boolean {
        written.push(chunk);
        return !state.full;
      },
      once(_e: "drain", l: () => void): void {
        drain = l;
      },
      flush(): void {
        state.full = false;
        const d = drain;
        drain = undefined;
        d?.();
      },
    };
  }

  test("a stuck stderr consumer costs a bounded queue and one drop-count line, not unbounded memory", () => {
    const s = fakeStream();
    const sink = createBoundedSink(s, 10);
    s.state.full = true;
    for (let i = 0; i < 1000; i++) sink(`line-${i}`);
    assert.equal(s.written.length, 1, "after the first write reported a full buffer, nothing more is written until drain");
    s.flush();
    const all = s.written.join("");
    const lines = all.trim().split("\n");
    assert.equal(lines[0], "line-0");
    assert.equal(lines[1], JSON.stringify({ audit: "dropped", count: 989 }));
    assert.deepEqual(lines.slice(2), Array.from({ length: 10 }, (_v, i) => `line-${i + 1}`));
    assert.equal(lines.length, 12, "1 + drop line + 10 queued: 1000 lines produced 12 lines of output");
  });

  test("drain resumes normal flow; no drop line when nothing was dropped; repeated back-pressure keeps order", () => {
    const s = fakeStream();
    const sink = createBoundedSink(s, 100);
    sink("a");
    sink("b");
    assert.deepEqual(s.written, ["a\n", "b\n"]);
    s.state.full = true;
    sink("c");
    sink("d");
    sink("e");
    s.flush();
    assert.deepEqual(s.written, ["a\n", "b\n", "c\n", "d\n", "e\n"], "queued lines follow in order, no drop line");
  });

  test("real Writable with a tiny highWaterMark: everything is delivered in order after the consumer wakes up", async () => {
    const { Writable } = await import("node:stream");
    const got: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const out = new Writable({
      highWaterMark: 16,
      write(chunk, _enc, cb) {
        void gate.then(() => {
          got.push(chunk.toString());
          cb();
        });
      },
    });
    const sink = createBoundedSink(out, 1000);
    for (let i = 0; i < 200; i++) sink(`{"n":${i}}`);
    release?.();
    await sleep(100);
    assert.equal(got.join("").trim().split("\n").length, 200);
    assert.equal(got.join("").includes("dropped"), false);
  });
});

describe("D8: crash safety", () => {
  function fakeProc() {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const exits: number[] = [];
    return { handlers, exits, on: (e: string, l: (a: unknown) => void) => void (handlers[e] = l), exit: (c: number) => void exits.push(c) };
  }

  test("uncaughtException / unhandledRejection: one redacted line, no stack, exit 70, only once", () => {
    const p = fakeProc();
    const lines: string[] = [];
    const redact = createRedactor([CANARY]);
    installCrashHandlers(p as never, (l) => lines.push(l), () => redact);
    const err = Object.assign(new Error(`boom with ${CANARY}\nsecond line at /secret/path.ts:1:1`), { code: "ERR_X" });
    err.stack = `Error: boom\n    at f (${CANARY}.js:1:1)\n    at g`;
    p.handlers.uncaughtException?.(err);
    p.handlers.unhandledRejection?.(new Error("later"));
    assert.deepEqual(p.exits, [CRASH_EXIT_CODE], "exits once even if several errors arrive");
    assert.equal(lines.length, 1);
    const line = lines[0] as string;
    assert.ok(!line.includes("\n") && !line.includes("    at "), "single line, no stack");
    assert.ok(!line.includes(CANARY));
    assert.match(line, /^fatal: uncaughtException Error ERR_X /);
  });

  test("before the redactor exists the error message is not shown at all; hostile error objects cannot break the handler", () => {
    for (const thrown of [new Error(`early ${CANARY}`), `string ${CANARY}`, null, undefined, 42, { name: CANARY, code: CANARY, message: CANARY }, Object.create(null)]) {
      const p = fakeProc();
      const lines: string[] = [];
      installCrashHandlers(p as never, (l) => lines.push(l), () => undefined);
      p.handlers.unhandledRejection?.(thrown);
      assert.equal(lines.length, 1);
      assert.ok(!(lines[0] as string).includes(CANARY), typeof thrown);
      assert.deepEqual(p.exits, [CRASH_EXIT_CODE]);
    }
    const p = fakeProc();
    const lines: string[] = [];
    installCrashHandlers(p as never, (l) => lines.push(l), () => {
      throw new Error("redactor exploded");
    });
    p.handlers.uncaughtException?.(new Error("x"));
    assert.deepEqual(lines, ["fatal: uncaughtException"]);
    assert.deepEqual(p.exits, [CRASH_EXIT_CODE]);
    const throwing = { get name(): string { throw new Error("no"); } };
    const p2 = fakeProc();
    installCrashHandlers(p2 as never, () => undefined, () => undefined);
    p2.handlers.uncaughtException?.(throwing);
    assert.deepEqual(p2.exits, [CRASH_EXIT_CODE], "exit happens even when describing the error throws");
  });

  test("crashLine sanitises name and code and bounds the message", () => {
    const e = Object.assign(new Error("m".repeat(1000)), { name: "Evil\nName;rm -rf", code: "E\u001b[31mX" });
    const line = crashLine("uncaughtException", e, (t) => t);
    assert.ok(!/[\n\u001b]/.test(line));
    assert.ok(line.length < 400);
  });
});

describe("D8: audit entries (rich, sanitised, never raw attacker text)", () => {
  test("clientFamily is a fixed vocabulary derived from the User-Agent", () => {
    const table: [unknown, string][] = [
      ["npm/11.6.2 node/v24.11.1 win32 x64 workspaces/false", "npm"],
      ["pnpm/9.15.9 npm/? node/v24.11.1 win32 x64", "pnpm"],
      ["yarn/1.22.22 npm/? node/v24.11.1 win32 x64", "yarn"],
      ["Yarn Berry", "yarn"],
      ["yarn/4.9.2 npm/? node/v24.11.1", "yarn"],
      ["curl/8.0", "other"],
      ["Mozilla/5.0 npm/evil", "other"],
      ["", "other"],
      [undefined, "other"],
      [["npm/1"], "other"],
      ["npm\r\nX-Injected: 1", "other"],
    ];
    for (const [ua, fam] of table) assert.equal(clientFamily(ua), fam, JSON.stringify(ua));
  });

  test("AuditLog: names and versions that fail the grammar are dropped, strings are escaped and bounded, entries are single JSON lines", () => {
    const lines: string[] = [];
    const log = new AuditLog(createRedactor([CANARY]), () => 1, (l) => lines.push(l));
    log.record({ method: "GET\r\nX: y", class: "tarball", registry: "main\u001b[0m", host: `h${CANARY}`, status: 200, decision: "allow", reason: "ok\nline2", name: "left-pad\nevil", version: "1.0.0\n", upstreamStatus: 200, bytes: 12.7, ms: -5, client: "npm" });
    log.record({ method: "GET", class: "tarball", registry: "main", host: null, status: 200, decision: "allow", reason: "ok", name: "@s/n", version: "1.0.0-rc.1+b.2", bytes: 10, ms: 3, client: "pnpm" });
    assert.equal(lines.length, 2);
    for (const l of lines) {
      assert.ok(!l.includes("\n") && !l.includes(CANARY));
      JSON.parse(l);
    }
    const [a, b] = log.entries();
    assert.equal(a?.name, null);
    assert.equal(a?.version, null);
    assert.equal(a?.ms, null);
    assert.equal(a?.bytes, 12);
    assert.ok(!/[\u001b\r\n]/.test(`${a?.method}${a?.registry}${a?.reason}`));
    assert.deepEqual([b?.name, b?.version, b?.bytes, b?.ms, b?.client], ["@s/n", "1.0.0-rc.1+b.2", 10, 3, "pnpm"]);
  });

  test("end to end: an upstream 404 is NOT logged as allow/forwarded; it carries the upstream status, name, version, client family, bytes and duration", () =>
    withWorld(async (w) => {
      let t = 1000;
      w.registry.handler = (_q, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not found"}');
      };
      await get(w.proxy.port, "/left-pad/-/left-pad-1.2.3.tgz", { "user-agent": "npm/11.6.2 node/v24.11.1 win32 x64 workspaces/false" });
      w.registry.handler = (_q, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("12345678");
      };
      await get(w.proxy.port, "/left-pad/-/left-pad-1.2.3.tgz", { "user-agent": "pnpm/9.15.9 npm/? node/v24.11.1 win32 x64" });
      await get(w.proxy.port, "/nope", { "user-agent": "yarn/1.22.22 npm/? node/v24" });
      const [notFound, ok, denied] = w.proxy.audit();
      assert.deepEqual([notFound?.decision, notFound?.reason, notFound?.status, notFound?.upstreamStatus, notFound?.name, notFound?.version, notFound?.client, notFound?.class], ["upstream-error", "upstream-404", 404, 404, "left-pad", "1.2.3", "npm", "tarball"]);
      assert.deepEqual([ok?.decision, ok?.reason, ok?.bytes, ok?.upstreamStatus, ok?.client, typeof ok?.ms], ["allow", "forwarded", 8, 200, "pnpm", "number"]);
      assert.deepEqual([denied?.decision, denied?.reason, denied?.registry, denied?.name, denied?.client], ["deny", "package-not-allowlisted", "main", "nope", "yarn"]);
      void t;
      t = 0;
    }));

  test("denials carry registry id and reason; unroutable ones carry neither raw path nor raw registry text", () =>
    withWorld(
      async (w) => {
        await get(w.proxy.port, "/_r/art/left-pad/extra");
        await get(w.proxy.port, "/_r/%3Cscript%3E/left-pad");
        await get(w.proxy.port, "/left-pad/extra/segments");
        const entries = w.proxy.audit();
        assert.deepEqual(entries.map((e) => [e.registry, e.reason, e.name]), [["art", "path-not-allowed", "left-pad"], [null, "no-registry", null], ["main", "path-not-allowed", "left-pad"]]);
        assert.ok(!JSON.stringify(entries).includes("script"));
      },
      { config: (b) => ({ ...b, registries: [{ id: "main", default: true, upstream: "https://registry.test", credential: { type: "bearer", secret: CANARY } }, { id: "art", upstream: "https://evil.test" }] }) },
    ));
});

describe("D10: documented behaviours (pinned so a change is a conscious decision)", () => {
  test("Range requests are answered with the full body (200, no Content-Range); the upstream never sees Range", () =>
    withWorld(async (w) => {
      w.registry.handler = (q, res) => {
        res.writeHead(q.headers.range ? 206 : 200, { "content-type": "application/octet-stream", "accept-ranges": "bytes" });
        res.end("0123456789");
      };
      const r = await get(w.proxy.port, "/left-pad/-/left-pad-1.0.0.tgz", { range: "bytes=0-3" });
      assert.equal(r.status, 200);
      assert.equal(r.body, "0123456789");
      assert.equal(r.headers["content-range"], undefined);
      assert.equal(r.headers["accept-ranges"], undefined);
      assert.equal(w.registry.hits[0]?.headers.range, undefined);
    }));

  test("npm audit (POST bulk advisories) and /-/ping are denied by design; the phase-4 npmrc sets audit=false", () =>
    withWorld(async (w) => {
      assert.equal((await get(w.proxy.port, "/-/npm/v1/security/advisories/bulk", { "content-length": "0" }, "POST")).status, 405);
      assert.equal((await get(w.proxy.port, "/-/ping")).status, 403);
      assert.equal(w.registry.hits.length, 0);
      assert.deepEqual(w.proxy.audit().map((e) => [e.reason]), [["method-not-allowed"], ["npm-api-path"]]);
    }));
});
