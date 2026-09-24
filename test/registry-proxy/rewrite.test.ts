import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { describe, test } from "node:test";
import { canonicalTarballUrl, etagMatches, rewritePackument, validateLearnedUrl, weakEtag } from "../../src/sandbox/registry-proxy/packument.js";
import { classifyRequest } from "../../src/sandbox/registry-proxy/request.js";
import { parseConfig } from "../../src/sandbox/registry-proxy/config.js";
import { CANARY, get, okJson, redirectTo, startWorld, type Handler, type Reply, type World, type WorldOptions } from "./fixtures.js";

async function withWorld(body: (w: World) => Promise<void>, opts: WorldOptions = {}): Promise<void> {
  const w = await startWorld(opts);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

// BOUNDARY (do not implement here, phase 4): yarn classic reads `resolved` URLs from an EXISTING yarn.lock and fetches them
// verbatim, so a lock written against the original registry host still needs its `resolved` host rewritten in the sandbox copy
// (same for npm locks without replace-registry-host=always, and for lock entries with non-standard layouts). What the proxy
// guarantees is the other half: every URL it hands out itself (packument dist.tarball) already points back at it, so a lock
// GENERATED through the proxy is host-clean. The real-client matrix in ratchet-proxy-compat.md records both cases.
const INTEG = "sha512-AAAA";
const SHASUM = "0123456789abcdef0123456789abcdef01234567";

interface Ver {
  tarball: string;
  deps?: Record<string, string>;
  optional?: Record<string, string>;
  peer?: Record<string, string>;
}
function packumentJson(name: string, versions: Record<string, Ver>, extra: Record<string, unknown> = {}): string {
  const latest = Object.keys(versions).at(-1);
  return JSON.stringify({
    _id: name,
    name,
    "dist-tags": { latest },
    readme: "keep me",
    versions: Object.fromEntries(
      Object.entries(versions).map(([v, m]) => [
        v,
        { name, version: v, dependencies: m.deps ?? {}, ...(m.optional ? { optionalDependencies: m.optional } : {}), ...(m.peer ? { peerDependencies: m.peer } : {}), dist: { tarball: m.tarball, integrity: INTEG, shasum: SHASUM } },
      ]),
    ),
    ...extra,
  });
}
const json = (body: string): Handler => (_q, res) => {
  res.writeHead(200, { "content-type": "application/json", etag: '"upstream-etag"', "content-length": Buffer.byteLength(body) });
  res.end(body);
};
const std = (name: string, v: string): string => `https://registry.test/${name}/-/${name.split("/").pop()}-${v}.tgz`;
const asJson = (r: Reply): { versions: Record<string, { dist: { tarball: string; integrity: string; shasum: string } }> } & Record<string, unknown> => JSON.parse(r.body);

describe("packument rewriting: pure functions", () => {
  test("rewrites every dist.tarball to the proxy base, keeps everything else byte-for-byte semantically, reports learned urls and declared deps", () => {
    const text = packumentJson("@s/n", { "1.0.0": { tarball: "https://up.example/dl/@s/n/1.0.0/abc", deps: { a: "^1", "@x/y": "^2" }, optional: { o: "1" }, peer: { p: "1" } }, "2.0.0": { tarball: "https://up.example/dl/@s/n/2.0.0/def", deps: { alias: "npm:@real/pkg@^1", a2: "npm:plain@1" } } });
    const r = rewritePackument(text, "@s/n", "http://127.0.0.1:1234/_r/x");
    assert.ok(r);
    const doc = JSON.parse(r.body.toString());
    assert.equal(doc.versions["1.0.0"].dist.tarball, "http://127.0.0.1:1234/_r/x/@s/n/-/n-1.0.0.tgz");
    assert.equal(doc.versions["2.0.0"].dist.tarball, "http://127.0.0.1:1234/_r/x/@s/n/-/n-2.0.0.tgz");
    assert.equal(doc.versions["1.0.0"].dist.integrity, INTEG);
    assert.equal(doc.versions["1.0.0"].dist.shasum, SHASUM);
    assert.equal(doc.readme, "keep me");
    assert.deepEqual(r.learned, [
      { version: "1.0.0", url: "https://up.example/dl/@s/n/1.0.0/abc" },
      { version: "2.0.0", url: "https://up.example/dl/@s/n/2.0.0/def" },
    ]);
    assert.deepEqual([...r.declared].sort(), ["@real/pkg", "@x/y", "a", "o", "p", "plain"]);
  });

  test("non-JSON / non-object bodies are undefined; unusable tarball urls are rewritten but not learned", () => {
    assert.equal(rewritePackument("<html>", "x", "http://h"), undefined);
    assert.equal(rewritePackument("[1]", "x", "http://h"), undefined);
    assert.equal(rewritePackument("null", "x", "http://h"), undefined);
    const r = rewritePackument(JSON.stringify({ versions: { "1.0.0": { dist: { tarball: "http://plain.example/x.tgz" } }, "1.0.1": { dist: { tarball: "https://u:p@h.example/x.tgz" } }, "1.0.2": { dist: { tarball: 5 } }, "1.0.3": {} } }), "x", "http://h");
    assert.ok(r);
    assert.deepEqual(r.learned, []);
    const doc = JSON.parse(r.body.toString());
    assert.equal(doc.versions["1.0.0"].dist.tarball, "http://h/x/-/x-1.0.0.tgz");
    assert.equal(doc.versions["1.0.1"].dist.tarball, "http://h/x/-/x-1.0.1.tgz");
  });

  test("validateLearnedUrl: https only, no userinfo/fragment/control chars, bounded", () => {
    assert.ok(validateLearnedUrl("https://a.example/x?sig=1"));
    for (const bad of ["http://a.example/x", "https://u@a.example/x", "https://a.example/x#f", "https://a.example/x y", `https://a.example/${"a".repeat(3000)}`, "", 5, undefined, "ftp://a/x", "javascript:1"]) {
      assert.equal(validateLearnedUrl(bad), undefined, String(bad));
    }
  });

  test("canonical url and weak etag / If-None-Match comparison", () => {
    assert.equal(canonicalTarballUrl("http://h", "@s/n", "1.0.0"), "http://h/@s/n/-/n-1.0.0.tgz");
    assert.equal(canonicalTarballUrl("http://h", "n", "1.0.0+build.5"), "http://h/n/-/n-1.0.0+build.5.tgz");
    assert.equal(canonicalTarballUrl("http://h", "n", "1.0.0/../../x?y#z"), "http://h/n/-/n-1.0.0%2F..%2F..%2Fx%3Fy%23z.tgz", "a hostile version key cannot add path segments, query or fragment");
    const e = weakEtag(Buffer.from("x"));
    assert.match(e, /^W\/"[0-9a-f]{40}"$/);
    assert.ok(etagMatches(e, e));
    assert.ok(etagMatches(e.slice(2), e), "weak comparison");
    assert.ok(etagMatches(`"zzz", ${e}`, e));
    assert.ok(etagMatches("*", e));
    assert.ok(!etagMatches('"other"', e));
    assert.ok(!etagMatches(undefined, e));
  });
});

describe("D1: dist.tarball is rewritten to the proxy (abbreviated and full packuments)", () => {
  test("client fetches the canonical url it was given; upstream sees identity encoding and the credential", () =>
    withWorld(async (w) => {
      w.registry.handler = json(packumentJson("left-pad", { "1.0.0": { tarball: std("left-pad", "1.0.0") }, "1.3.0": { tarball: std("left-pad", "1.3.0") } }));
      for (const accept of ["application/vnd.npm.install-v1+json", "application/json", "*/*"]) {
        const r = await get(w.proxy.port, "/left-pad", { accept, "accept-encoding": "gzip, br" });
        assert.equal(r.status, 200);
        const doc = asJson(r);
        assert.equal(doc.versions["1.3.0"]!.dist.tarball, `http://127.0.0.1:${w.proxy.port}/left-pad/-/left-pad-1.3.0.tgz`);
        assert.equal(doc.versions["1.3.0"]!.dist.integrity, INTEG);
        assert.equal(r.headers["content-encoding"], undefined);
        assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(r.body));
        assert.match(String(r.headers.etag), /^W\//);
        assert.notEqual(r.headers.etag, '"upstream-etag"');
      }
      for (const h of w.registry.hits) {
        assert.equal(h.headers["accept-encoding"], "identity", "packuments are always fetched with identity encoding");
        assert.equal(h.headers.authorization, `Bearer ${CANARY}`);
      }
      w.registry.hits.length = 0;
      w.registry.handler = okJson;
      const t = await get(w.proxy.port, `/left-pad/-/left-pad-1.3.0.tgz`);
      assert.equal(t.status, 200);
      assert.equal(w.registry.hits[0]?.url, "/left-pad/-/left-pad-1.3.0.tgz");
    }));

  test("a non-default registry gets the /_r/<id>/ prefix in the rewritten urls; scoped names stay scoped", () =>
    withWorld(
      async (w) => {
        w.evil.handler = (_q, res) => {
          const body = packumentJson("@s/n", { "1.0.0": { tarball: "https://evil.test/x/@s/n/1.0.0" } });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(body);
        };
        const r = await get(w.proxy.port, "/_r/other/@s%2fn");
        assert.equal(r.status, 200);
        assert.equal(asJson(r).versions["1.0.0"]!.dist.tarball, `http://127.0.0.1:${w.proxy.port}/_r/other/@s/n/-/n-1.0.0.tgz`);
      },
      {
        config: (b) => ({
          ...b,
          registries: [
            { id: "main", default: true, upstream: "https://registry.test", credential: { type: "bearer", secret: CANARY } },
            { id: "other", upstream: "https://evil.test" },
          ],
          packages: { allow: ["left-pad", "@s/n"] },
        }),
      },
    ));

  test("upstream that compresses anyway is decoded; gzip, deflate and br; unknown encodings are a clean 502", () =>
    withWorld(async (w) => {
      const body = packumentJson("left-pad", { "1.0.0": { tarball: std("left-pad", "1.0.0") } });
      w.registry.handler = (_q, res) => {
        const z = gzipSync(body);
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": z.length });
        res.end(z);
      };
      const r = await get(w.proxy.port, "/left-pad");
      assert.equal(asJson(r).versions["1.0.0"]!.dist.tarball, `http://127.0.0.1:${w.proxy.port}/left-pad/-/left-pad-1.0.0.tgz`);
      assert.equal(r.headers["content-encoding"], undefined);
      w.registry.handler = (_q, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "zstd" });
        res.end("x");
      };
      assert.equal((await get(w.proxy.port, "/left-pad")).status, 502);
      assert.equal(w.proxy.audit().at(-1)?.reason, "unsupported-encoding");
    }));

  test("conditional requests are answered locally with our own weak etag; client validators are never forwarded", () =>
    withWorld(async (w) => {
      let body = packumentJson("left-pad", { "1.0.0": { tarball: std("left-pad", "1.0.0") } });
      w.registry.handler = (q, res) => json(body)(q, res);
      const first = await get(w.proxy.port, "/left-pad");
      const etag = String(first.headers.etag);
      const second = await get(w.proxy.port, "/left-pad", { "if-none-match": etag, "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT" });
      assert.equal(second.status, 304);
      assert.equal(second.body, "");
      assert.equal(second.headers.etag, etag);
      assert.equal(w.registry.hits[1]?.headers["if-none-match"], undefined);
      assert.equal(w.registry.hits[1]?.headers["if-modified-since"], undefined);
      body = packumentJson("left-pad", { "1.0.0": { tarball: std("left-pad", "1.0.0") }, "1.0.1": { tarball: std("left-pad", "1.0.1") } });
      const third = await get(w.proxy.port, "/left-pad", { "if-none-match": etag });
      assert.equal(third.status, 200, "changed upstream document -> new etag -> full response");
      assert.notEqual(third.headers.etag, etag);
    }));

  test("HEAD packument: status and content-type only, no stale length or etag", () =>
    withWorld(async (w) => {
      w.registry.handler = json(packumentJson("left-pad", { "1.0.0": { tarball: std("left-pad", "1.0.0") } }));
      const r = await get(w.proxy.port, "/left-pad", {}, "HEAD");
      assert.equal(r.status, 200);
      assert.equal(r.headers.etag, undefined);
      assert.equal(r.headers["content-length"], undefined);
    }));

  test("not-JSON and oversize packuments fail cleanly (502) instead of being forwarded raw", () =>
    withWorld(
      async (w) => {
        w.registry.handler = (_q, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html>login</html>");
        };
        assert.equal((await get(w.proxy.port, "/left-pad")).status, 502);
        assert.equal(w.proxy.audit().at(-1)?.reason, "packument-not-json");
        w.registry.handler = (_q, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.write("{".padEnd(2000, " "));
          res.end("}");
        };
        assert.equal((await get(w.proxy.port, "/left-pad")).status, 502);
        assert.equal(w.proxy.audit().at(-1)?.reason, "response-too-large");
      },
      { config: (b) => ({ ...b, limits: { maxPackumentBytes: 1024, requestTimeoutMs: 5000 } }) },
    ));
});

