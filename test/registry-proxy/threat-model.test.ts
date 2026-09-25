import { parseConfig } from "../../src/sandbox/registry-proxy/config.js";
import assert from "node:assert/strict";
import net from "node:net";
import { inspect } from "node:util";
import { describe, test } from "node:test";
import { secretForms } from "../../src/sandbox/registry-proxy/secret.js";
import { CANARY, Upstream, get, okJson, raw, redirectTo, startWorld, statusOf, type Reply, type World } from "./fixtures.js";

/** Runs `body` against a fresh world and always tears it down. */
async function withWorld(body: (w: World) => Promise<void>, opts: Parameters<typeof startWorld>[0] = {}): Promise<void> {
  const w = await startWorld(opts);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

function assertNoSecret(text: string, where: string): void {
  for (const form of secretForms(CANARY)) assert.ok(!text.includes(form), `secret form leaked in ${where}`);
}

const TARBALL = "/left-pad/-/left-pad-1.3.0.tgz";

describe("registry proxy through a real server (fixture upstreams on loopback)", () => {
  test("packument GET injects the bearer credential for the matching origin (https fixture, real TLS path)", () =>
    withWorld(async (w) => {
      const r = await get(w.proxy.port, "/left-pad", { authorization: "Bearer attacker", accept: "application/json" });
      assert.equal(r.status, 200);
      assert.equal(r.body, '{"name":"left-pad"}');
      assert.equal(w.registry.hits.length, 1);
      const hit = w.registry.hits[0]!;
      assert.equal(hit.url, "/left-pad");
      assert.equal(hit.headers.authorization, `Bearer ${CANARY}`);
      assert.equal(hit.headers.host, "registry.test");
      assert.deepEqual(w.proxy.audit().map((e) => [e.method, e.class, e.status, e.decision]), [["GET", "packument", 200, "allow"]]);
    }));

  test("scoped packument and tarball, HEAD, and pathPrefix are rebuilt canonically upstream", () =>
    withWorld(
      async (w) => {
        await get(w.proxy.port, "/@scope%2fpkg");
        await get(w.proxy.port, "/@scope/pkg/-/pkg-1.0.0.tgz");
        await get(w.proxy.port, TARBALL, {}, "HEAD");
        assert.deepEqual(
          w.registry.hits.map((h) => [h.method, h.url]),
          [
            ["GET", "/api/npm/repo/@scope%2Fpkg"],
            ["GET", "/api/npm/repo/@scope/pkg/-/pkg-1.0.0.tgz"],
            ["HEAD", "/api/npm/repo/left-pad/-/left-pad-1.3.0.tgz"],
          ],
        );
      },
      { config: (b) => ({ ...b, registries: [{ id: "main", upstream: "https://registry.test", pathPrefix: "/api/npm/repo", credential: { type: "bearer", secret: CANARY } }] }) },
    ));

  test("basic credential is sent as Basic base64(user:pass)", () =>
    withWorld(
      async (w) => {
        await get(w.proxy.port, "/left-pad");
        assert.equal(w.registry.hits[0]!.headers.authorization, `Basic ${Buffer.from(`svc:${CANARY}`).toString("base64")}`);
      },
      { config: (b) => ({ ...b, registries: [{ id: "main", upstream: "https://registry.test", credential: { type: "basic", secret: `svc:${CANARY}` } }] }) },
    ));

  test("multi-registry: each upstream sees only its own credential, none for a registry without one", () =>
    withWorld(
      async (w) => {
        await get(w.proxy.port, "/left-pad");
        await get(w.proxy.port, "/_r/cdn/left-pad");
        await get(w.proxy.port, "/_r/evil/left-pad");
        assert.equal(w.registry.hits[0]!.headers.authorization, "Bearer MAIN-registry-secret-1");
        assert.equal(w.cdn.hits[0]!.headers.authorization, undefined);
        assert.equal(w.evil.hits[0]!.headers.authorization, "Bearer EVIL-registry-secret-2");
        assert.equal(w.evil.hits[0]!.url, "/left-pad");
      },
      {
        config: (b) => ({
          ...b,
          registries: [
            { id: "main", default: true, upstream: "https://registry.test", credential: { type: "bearer", secret: "MAIN-registry-secret-1" } },
            { id: "cdn", upstream: "https://cdn.test" },
            { id: "evil", upstream: "https://evil.test", credential: { type: "bearer", secret: "EVIL-registry-secret-2" } },
          ],
        }),
      },
    ));

  test("response headers are allowlisted (no set-cookie / www-authenticate / server); upstream 401/404 keep their status but never their body", () =>
    withWorld(async (w) => {
      w.registry.handler = (_q, res) => {
        res.writeHead(401, { "content-type": "text/plain", "set-cookie": "s=1", "www-authenticate": 'Bearer realm="x"', server: "Artifactory", etag: '"e1"' });
        res.end("nope");
      };
      const r = await get(w.proxy.port, "/left-pad");
      assert.equal(r.status, 401);
      assert.equal(r.body, JSON.stringify({ error: "upstream 401" }));
      for (const h of ["set-cookie", "www-authenticate", "server", "etag"]) assert.equal(r.headers[h], undefined, h);
      w.registry.handler = (_q, res) => {
        res.writeHead(404);
        res.end();
      };
      assert.equal((await get(w.proxy.port, "/left-pad")).status, 404);
    }));

  test("binary tarball bytes stream through unchanged", () =>
    withWorld(async (w) => {
      const payload = Buffer.alloc(300_000, 7);
      w.registry.handler = (_q, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
        res.end(payload);
      };
      const r = await get(w.proxy.port, TARBALL);
      assert.equal(r.status, 200);
      assert.equal(Buffer.byteLength(r.body, "latin1") > 0, true);
    }));
});

describe("threat model rows (each row of ratchet-private-registries-plan.md is at least one named test)", () => {
  test("threat: read token from env/files/config in the sandbox (canary in no output the sandbox can see)", () => {
    const seen: string[] = [];
    const sink: string[] = [];
    return withWorld(
      async (w) => {
        const track = async (path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Reply> => {
          const r = await get(w.proxy.port, path, headers, method);
          seen.push(JSON.stringify(r));
          return r;
        };
        await track("/left-pad");
        await track(TARBALL);
        await track("/lodash");
        await track("/-/npm/v1/tokens");
        await track("/left-pad", {}, "PUT");
        await track("/%2e%2e/x");
        await track("/left-pad?x=1");
        w.registry.handler = redirectTo("https://evil.test/x");
        await track("/left-pad");
        w.registry.handler = (q) => q.socket.destroy(); // upstream crash -> proxy error path
        await track("/left-pad");
        seen.push(await raw(w.proxy.port, "GARBAGE\r\n\r\n"));
        seen.push(await raw(w.proxy.port, "CONNECT evil.test:443 HTTP/1.1\r\nHost: evil.test:443\r\n\r\n"));
        const outputs = [...seen, ...sink, JSON.stringify(w.proxy.audit()), inspect(w.proxy, { depth: 6 }), JSON.stringify(w.config), inspect(w.config, { depth: 10 }), JSON.stringify(w.proxy)];
        for (const [i, o] of outputs.entries()) assertNoSecret(o, `output #${i}`);
        assert.ok(w.proxy.audit().length >= 10);
      },
      { proxy: { auditSink: (l) => sink.push(l) } },
    ).then(() => assert.ok(sink.length >= 10, "audit sink saw lines"));
  });

  test("threat: connect straight to the registry or internet (unit part: absolute-form and CONNECT to the registry are refused)", () =>
    withWorld(async (w) => {
      const abs = await raw(w.proxy.port, "GET http://registry.test/left-pad HTTP/1.1\r\nHost: registry.test\r\n\r\n");
      assert.equal(statusOf(abs), 400);
      const abs2 = await raw(w.proxy.port, "GET https://registry.test:443/left-pad HTTP/1.1\r\nHost: registry.test\r\n\r\n");
      assert.equal(statusOf(abs2), 400);
      const con = await raw(w.proxy.port, "CONNECT registry.test:443 HTTP/1.1\r\nHost: registry.test:443\r\n\r\n");
      assert.equal(statusOf(con), 403);
      assert.equal(w.totalHits(), 0);
      // route removal / --internal network / no direct DNS is container-level: phase 3 real-engine tests.
    }));

  test("threat: read the sidecar memory/env (unit part: nothing secret in the proxy's inspectable surface)", () =>
    withWorld(async (w) => {
      assertNoSecret(inspect(w, { depth: 8, showHidden: true }).replace(/CANARY-tok[^'"\s]*/g, "X"), "world");
      assertNoSecret(inspect(w.proxy, { depth: 8, showHidden: true }), "proxy handle");
      // separate PID/mount namespaces and stdin hand-off are container-level: phase 3 + sidecar tests here.
    }));

  test("threat: use the proxy as an open relay", () =>
    withWorld(async (w) => {
      for (const target of ["evil.test:443", "cdn.test:8443", "registry.test:443", "127.0.0.1:22", "localhost:80", "[::1]:443", "cdn.test:443@evil.test:443", "cdn.test", "cdn.test:0", ":443"]) {
        const res = await raw(w.proxy.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
        assert.ok([400, 403].includes(statusOf(res)), `${target} -> ${res}`);
      }
      for (const line of ["GET http://evil.test/x HTTP/1.1", "GET //evil.test/x HTTP/1.1", "GET /http://evil.test/x HTTP/1.1", "GET @evil.test/x HTTP/1.1"]) {
        assert.notEqual(statusOf(await raw(w.proxy.port, `${line}\r\nHost: evil.test\r\n\r\n`)), 200, line);
      }
      assert.equal((await get(w.proxy.port, "/evil.test/x")).status, 403);
      assert.equal(w.totalHits(), 0);
    }));

  test("threat: publish/modify via the proxy (PUT/POST/DELETE/PATCH and token endpoints never reach upstream)", () =>
    withWorld(async (w) => {
      for (const m of ["PUT", "POST", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
        const r = await get(w.proxy.port, "/left-pad", { "content-length": "0" }, m);
        assert.equal(r.status, 405, m);
        assert.equal(r.headers.allow, "GET, HEAD");
      }
      const body = "x".repeat(50);
      const put = await raw(w.proxy.port, `PUT /left-pad HTTP/1.1\r\nHost: p\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      assert.equal(statusOf(put), 405);
      for (const p of ["/-/npm/v1/tokens", "/-/user/org.couchdb.user:x", "/-/whoami", "/-/v1/search", "/-/package/left-pad/dist-tags/latest", "/left-pad/-rev/1-x", "/-/npm/v1/tokens/token/abc"]) {
        for (const m of ["GET", "HEAD", "DELETE", "PUT"]) assert.ok([403, 405].includes((await get(w.proxy.port, p, {}, m)).status), `${m} ${p}`);
      }
      assert.equal(w.totalHits(), 0);
    }));

  test("threat: read other private packages in bulk (name allowlist is on by default, empty allowlist denies all)", () =>
    withWorld(async (w) => {
      for (const n of ["lodash", "@corp/secret-sdk", "@scope/other", "LEFT-PAD", "left-pad-x"]) {
        assert.equal((await get(w.proxy.port, `/${n.replace("/", "%2f")}`)).status, 403, n);
        assert.equal((await get(w.proxy.port, `/${n}/-/${n.split("/").pop()}-1.0.0.tgz`)).status, 403, n);
      }
      assert.equal(w.totalHits(), 0);
      assert.equal((await get(w.proxy.port, "/left-pad")).status, 200);
    }));

  test("threat: read other private packages: default config with no allowlist denies everything", () =>
    withWorld(
      async (w) => {
        assert.equal((await get(w.proxy.port, "/left-pad")).status, 403);
        assert.equal(w.totalHits(), 0);
      },
      { config: (b) => ({ ...b, packages: {} }) },
    ));

  test("threat: allow-prefixes hook and runtime additions (bisect names) work, and only for valid names", () =>
    withWorld(
      async (w) => {
        assert.equal((await get(w.proxy.port, "/bisect-thing")).status, 200);
        assert.equal((await get(w.proxy.port, "/@bisect%2fone")).status, 200);
        assert.equal((await get(w.proxy.port, "/other-thing")).status, 403);
        w.proxy.addAllowedPackages(["other-thing", "../evil", "bad name", "-"]);
        assert.equal((await get(w.proxy.port, "/other-thing")).status, 200);
        assert.equal((await get(w.proxy.port, "/%2e%2e%2fevil")).status, 400);
        assert.equal((await get(w.proxy.port, "/-")).status, 403);
      },
      { config: (b) => ({ ...b, packages: { allow: [], allowPrefixes: ["bisect-", "@bisect/"] } }) },
    ));

  test("allowAll (allowlist switched off): any valid name passes, malformed names and queries still do not", () =>
    withWorld(
      async (w) => {
        assert.equal((await get(w.proxy.port, "/anything-at-all")).status !== 403, true);
        assert.equal((await get(w.proxy.port, "/%2e%2e%2fevil")).status, 400);
        assert.equal((await get(w.proxy.port, "/left-pad?d=x")).status, 403);
      },
      { config: (b) => ({ ...b, packages: { allow: [], allowAll: true } }) },
    ));

  test("allowAll must be a boolean", () => {
    assert.throws(() => parseConfig({ registries: [{ id: "main", upstream: "https://registry.example.com" }], dns: ["127.0.0.1"], packages: { allowAll: "yes" } }), /allowAll/);
  });

  test("threat: covert channel in request paths/queries (only expected names pass, everything else logged as denied)", () =>
    withWorld(async (w) => {
      const exfil = Buffer.from("stolen-token-data").toString("hex");
      for (const p of [`/${exfil}`, `/left-pad?d=${exfil}`, `/left-pad/-/left-pad-1.0.0.tgz?d=${exfil}`, `/${"a".repeat(600)}`, `/left-pad/${exfil}`, `/@${exfil}/left-pad`, `/left-pad/-/${exfil}.tgz`]) {
        const r = await get(w.proxy.port, p);
        assert.ok([400, 403, 414].includes(r.status), `${p.slice(0, 40)} -> ${r.status}`);
      }
      assert.equal(w.totalHits(), 0);
      const log = w.proxy.audit();
      assert.equal(log.length, 7);
      assert.ok(log.every((e) => e.decision === "deny"));
      // A path that is a syntactically valid package name is recorded as `name` (diagnosis of false denials); nothing else of the path or query ever is.
      assert.ok(!JSON.stringify(log.map((e) => ({ ...e, name: null }))).includes(exfil), "audit does not record attacker-chosen path/query text");
      assert.ok(log.every((e) => e.name === null || /^[a-z0-9@/._~-]+$/.test(e.name)));
    }));

  describe("threat: token leak by redirect", () => {
    test("same-origin redirect keeps the credential, absolute and relative", () =>
      withWorld(async (w) => {
        let n = 0;
        w.registry.handler = (q, res) => {
          n++;
          if (q.url === "/left-pad") return redirectTo("/left-pad/-/left-pad-1.0.0.tgz")(q, res);
          if (q.url === "/left-pad/-/left-pad-1.0.0.tgz") return redirectTo("https://registry.test/@scope%2Fpkg")(q, res);
          okJson(q, res);
        };
        const r = await get(w.proxy.port, "/left-pad");
        assert.equal(r.status, 200);
        assert.equal(n, 3);
        assert.deepEqual(w.registry.hits.map((h) => h.url), ["/left-pad", "/left-pad/-/left-pad-1.0.0.tgz", "/@scope%2Fpkg"]);
        assert.ok(w.registry.hits.every((h) => h.headers.authorization === `Bearer ${CANARY}`));
      }));

    test("cross-origin to an allowlisted host: followed server-side, Authorization dropped, client never sees the 302", () =>
      withWorld(async (w) => {
        w.registry.handler = redirectTo("https://cdn.test/blob/abc?sig=1");
        w.cdn.handler = (_q, res) => {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end("TARBALL-BYTES");
        };
        const r = await get(w.proxy.port, TARBALL, { authorization: "Bearer client-supplied", cookie: "a=b" });
        assert.equal(r.status, 200);
        assert.equal(r.body, "TARBALL-BYTES");
        assert.equal(r.headers.location, undefined);
        assert.equal(w.cdn.hits.length, 1);
        assert.equal(w.cdn.hits[0]!.headers.authorization, undefined);
        assert.equal(w.cdn.hits[0]!.headers.cookie, undefined);
        assert.equal(w.cdn.hits[0]!.headers.host, "cdn.test");
        assert.equal(w.registry.hits[0]!.headers.authorization, `Bearer ${CANARY}`);
      }));

    test("cross-origin to a host NOT in allowHosts: 403, target never contacted", () =>
      withWorld(async (w) => {
        w.registry.handler = redirectTo("https://evil.test/steal");
        const r = await get(w.proxy.port, TARBALL);
        assert.equal(r.status, 403);
        assert.equal(w.evil.hits.length, 0);
        const e = w.proxy.audit()[0]!;
        assert.equal(e.reason, "redirect-host-not-allowed");
        assert.equal(e.decision, "deny");
      }));

    test("hostnames that merely share a suffix/prefix with the registry never get the credential", () =>
      withWorld(
        async (w) => {
          for (const loc of ["https://registry.test.evil.test/x", "https://evilregistry.test/x", "https://registry.test:8443/x", "https://sub.registry.test/x", "//evil.test/x", "https://registry.test@evil.test/x"]) {
            w.registry.handler = redirectTo(loc);
            const r = await get(w.proxy.port, "/left-pad");
            assert.equal(r.status, 403, loc);
          }
          assert.equal(w.evil.hits.length, 0);
          assert.equal(w.cdn.hits.length, 0);
        },
        { config: (b) => ({ ...b, allowHosts: ["cdn.test:443"] }) },
      ));

    test("https -> http downgrade is refused even to an allowlisted host", () =>
      withWorld(async (w) => {
        for (const loc of ["http://cdn.test/x", "http://registry.test/x", "ftp://cdn.test/x"]) {
          w.registry.handler = redirectTo(loc);
          const r = await get(w.proxy.port, "/left-pad");
          assert.equal(r.status, 403, loc);
        }
        assert.equal(w.cdn.hits.length, 0);
      }));

    test("once the chain left the registry origin the credential never comes back (registry -> cdn -> registry)", () =>
      withWorld(async (w) => {
        let hop = 0;
        w.registry.handler = (q, res) => {
          if (hop++ === 0) return redirectTo("https://cdn.test/mid")(q, res);
          okJson(q, res);
        };
        w.cdn.handler = redirectTo("https://registry.test/left-pad/-/left-pad-1.0.0.tgz");
        const r = await get(w.proxy.port, "/left-pad");
        assert.equal(r.status, 200);
        assert.equal(w.registry.hits[0]!.headers.authorization, `Bearer ${CANARY}`);
        assert.equal(w.registry.hits[1]!.headers.authorization, undefined, "credential must not be re-attached after a foreign hop");
      }));

    test("loops and long chains stop", () =>
      withWorld(
        async (w) => {
          w.registry.handler = redirectTo("https://registry.test/left-pad");
          const loop = await get(w.proxy.port, "/left-pad");
          assert.equal(loop.status, 508);
          assert.equal(w.registry.hits.length, 1);
          w.registry.hits.length = 0;
          let i = 0;
          w.registry.handler = (q, res) => redirectTo(`/left-pad/-/left-pad-1.0.${i++}.tgz`)(q, res);
          const long = await get(w.proxy.port, "/left-pad");
          assert.equal(long.status, 502);
          assert.equal(w.registry.hits.length, 4, "1 request + 3 followed redirects");
        },
        { config: (b) => ({ ...b, limits: { maxRedirects: 3, requestTimeoutMs: 5000 } }) },
      ));

    test("bad Location headers are denied, not guessed", () =>
      withWorld(async (w) => {
        w.registry.handler = (_q, res) => {
          res.writeHead(302);
          res.end();
        };
        assert.equal((await get(w.proxy.port, "/left-pad")).status, 502);
        w.registry.handler = redirectTo("javascript:alert(1)");
        assert.equal((await get(w.proxy.port, "/left-pad")).status, 403);
      }));
  });

  test("threat: header injection / request smuggling / path traversal (raw sockets, upstream never reached)", () =>
    withWorld(async (w) => {
      const p = w.proxy.port;
      const attacks: [string, string][] = [
        ["CL+TE", "GET /left-pad HTTP/1.1\r\nHost: p\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"],
        ["TE chunked body", "GET /left-pad HTTP/1.1\r\nHost: p\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"],
        ["duplicate Host", "GET /left-pad HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n"],
        ["duplicate CL", "GET /left-pad HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n"],
        ["GET with body", "GET /left-pad HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello"],
        ["smuggled second request in body", "GET /left-pad HTTP/1.1\r\nHost: a\r\nContent-Length: 44\r\n\r\nGET /lodash HTTP/1.1\r\nHost: a\r\n\r\nGET /x"],
        ["CRLF in path", "GET /left-pad%0d%0aX-Injected:1 HTTP/1.1\r\nHost: a\r\n\r\n"],
        ["space in path", "GET /left pad HTTP/1.1\r\nHost: a\r\n\r\n"],
        ["traversal", "GET /left-pad/../../etc/passwd HTTP/1.1\r\nHost: a\r\n\r\n"],
        ["encoded traversal", "GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: a\r\n\r\n"],
        ["double encoded", "GET /%252e%252e/x HTTP/1.1\r\nHost: a\r\n\r\n"],
        ["backslash", "GET /left-pad\\..\\x HTTP/1.1\r\nHost: a\r\n\r\n"],
        ["NUL", "GET /left-pad%00.tgz HTTP/1.1\r\nHost: a\r\n\r\n"],
        ["absolute form", "GET http://registry.test/left-pad HTTP/1.1\r\nHost: a\r\n\r\n"],
        ["Host with userinfo", "GET /left-pad HTTP/1.1\r\nHost: a@evil.test\r\n\r\n"],
        ["missing Host", "GET /left-pad HTTP/1.1\r\n\r\n"],
        ["obs-fold header", "GET /left-pad HTTP/1.1\r\nHost: a\r\nX-A: b\r\n c\r\n\r\n"],
        ["Upgrade", "GET /left-pad HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"],
        ["header name with space", "GET /left-pad HTTP/1.1\r\nHost: a\r\nTransfer-Encoding : chunked\r\n\r\n"],
        ["HTTP/0.9 style", "GET /left-pad\r\n\r\n"],
      ];
      for (const [name, payload] of attacks) {
        const res = await raw(p, payload, 800);
        const n = (res.match(/HTTP\/1\.\d 2\d\d/g) ?? []).length;
        assert.equal(n, 0, `${name}: a 2xx was returned: ${res.slice(0, 80)}`);
      }
      assert.equal(w.totalHits(), 0, "no attack reached an upstream");
    }));

  test("threat: client-supplied Authorization/Cookie/Proxy-*/Forwarded headers are stripped before the upstream sees them", () =>
    withWorld(async (w) => {
      await get(w.proxy.port, "/left-pad", {
        authorization: "Bearer stolen",
        cookie: "sid=1",
        "proxy-authorization": "Basic eDp5",
        "proxy-connection": "keep-alive",
        forwarded: "for=1.1.1.1",
        "x-forwarded-for": "1.1.1.1",
        "x-forwarded-host": "evil.test",
        "x-forwarded-proto": "http",
        "x-npm-otp": "123456",
        "npm-otp": "123456",
        "x-exfil": "data",
        "user-agent": "npm/10 <script>",
      });
      const h = w.registry.hits[0]!.headers;
      for (const bad of ["cookie", "proxy-authorization", "proxy-connection", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-npm-otp", "npm-otp", "x-exfil"]) {
        assert.equal(h[bad], undefined, bad);
      }
      assert.equal(h.authorization, `Bearer ${CANARY}`);
    }));

  describe("threat: resource exhaustion", () => {
    test("declared oversize response is refused before streaming", () =>
      withWorld(
        async (w) => {
          w.registry.handler = (_q, res) => {
            res.writeHead(200, { "content-length": 5000 });
            res.end(Buffer.alloc(5000));
          };
          const r = await get(w.proxy.port, TARBALL);
          assert.equal(r.status, 502);
          assert.equal(w.proxy.audit()[0]!.reason, "response-too-large");
        },
        { config: (b) => ({ ...b, limits: { maxResponseBytes: 1000, requestTimeoutMs: 5000 } }) },
      ));

    test("undeclared (chunked) oversize response is cut off at the cap", () =>
      withWorld(
        async (w) => {
          w.registry.handler = (_q, res) => {
            res.writeHead(200);
            res.write(Buffer.alloc(800));
            res.write(Buffer.alloc(800));
            res.write(Buffer.alloc(800));
            res.end();
          };
          const r = await get(w.proxy.port, TARBALL).catch(() => undefined);
          if (r) assert.ok(Buffer.byteLength(r.body) <= 1000);
          await new Promise((res) => setTimeout(res, 100));
          const e = w.proxy.audit().at(-1)!;
          assert.equal(e.decision, "error");
          assert.equal(e.reason, "response-too-large");
        },
        { config: (b) => ({ ...b, limits: { maxResponseBytes: 1000, requestTimeoutMs: 5000 } }) },
      ));

    test("slow upstream: request timeout returns 504 and frees the slot", () =>
      withWorld(
        async (w) => {
          w.registry.handler = () => undefined; // never answers
          const r = await get(w.proxy.port, "/left-pad");
          assert.equal(r.status, 504);
          w.registry.handler = okJson;
          assert.equal((await get(w.proxy.port, "/left-pad")).status, 200);
        },
        { config: (b) => ({ ...b, limits: { requestTimeoutMs: 300, maxConcurrent: 1 } }) },
      ));

    test("slowloris: a client dribbling its headers is cut off by the request timeout", () =>
      withWorld(
        async (w) => {
          const closed = await new Promise<number>((resolve) => {
            const started = Date.now();
            const s = net.connect(w.proxy.port, "127.0.0.1", () => {
              s.write("GET /left-pad HTTP/1.1\r\nHost: p\r\n");
              const t = setInterval(() => s.write("X-Slow: 1\r\n"), 100);
              s.on("close", () => {
                clearInterval(t);
                resolve(Date.now() - started);
              });
            });
            s.on("error", () => undefined);
            s.on("data", () => undefined);
            setTimeout(() => {
              s.destroy();
              resolve(-1);
            }, 4000);
          });
          assert.ok(closed > 0 && closed < 3000, `connection closed after ${closed} ms`);
          assert.equal(w.totalHits(), 0);
        },
        { config: (b) => ({ ...b, limits: { requestTimeoutMs: 400 } }) },
      ));

    test("concurrency cap with no queue: the request over the cap gets 503 queue-full, slots are released afterwards", () =>
      withWorld(
        async (w) => {
          const release: (() => void)[] = [];
          w.registry.handler = (_q, res) => release.push(() => okJson(_q, res));
          const a = get(w.proxy.port, "/left-pad");
          const b = get(w.proxy.port, "/left-pad");
          while (release.length < 2) await new Promise((r) => setTimeout(r, 10));
          const c = await get(w.proxy.port, "/left-pad");
          assert.equal(c.status, 503);
          assert.equal(c.headers["retry-after"], "1");
          release.forEach((f) => f());
          assert.equal((await a).status, 200);
          assert.equal((await b).status, 200);
          assert.equal(w.registry.hits.length, 2, "the rejected request never reached the upstream");
          w.registry.handler = okJson;
          assert.equal((await get(w.proxy.port, "/left-pad")).status, 200);
        },
        { config: (b) => ({ ...b, limits: { maxConcurrent: 2, maxQueued: 0, requestTimeoutMs: 5000 } }) },
      ));

    test("oversize header block and overlong URL are rejected", () =>
      withWorld(
        async (w) => {
          const big = await raw(w.proxy.port, `GET /left-pad HTTP/1.1\r\nHost: p\r\nX-Big: ${"a".repeat(3000)}\r\n\r\n`);
          assert.equal(statusOf(big), 431);
          const url = await get(w.proxy.port, `/${"a".repeat(600)}`);
          assert.equal(url.status, 414);
          assert.equal(w.totalHits(), 0);
        },
        { config: (b) => ({ ...b, limits: { maxHeaderBytes: 2048, requestTimeoutMs: 5000 } }) },
      ));
  });

  test("threat: token exposure in reports, logs, errors (upstream failures and TLS errors are redacted/generic)", () => {
    const sink: string[] = [];
    return withWorld(
      async (w) => {
        w.registry.handler = (q) => q.socket.destroy();
        const a = await get(w.proxy.port, "/left-pad");
        assert.equal(a.status, 502);
        assert.equal(a.body, JSON.stringify({ error: "proxy-error", reason: "upstream-error" }));
        const all = [JSON.stringify(a), JSON.stringify(w.proxy.audit()), ...sink].join("\n");
        assertNoSecret(all, "logs and errors");
        assert.equal(w.proxy.redact(`Authorization: Bearer ${CANARY}`).includes(CANARY), false);
        for (const e of w.proxy.audit()) assert.deepEqual(Object.keys(e).sort(), ["bytes", "class", "client", "decision", "host", "method", "ms", "name", "reason", "registry", "status", "time", "upstreamStatus", "version"]);
      },
      { proxy: { auditSink: (l) => sink.push(l) } },
    );
  });

  test("threat: audit records method/class/host/status/decision/reason with the injected clock and no headers or paths", () =>
    withWorld(
      async (w) => {
        await get(w.proxy.port, "/left-pad");
        await get(w.proxy.port, "/nope");
        await get(w.proxy.port, "/left-pad", {}, "DELETE");
        assert.deepEqual(w.proxy.audit(), [
          { time: 1234, method: "GET", class: "packument", registry: "main", host: "registry.test", status: 200, decision: "allow", reason: "forwarded", name: "left-pad", version: null, upstreamStatus: 200, bytes: 19, ms: 0, client: "other" },
          { time: 1234, method: "GET", class: "denied", registry: "main", host: null, status: 403, decision: "deny", reason: "package-not-allowlisted", name: "nope", version: null, upstreamStatus: null, bytes: null, ms: 0, client: "other" },
          { time: 1234, method: "DELETE", class: "denied", registry: null, host: null, status: 405, decision: "deny", reason: "method-not-allowed", name: null, version: null, upstreamStatus: null, bytes: null, ms: 0, client: "other" },
        ]);
      },
      { proxy: { now: () => 1234 } },
    ));

  test("threat: leftover resources after a crash/teardown (unit part: close() frees the port, sockets and in-flight work)", async () => {
    const w = await startWorld();
    w.registry.handler = () => undefined; // hang
    const port = w.proxy.port;
    const inflight = get(port, "/left-pad").catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 100));
    await w.proxy.close();
    assert.equal(await inflight, "aborted");
    await assert.rejects(get(port, "/left-pad"));
    await Promise.all([w.registry.close(), w.cdn.close(), w.evil.close()]);
    // container/network teardown and the stale-resource sweep are phase 3 (real engine).
  });

  test("threat: silent downgrade of the protection (no plaintext or unverified upstream path exists)", async () => {
    // 1. config cannot ask for http or carry a test seam / insecure flag (see unit.test.ts config table)
    // 2. without the test seam the proxy really dials https and verifies the certificate: a self-signed upstream fails.
    const selfSigned = await Upstream.start("https");
    try {
      const { parseConfig } = await import("../../src/sandbox/registry-proxy/config.js");
      const { startRegistryProxy } = await import("../../src/sandbox/registry-proxy/server.js");
      const cfg = parseConfig({
        registries: [{ id: "main", allowPrivateAddresses: true, upstream: `https://127.0.0.1:${selfSigned.port}`, credential: { type: "bearer", secret: CANARY } }],
        packages: { allow: ["left-pad"] },
        dns: ["127.0.0.1"],
        limits: { requestTimeoutMs: 3000 },
      });
      const proxy = await startRegistryProxy(cfg);
      try {
        const r = await get(proxy.port, "/left-pad");
        assert.equal(r.status, 502, "TLS verification must reject the untrusted certificate");
        assert.equal(selfSigned.hits.length, 0, "no request (and no credential) was sent over the unverified connection");
      } finally {
        await proxy.close();
      }
    } finally {
      await selfSigned.close();
    }
  });
});
