import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { parseConfig } from "../../src/sandbox/registry-proxy/config.js";
import { startRegistryProxy, type RegistryProxy } from "../../src/sandbox/registry-proxy/server.js";
import { findCredentialLeaks, findConfiguredSecretsInProcess, READY_PREFIX, runSidecar, type SidecarIo } from "../../src/sandbox/registry-proxy/sidecar.js";
import { CANARY, PUBLIC_RESOLVER, get, raw, statusOf } from "./fixtures.js";

interface Tunnel {
  proxy: RegistryProxy;
  echoed: Buffer[];
  echoPort: number;
  close(): Promise<void>;
}

async function startTunnelWorld(limits: Record<string, number> = {}): Promise<Tunnel> {
  const echoed: Buffer[] = [];
  const conns = new Set<net.Socket>();
  const echo = net.createServer((s) => {
    conns.add(s);
    s.on("data", (d: Buffer) => {
      echoed.push(d);
      s.write(d);
    });
    s.on("error", () => undefined);
    s.on("close", () => conns.delete(s));
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const cfg = parseConfig({
    registries: [{ id: "main", upstream: "https://registry.test", credential: { type: "bearer", secret: CANARY } }],
    allowHosts: ["bin.test:443", "dead.test:443"],
    packages: { allow: ["left-pad"] },
    dns: ["127.0.0.1"],
    limits: { requestTimeoutMs: 3000, connectTimeoutMs: 500, connectIdleTimeoutMs: 300, ...limits },
  });
  const proxy = await startRegistryProxy(cfg, {
    resolver: PUBLIC_RESOLVER,
    testDial: (l) => (l.hostname === "bin.test" ? { protocol: "http:", hostname: "127.0.0.1", port: echoPort } : l.hostname === "dead.test" ? { protocol: "http:", hostname: "127.0.0.1", port: 1 } : undefined),
  });
  return {
    proxy,
    echoed,
    echoPort,
    async close() {
      await proxy.close();
      conns.forEach((c) => c.destroy());
      await new Promise<void>((r) => echo.close(() => r()));
    },
  };
}

/** Opens a CONNECT tunnel; resolves with the socket and the status line once the proxy answered. */
function tunnel(port: number, target: string): Promise<{ socket: net.Socket; status: number; rest: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nAuthorization: Bearer client\r\nProxy-Authorization: Basic eDp5\r\n\r\n`));
    let buf = "";
    const onData = (d: Buffer): void => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.off("data", onData);
        resolve({ socket, status: statusOf(buf), rest: buf.slice(end + 4) });
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

describe("CONNECT handler", () => {
  test("allowlisted host:port tunnels bytes both ways, is audited, and involves no credentials", async () => {
    const t = await startTunnelWorld();
    try {
      const { socket, status } = await tunnel(t.proxy.port, "bin.test:443");
      assert.equal(status, 200);
      const reply = await new Promise<string>((resolve) => {
        socket.once("data", (d) => resolve(d.toString()));
        socket.write("binary-download-request");
      });
      assert.equal(reply, "binary-download-request");
      assert.equal(Buffer.concat(t.echoed).toString(), "binary-download-request", "tunnel is opaque: nothing added or removed");
      assert.ok(!Buffer.concat(t.echoed).toString().includes(CANARY));
      socket.destroy();
      const e = t.proxy.audit().find((x) => x.class === "connect");
      assert.deepEqual([e?.method, e?.host, e?.status, e?.decision], ["CONNECT", "bin.test:443", 200, "allow"]);
    } finally {
      await t.close();
    }
  });

  test("everything not allowlisted is 403 and never dials", async () => {
    const t = await startTunnelWorld();
    try {
      for (const target of ["evil.test:443", "bin.test:444", "bin.test:22", "registry.test:443", "bin.test.evil.test:443", "127.0.0.1:" + t.echoPort, "localhost:" + t.echoPort]) {
        const res = await tunnel(t.proxy.port, target);
        assert.equal(res.status, 403, target);
        res.socket.destroy();
      }
      for (const bad of ["bin.test", "bin.test:", ":443", "bin.test:99999", "bin.test:443:1", "http://bin.test:443", "bin test:443", "bin.test:443\\x"]) {
        const res = await raw(t.proxy.port, `CONNECT ${bad} HTTP/1.1\r\nHost: x\r\n\r\n`, 500);
        assert.ok([400, 403].includes(statusOf(res)), bad);
      }
      assert.equal(t.echoed.length, 0);
    } finally {
      await t.close();
    }
  });

  test("idle tunnels are closed by the idle timeout", async () => {
    const t = await startTunnelWorld();
    try {
      const { socket } = await tunnel(t.proxy.port, "bin.test:443");
      const closedAfter = await new Promise<number>((resolve) => {
        const s = Date.now();
        socket.on("close", () => resolve(Date.now() - s));
        socket.on("error", () => undefined);
        setTimeout(() => resolve(-1), 3000);
      });
      assert.ok(closedAfter > 0 && closedAfter < 2000, `closed after ${closedAfter}`);
    } finally {
      await t.close();
    }
  });

  test("unreachable target answers 502 and frees its slot", async () => {
    const t = await startTunnelWorld({ maxConcurrent: 1 });
    try {
      const res = await tunnel(t.proxy.port, "dead.test:443");
      assert.equal(res.status, 502);
      res.socket.destroy();
      const ok = await tunnel(t.proxy.port, "bin.test:443");
      assert.equal(ok.status, 200, "slot released after the failed dial");
      ok.socket.destroy();
    } finally {
      await t.close();
    }
  });

  test("optional byte cap tears the tunnel down", async () => {
    const t = await startTunnelWorld({ maxConnectBytes: 100 });
    try {
      const { socket } = await tunnel(t.proxy.port, "bin.test:443");
      const closed = new Promise<boolean>((resolve) => {
        socket.on("close", () => resolve(true));
        socket.on("error", () => undefined);
        setTimeout(() => resolve(false), 2000);
      });
      socket.write(Buffer.alloc(500, 1));
      assert.equal(await closed, true);
    } finally {
      await t.close();
    }
  });

  test("CONNECT tunnels are NOT counted against the request gate; they have their own cap (maxTunnels)", async () => {
    const t = await startTunnelWorld({ maxConcurrent: 1, maxTunnels: 2, connectIdleTimeoutMs: 5000 });
    try {
      const first = await tunnel(t.proxy.port, "bin.test:443");
      const second = await tunnel(t.proxy.port, "bin.test:443");
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      const third = await tunnel(t.proxy.port, "bin.test:443");
      assert.equal(third.status, 503, "tunnel cap");
      assert.equal(t.proxy.audit().at(-1)?.reason, "tunnel-limit");
      // two open tunnels, maxConcurrent 1: a normal request is still served (it reaches the upstream and fails there, not at the gate)
      const r = await get(t.proxy.port, "/left-pad");
      assert.notEqual(r.status, 503, "requests are not starved by tunnels");
      for (const s of [first, second, third]) s.socket.destroy();
    } finally {
      await t.close();
    }
  });
});

const goodBlob = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    registries: [{ id: "main", upstream: "https://registry.example.com", credential: { type: "bearer", secret: CANARY } }],
    packages: { allow: ["left-pad"] },
    dns: ["127.0.0.1"],
    ...extra,
  });

function fakeIo(over: Partial<SidecarIo> & { blob?: string }): SidecarIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    argv: [],
    env: {},
    stdin: Readable.from([Buffer.from(over.blob ?? goodBlob())]),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...over,
    out,
    err,
  };
}

describe("sidecar entrypoint", () => {
  test("credential-like argv and env are detected (names only in messages)", () => {
    assert.deepEqual(findCredentialLeaks([], { PATH: "/usr/bin", NODE_VERSION: "24" }), []);
    const cases: [string[], Record<string, string>, RegExp][] = [
      [["--token", "npm_abcdefghijklmnopqrstuvwxyz0123456789"], {}, /argv\[1\]/],
      [["Bearer abcdefgh12345678"], {}, /argv\[0\]/],
      [["https://user:hunter2@registry.example.com"], {}, /argv\[0\]/],
      [[], { NPM_TOKEN: "x" }, /NPM_TOKEN/],
      [[], { REGISTRY_PASSWORD: "x" }, /REGISTRY_PASSWORD/],
      [[], { NPM_CONFIG__AUTH: "abc" }, /NPM_CONFIG__AUTH/],
      [[], { MY_API_KEY: "x" }, /MY_API_KEY/],
      [[], { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwx" }, /GITHUB_TOKEN/],
      [[], { NOTHING: "ghp_abcdefghijklmnopqrstuvwx" }, /NOTHING/],
      [[], { HEADER: "Authorization: Bearer abcdefgh1234" }, /HEADER/],
    ];
    for (const [argv, env, re] of cases) {
      const found = findCredentialLeaks(argv, env);
      assert.ok(found.length > 0 && found.some((f) => re.test(f)), JSON.stringify([argv, env]));
      assert.ok(!found.join("\n").includes("hunter2") && !found.join("\n").includes("ghp_abc"), "values are never echoed");
    }
  });

  test("the configured secret itself is refused when present in argv/env (innocuous names too)", () => {
    const cfg = parseConfig(JSON.parse(goodBlob()));
    assert.deepEqual(findConfiguredSecretsInProcess(cfg, ["--x"], { A: "b" }), []);
    assert.equal(findConfiguredSecretsInProcess(cfg, [`--opt=${CANARY}`], {}).length, 1);
    assert.equal(findConfiguredSecretsInProcess(cfg, [], { WEIRD_NAME: `pre-${CANARY}-post` }).length, 1);
  });

  test("threat: read the sidecar's memory/env (unit part: refuses to start with credentials in env or argv, accepts them on stdin only)", async () => {
    for (const io of [fakeIo({ env: { NPM_TOKEN: "x" } }), fakeIo({ argv: ["--token=npm_abcdefghijklmnopqrstuvwxyz0123"] }), fakeIo({ env: { INNOCUOUS: CANARY } })]) {
      const r = await runSidecar(io);
      assert.deepEqual(r, { ok: false, exitCode: 2 });
      assert.equal(io.out.length, 0, "no ready line");
      assert.ok(!io.err.join("\n").includes(CANARY));
    }
    const ok = fakeIo({});
    const r = await runSidecar(ok);
    assert.ok(r.ok);
    if (r.ok) await r.proxy.close();
  });

  test("starts, prints exactly one ready line with the port, and never logs the blob", async () => {
    const io = fakeIo({});
    const r = await runSidecar(io);
    assert.ok(r.ok);
    if (!r.ok) return;
    try {
      assert.equal(io.out.length, 1);
      assert.equal(io.out[0], `${READY_PREFIX} port=${r.proxy.port}`);
      assert.equal((await get(r.proxy.port, "/lodash")).status, 403);
      assert.ok(io.err.length >= 1, "audit lines go to stderr");
      assert.ok(!io.out.concat(io.err).join("\n").includes(CANARY));
    } finally {
      await r.proxy.close();
    }
  });

  test("invalid stdin: generic message, no echo of input, exit code 2", async () => {
    for (const blob of ["not json " + CANARY, "{", "[]", goodBlob({ evil: CANARY }), JSON.stringify({ registries: [{ id: "a", upstream: `http://${CANARY}.example.com` }], dns: ["1.1.1.1"] })]) {
      const io = fakeIo({ blob });
      assert.deepEqual(await runSidecar(io), { ok: false, exitCode: 2 });
      assert.ok(!io.err.join("\n").includes(CANARY), blob);
      assert.equal(io.out.length, 0);
    }
  });

  test("oversized stdin is refused", async () => {
    const io = fakeIo({ stdin: Readable.from([Buffer.alloc(5 * 1024 * 1024, 32)]) });
    assert.deepEqual(await runSidecar(io), { ok: false, exitCode: 2 });
  });

  test("built main.js: reads one JSON blob from stdin, prints one ready line, serves, stops on SIGTERM", async () => {
    const main = fileURLToPath(new URL("../../src/sandbox/registry-proxy/main.js", import.meta.url));
    const env: Record<string, string> = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(process.execPath, [main], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end(goodBlob({ listen: { host: "127.0.0.1", port: 0 } }));
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ready line; stderr=${err}`)), 10_000);
      const check = (): void => {
        const m = new RegExp(`^${READY_PREFIX} port=(\\d+)$`, "m").exec(out);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      };
      child.stdout.on("data", check);
      child.on("exit", (c) => reject(new Error(`exited ${c}: ${err}`)));
    });
    try {
      assert.equal(out.trim().split("\n").length, 1);
      assert.equal((await get(port, "/lodash")).status, 403);
      assert.equal((await get(port, "/left-pad", {}, "DELETE")).status, 405);
      assert.ok(!(out + err).includes(CANARY));
    } finally {
      child.kill();
    }
  });

  test("built main.js refuses a credential in its environment (exit 2, nothing on stdout)", async () => {
    const main = fileURLToPath(new URL("../../src/sandbox/registry-proxy/main.js", import.meta.url));
    const env: Record<string, string> = { NPM_TOKEN: "abc", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    const child = spawn(process.execPath, [main], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end(goodBlob());
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 2);
    assert.equal(out, "");
    assert.match(err, /NPM_TOKEN/);
    assert.ok(!err.includes(CANARY));
  });
});