const fixedFile = (pkg: string, v: string): Buffer => Buffer.from(`TARBALL:${pkg}@${v}`);

describe("D1: registry layouts (fixture upstreams), tarballs mapped back through the learned upstream url", () => {
  test("Artifactory layout: pathPrefix registry, packument and tarball both under /api/npm/repo; lockfile-style prefixed client paths are stripped", () =>
    withWorld(
      async (w) => {
        w.registry.handler = (q, res) => {
          if (q.url === "/api/npm/repo/art-pkg") return json(packumentJson("art-pkg", { "1.0.0": { tarball: "https://registry.test/api/npm/repo/art-pkg/-/art-pkg-1.0.0.tgz" } }))(q, res);
          if (q.url === "/api/npm/repo/art-pkg/-/art-pkg-1.0.0.tgz") {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            return res.end(fixedFile("art-pkg", "1.0.0"));
          }
          res.writeHead(404);
          res.end("nope");
        };
        const pack = await get(w.proxy.port, "/art-pkg");
        const tar = asJson(pack).versions["1.0.0"]!.dist.tarball;
        assert.equal(tar, `http://127.0.0.1:${w.proxy.port}/art-pkg/-/art-pkg-1.0.0.tgz`);
        const t = await get(w.proxy.port, new URL(tar).pathname);
        assert.equal(t.status, 200);
        assert.equal(t.body, "TARBALL:art-pkg@1.0.0");
        // npm replace-registry-host keeps the FULL old path: /api/npm/repo/art-pkg/-/art-pkg-1.0.0.tgz on the proxy host
        const t2 = await get(w.proxy.port, "/api/npm/repo/art-pkg/-/art-pkg-1.0.0.tgz");
        assert.equal(t2.status, 200);
        assert.equal(t2.body, "TARBALL:art-pkg@1.0.0");
        const p2 = await get(w.proxy.port, "/api/npm/repo/art-pkg");
        assert.equal(p2.status, 200);
        assert.deepEqual(w.registry.hits.map((h) => h.url), ["/api/npm/repo/art-pkg", "/api/npm/repo/art-pkg/-/art-pkg-1.0.0.tgz", "/api/npm/repo/art-pkg/-/art-pkg-1.0.0.tgz", "/api/npm/repo/art-pkg"]);
        assert.ok(w.registry.hits.every((h) => h.headers.authorization === `Bearer ${CANARY}`));
      },
      { config: (b) => ({ ...b, registries: [{ id: "main", upstream: "https://registry.test", pathPrefix: "/api/npm/repo", credential: { type: "bearer", secret: CANARY } }], packages: { allow: ["art-pkg", "api"] } }) },
    ));

  test("Artifactory prefix stripping does not shadow a package that happens to share the first segment", () =>
    withWorld(
      async (w) => {
        const r = await get(w.proxy.port, "/api/-/api-1.0.0.tgz");
        assert.equal(r.status, 200);
        assert.equal(w.registry.hits[0]?.url, "/api/npm/repo/api/-/api-1.0.0.tgz");
      },
      { config: (b) => ({ ...b, registries: [{ id: "main", upstream: "https://registry.test", pathPrefix: "/api/npm/repo", credential: { type: "bearer", secret: CANARY } }], packages: { allow: ["api"] } }) },
    ));

  test("GitHub Packages layout: /download/@scope/name/version/sha, canonical tarball request resolves to it (credential attached), unknown versions fall back to the standard layout", () =>
    withWorld(
      async (w) => {
        const sha = createHash("sha1").update("ghpkg1").digest("hex");
        w.registry.handler = (q, res) => {
          if (q.url === "/@ghscope%2Fghpkg") return json(packumentJson("@ghscope/ghpkg", { "1.0.0": { tarball: `https://registry.test/download/@ghscope/ghpkg/1.0.0/${sha}` } }))(q, res);
          if (q.url === `/download/@ghscope/ghpkg/1.0.0/${sha}`) {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            return res.end("GH-TARBALL");
          }
          res.writeHead(404, { "content-type": "application/json" });
          res.end('{"error":"missing"}');
        };
        const pack = await get(w.proxy.port, "/@ghscope%2Fghpkg");
        const tar = asJson(pack).versions["1.0.0"]!.dist.tarball;
        assert.equal(tar, `http://127.0.0.1:${w.proxy.port}/@ghscope/ghpkg/-/ghpkg-1.0.0.tgz`);
        const t = await get(w.proxy.port, new URL(tar).pathname);
        assert.equal(t.status, 200);
        assert.equal(t.body, "GH-TARBALL");
        assert.equal(w.registry.hits[1]?.headers.authorization, `Bearer ${CANARY}`);
        const unknown = await get(w.proxy.port, "/@ghscope/ghpkg/-/ghpkg-2.0.0.tgz");
        assert.equal(unknown.status, 404);
        assert.equal(w.registry.hits[2]?.url, "/@ghscope/ghpkg/-/ghpkg-2.0.0.tgz");
      },
      { config: (b) => ({ ...b, packages: { allow: ["@ghscope/ghpkg"] } }) },
    ));

  test("the learned map is per registry and per name@version", () =>
    withWorld(
      async (w) => {
        w.registry.handler = json(packumentJson("left-pad", { "1.0.0": { tarball: "https://registry.test/special/left-pad-1.0.0.tgz" } }));
        await get(w.proxy.port, "/left-pad");
        w.registry.hits.length = 0;
        w.registry.handler = okJson;
        await get(w.proxy.port, "/left-pad/-/left-pad-1.0.0.tgz");
        await get(w.proxy.port, "/left-pad/-/left-pad-1.0.1.tgz");
        await get(w.proxy.port, "/_r/other/left-pad/-/left-pad-1.0.0.tgz");
        assert.deepEqual(w.registry.hits.map((h) => h.url), ["/special/left-pad-1.0.0.tgz", "/left-pad/-/left-pad-1.0.1.tgz"]);
        assert.deepEqual(w.evil.hits.map((h) => h.url), ["/left-pad/-/left-pad-1.0.0.tgz"], "another registry never uses this registry's learned url");
      },
      {
        config: (b) => ({
          ...b,
          registries: [
            { id: "main", default: true, upstream: "https://registry.test", credential: { type: "bearer", secret: CANARY } },
            { id: "other", upstream: "https://evil.test" },
          ],
        }),
      },
    ));

  test("learned url on a foreign host: only an allowlisted host, always without the credential", () =>
    withWorld(
      async (w) => {
        w.registry.handler = json(packumentJson("left-pad", { "1.0.0": { tarball: "https://cdn.test/files/left-pad-1.0.0.tgz" }, "1.0.1": { tarball: "https://evil.test/files/left-pad-1.0.1.tgz" } }));
        await get(w.proxy.port, "/left-pad");
        w.cdn.handler = (_q, res) => {
          res.writeHead(200);
          res.end("CDN-BYTES");
        };
        const ok = await get(w.proxy.port, "/left-pad/-/left-pad-1.0.0.tgz");
        assert.equal(ok.body, "CDN-BYTES");
        assert.equal(w.cdn.hits[0]?.url, "/files/left-pad-1.0.0.tgz");
        assert.equal(w.cdn.hits[0]?.headers.authorization, undefined);
        const bad = await get(w.proxy.port, "/left-pad/-/left-pad-1.0.1.tgz");
        assert.equal(bad.status, 403);
        assert.equal(w.evil.hits.length, 0, "not allowlisted: never contacted");
        assert.equal(w.proxy.audit().at(-1)?.reason, "tarball-host-not-allowed");
        assert.equal(w.registry.hits.length, 1, "only the packument went to the registry");
      },
    ));

  test("a publisher cannot aim dist.tarball at another authenticated endpoint of the registry (implausible same-origin urls are not learned)", () =>
    withWorld(async (w) => {
      w.registry.handler = json(packumentJson("left-pad", { "1.0.0": { tarball: "https://registry.test/-/npm/v1/tokens" }, "1.0.1": { tarball: "https://registry.test/other-private-pkg" }, "1.0.2": { tarball: "http://registry.test/left-pad/-/left-pad-1.0.2.tgz" } }));
      await get(w.proxy.port, "/left-pad");
      w.registry.hits.length = 0;
      w.registry.handler = okJson;
      for (const v of ["1.0.0", "1.0.1", "1.0.2"]) await get(w.proxy.port, `/left-pad/-/left-pad-${v}.tgz`);
      assert.deepEqual(w.registry.hits.map((h) => h.url), ["/left-pad/-/left-pad-1.0.0.tgz", "/left-pad/-/left-pad-1.0.1.tgz", "/left-pad/-/left-pad-1.0.2.tgz"]);
    }));

  test("a learned url that redirects keeps the redirect rules (presigned cdn, credential dropped)", () =>
    withWorld(async (w) => {
      w.registry.handler = (q, res) => {
        if (q.url === "/left-pad") return json(packumentJson("left-pad", { "1.0.0": { tarball: "https://registry.test/dl/left-pad/1.0.0/abc" } }))(q, res);
        return redirectTo("https://cdn.test/blob/left-pad.tgz?sig=abc123&exp=9")(q, res);
      };
      w.cdn.handler = (_q, res) => {
        res.writeHead(200);
        res.end("SIGNED");
      };
      await get(w.proxy.port, "/left-pad");
      const t = await get(w.proxy.port, "/left-pad/-/left-pad-1.0.0.tgz");
      assert.equal(t.body, "SIGNED");
      assert.equal(w.cdn.hits[0]?.url, "/blob/left-pad.tgz?sig=abc123&exp=9");
      assert.equal(w.cdn.hits[0]?.headers.authorization, undefined);
    }));
});

describe("D2: registries are routed under /_r/<id>/ (outside the npm name space)", () => {
  const registries = [
    { id: "main", default: true, upstream: "https://registry.test", credential: { type: "bearer", secret: CANARY } },
    { id: "art", upstream: "https://evil.test" },
  ];
  test("a package named like a registry id is reachable on the default registry; the other registry is under /_r/art/", () =>
    withWorld(
      async (w) => {
        assert.equal((await get(w.proxy.port, "/art")).status, 200);
        assert.equal(w.registry.hits.at(-1)?.url, "/art");
        assert.equal((await get(w.proxy.port, "/art/-/art-1.0.0.tgz")).status, 200);
        assert.equal((await get(w.proxy.port, "/_r/art/art")).status, 200);
        assert.equal(w.evil.hits.at(-1)?.url, "/art");
        assert.equal((await get(w.proxy.port, "/_r/main/art")).status, 200, "the default registry is reachable under its id too");
        assert.equal(w.registry.hits.length, 3);
      },
      { config: (b) => ({ ...b, registries, packages: { allow: ["art"] } }) },
    ));

  test("the old un-prefixed form no longer routes to a non-default registry; unknown ids and bare /_r are 404", () =>
    withWorld(
      async (w) => {
        assert.equal((await get(w.proxy.port, "/art/left-pad")).status, 403, "`art/left-pad` is now just an invalid default-registry path");
        for (const p of ["/_r/nope/left-pad", "/_r/", "/_r", "/_r/ART/left-pad"]) {
          const r = await get(w.proxy.port, p);
          assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
        }
        assert.equal(w.evil.hits.length, 0);
      },
      { config: (b) => ({ ...b, registries, packages: { allow: ["left-pad"] } }) },
    ));

  test("classifier level: prefix routing, canonical upstream path, pathPrefix, no shadowing", () => {
    const cfg = parseConfig({
      registries: [
        { id: "main", default: true, upstream: "https://a.example" },
        { id: "art", upstream: "https://b.example", pathPrefix: "/api/npm/repo" },
      ],
      dns: ["127.0.0.1"],
    });
    const ctx = { registries: cfg.registries, limits: { maxUrlLength: 512, maxHeaderBytes: 8192 }, isPackageAllowed: () => true };
    const c = (url: string) => classifyRequest({ method: "GET", url, rawHeaders: ["Host", "x"] }, ctx);
    const a = c("/_r/art/left-pad");
    assert.ok(a.ok);
    assert.equal(a.registry.id, "art");
    assert.equal(a.upstreamPath, "/api/npm/repo/left-pad");
    const b = c("/art");
    assert.ok(b.ok);
    assert.equal(b.registry.id, "main");
    assert.equal(b.name, "art");
    const t = c("/_r/art/api/npm/repo/left-pad/-/left-pad-1.0.0.tgz");
    assert.ok(t.ok);
    assert.equal(t.upstreamPath, "/api/npm/repo/left-pad/-/left-pad-1.0.0.tgz");
    assert.equal(t.version, "1.0.0");
    const r = c("/_r/nope/x");
    assert.ok(!r.ok && r.status === 404);
  });
});

describe("D4: non-2xx upstream bodies are never forwarded", () => {
  test("an upstream that reflects the Authorization header in body and headers cannot return the credential", () =>
    withWorld(async (w) => {
      for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
        w.registry.handler = (q, res) => {
          res.writeHead(status, { "content-type": "text/plain", "www-authenticate": `Bearer realm="${q.headers.authorization}"`, "x-echo": String(q.headers.authorization), "set-cookie": `t=${q.headers.authorization}`, etag: '"e"', "retry-after": "7" });
          res.end(`your auth: ${q.headers.authorization}`);
        };
        for (const p of ["/left-pad", "/left-pad/-/left-pad-1.0.0.tgz"]) {
          const r = await get(w.proxy.port, p);
          assert.equal(r.status, status);
          assert.equal(r.body, JSON.stringify({ error: `upstream ${status}` }));
          assert.ok(!JSON.stringify(r).includes(CANARY), "no trace of the credential in the whole reply");
          assert.deepEqual(Object.keys(r.headers).filter((h) => ["www-authenticate", "x-echo", "set-cookie", "etag"].includes(h)), []);
          assert.equal(r.headers["retry-after"], "7", "safe numeric retry-after survives");
          assert.equal(r.headers["content-type"], "application/json");
        }
      }
      const e = w.proxy.audit().at(-1)!;
      assert.deepEqual([e.decision, e.reason, e.status, e.upstreamStatus], ["upstream-error", "upstream-503", 503, 503]);
    }));

  test("HEAD keeps the status and has no body; hostile retry-after is dropped; 407 and stray 3xx become 502", () =>
    withWorld(async (w) => {
      w.registry.handler = (_q, res) => {
        res.writeHead(404, { "retry-after": "1; evil" });
        res.end("x");
      };
      const h = await get(w.proxy.port, "/left-pad", {}, "HEAD");
      assert.equal(h.status, 404);
      assert.equal(h.body, "");
      assert.equal(h.headers["retry-after"], undefined);
      for (const [up, down] of [[407, 502], [300, 502], [305, 502], [418, 418]] as const) {
        w.registry.handler = (_q, res) => {
          res.writeHead(up, { "proxy-authenticate": "Basic realm=x" });
          res.end("body");
        };
        const r = await get(w.proxy.port, "/left-pad");
        assert.equal(r.status, down, String(up));
        assert.equal(r.headers["proxy-authenticate"], undefined);
        assert.equal(r.body, JSON.stringify({ error: `upstream ${up}` }));
      }
    }));

  test("2xx tarball bodies are still streamed unchanged; upstream 304 is relayed without a body", () =>
    withWorld(async (w) => {
      const payload = Buffer.alloc(200_000, 9);
      w.registry.handler = (_q, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length, etag: '"t1"' });
        res.end(payload);
      };
      const r = await new Promise<Buffer>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: w.proxy.port, path: "/left-pad/-/left-pad-1.0.0.tgz", agent: false }, (res) => {
          const c: Buffer[] = [];
          res.on("data", (d: Buffer) => c.push(d));
          res.on("end", () => resolve(Buffer.concat(c)));
        }).on("error", reject);
      });
      assert.ok(r.equals(payload));
      w.registry.handler = (_q, res) => {
        res.writeHead(304, { etag: '"t1"' });
        res.end();
      };
      const n = await get(w.proxy.port, "/left-pad/-/left-pad-1.0.0.tgz", { "if-none-match": '"t1"' });
      assert.equal(n.status, 304);
      assert.equal(n.headers.etag, '"t1"');
      assert.equal(w.registry.hits.at(-1)?.headers["if-none-match"], '"t1"', "tarball validators are forwarded");
    }));
});

describe("D5: redirects keep the query string; same-origin targets are classified like requests", () => {
  test("presigned redirect (?sig=...) to an allowlisted CDN arrives with its full query", () =>
    withWorld(async (w) => {
      w.registry.handler = redirectTo("https://cdn.test/cdn/left-pad-1.0.0.tgz?sig=abc123&Expires=99&Key-Pair-Id=K1");
      w.cdn.handler = (q, res) => {
        res.writeHead(/[?&]sig=abc123&Expires=99&Key-Pair-Id=K1$/.test(q.url ?? "") ? 200 : 403);
        res.end("OK");
      };
      const r = await get(w.proxy.port, "/left-pad/-/left-pad-1.0.0.tgz");
      assert.equal(r.status, 200);
      assert.equal(w.cdn.hits[0]?.url, "/cdn/left-pad-1.0.0.tgz?sig=abc123&Expires=99&Key-Pair-Id=K1");
      assert.equal(w.cdn.hits[0]?.headers.authorization, undefined);
      assert.equal(w.proxy.audit().at(-1)?.decision, "allow");
    }));

  test("relative redirect with a query to a non-package path needs the host allowlist and goes without the credential", () =>
    withWorld(
      async (w) => {
        let n = 0;
        w.registry.handler = (q, res) => {
          n++;
          if (n === 1) return redirectTo("/storage/blob?sig=zz")(q, res);
          res.writeHead(200);
          res.end("BLOB");
        };
        const r = await get(w.proxy.port, "/left-pad/-/left-pad-1.0.0.tgz");
        assert.equal(r.status, 200);
        assert.equal(w.registry.hits[1]?.url, "/storage/blob?sig=zz");
        assert.equal(w.registry.hits[0]?.headers.authorization, `Bearer ${CANARY}`);
        assert.equal(w.registry.hits[1]?.headers.authorization, undefined, "same origin but not a package path: no credential");
      },
      { config: (b) => ({ ...b, allowHosts: ["cdn.test:443", "registry.test:443"] }) },
    ));

  test("same-origin redirect to something that is not an allowed package path is refused when the registry host is not allowlisted", () =>
    withWorld(async (w) => {
      for (const target of ["/-/npm/v1/tokens", "/other-private-pkg", "/left-pad?x=1", "/left-pad/-/left-pad-1.0.0.tgz?x=1", "/left-pad/extra/segments", "/-/whoami"]) {
        w.registry.hits.length = 0;
        w.registry.handler = redirectTo(target);
        const r = await get(w.proxy.port, "/left-pad/-/left-pad-1.0.0.tgz");
        assert.equal(r.status, 403, target);
        assert.equal(w.registry.hits.length, 1, `${target}: the target was never requested`);
        assert.equal(w.proxy.audit().at(-1)?.reason, "redirect-host-not-allowed");
      }
    }));

  test("same-origin redirect to an allowed package path keeps the credential (both packument and tarball forms, scoped %2F)", () =>
    withWorld(async (w) => {
      let n = 0;
      w.registry.handler = (q, res) => {
        n++;
        if (n === 1) return redirectTo("/@scope%2Fpkg")(q, res);
        okJson(q, res);
      };
      assert.equal((await get(w.proxy.port, "/left-pad")).status, 200);
      assert.equal(w.registry.hits[1]?.url, "/@scope%2Fpkg");
      assert.equal(w.registry.hits[1]?.headers.authorization, `Bearer ${CANARY}`);
    }));
});

describe("D7: discovery mode (bisect/probe) and the distinct allowlist denial", () => {
  const alphaWorld = (discovery: "off" | "audit"): WorldOptions => ({ config: (b) => ({ ...b, discovery, packages: { allow: ["alpha"] } }) });
  const upstream = (w: World): void => {
    w.registry.handler = (q, res) => {
      const u = q.url ?? "";
      if (u === "/alpha") return json(packumentJson("alpha", { "1.1.0": { tarball: std("alpha", "1.1.0"), deps: { beta: "^1" } }, "1.2.0": { tarball: std("alpha", "1.2.0"), deps: { beta: "^1", gamma: "^1" } } }))(q, res);
      if (u === "/gamma") return json(packumentJson("gamma", { "1.0.0": { tarball: std("gamma", "1.0.0"), deps: { delta: "1", "@sc/x": "1" }, peer: { alias: "npm:realpeer@1" } } }))(q, res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: u.slice(1), versions: {} }));
    };
  };

  test("default (off): gamma stays denied even after alpha@1.2.0 declared it, with a distinct audit reason and the denied name reported", () =>
    withWorld(async (w) => {
      upstream(w);
      assert.equal((await get(w.proxy.port, "/alpha")).status, 200);
      const r = await get(w.proxy.port, "/gamma");
      assert.equal(r.status, 403);
      assert.equal(JSON.parse(r.body).reason, "package-not-allowlisted");
      const e = w.proxy.audit().at(-1)!;
      assert.deepEqual([e.decision, e.reason, e.name, e.registry], ["deny", "package-not-allowlisted", "gamma", "main"]);
      assert.deepEqual(w.proxy.discoveredNames(), []);
      assert.deepEqual(w.proxy.deniedPackages(), ["gamma"]);
    }, alphaWorld("off")));

  test("audit: names declared by an allowed packument and then requested are auto-allowed, recorded once, exposed, and chain transitively", () =>
    withWorld(async (w) => {
      upstream(w);
      assert.equal((await get(w.proxy.port, "/gamma")).status, 403, "not declared yet");
      assert.equal((await get(w.proxy.port, "/alpha")).status, 200);
      assert.equal((await get(w.proxy.port, "/beta")).status, 200);
      assert.equal((await get(w.proxy.port, "/gamma")).status, 200);
      assert.equal((await get(w.proxy.port, "/gamma")).status, 200);
      assert.equal((await get(w.proxy.port, "/gamma/-/gamma-1.0.0.tgz")).status, 200, "tarball of a discovered name");
      assert.equal((await get(w.proxy.port, "/delta")).status, 200, "declared by the discovered gamma");
      assert.equal((await get(w.proxy.port, "/@sc%2fx")).status, 200);
      assert.equal((await get(w.proxy.port, "/realpeer")).status, 200, "npm: alias resolves to the real name");
      assert.equal((await get(w.proxy.port, "/never-declared")).status, 403);
      assert.deepEqual(w.proxy.discoveredNames(), ["@sc/x", "beta", "delta", "gamma", "realpeer"]);
      const disc = w.proxy.audit().filter((e) => e.reason === "discovered");
      assert.deepEqual(disc.map((e) => e.name), ["beta", "gamma", "delta", "@sc/x", "realpeer"], "one audit line per name, at first use");
      assert.ok(disc.every((e) => e.decision === "allow" && e.registry === "main"));
      assert.deepEqual(w.proxy.deniedPackages(), ["gamma", "never-declared"], "the pre-discovery denial of gamma stays reported for the report");
    }, alphaWorld("audit")));

  test("config validation: discovery is off|audit", async () => {
    const base = { registries: [{ id: "main", upstream: "https://registry.example.com" }], dns: ["127.0.0.1"] };
    assert.equal(parseConfig(base).discovery, "off");
    assert.equal(parseConfig({ ...base, discovery: "audit" }).discovery, "audit");
    for (const bad of ["on", true, "AUDIT", 1, null]) assert.throws(() => parseConfig({ ...base, discovery: bad }));
  });
});
