import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, test } from "node:test";
import { ConfigError, DEFAULT_LIMITS, parseConfig, type RegistryConfig } from "../../src/sandbox/registry-proxy/config.js";
import { buildUpstreamHeaders, sanitiseUserAgent } from "../../src/sandbox/registry-proxy/headers.js";
import { decideRedirect } from "../../src/sandbox/registry-proxy/redirect.js";
import { classifyRequest, checkHeaderBlock } from "../../src/sandbox/registry-proxy/request.js";
import { Credential, createRedactor, redactError, Secret } from "../../src/sandbox/registry-proxy/secret.js";
import { AuditLog } from "../../src/sandbox/registry-proxy/audit.js";
import { CANARY } from "./fixtures.js";

const goodConfig = (): Record<string, unknown> => ({
  registries: [{ id: "main", upstream: "https://registry.example.com", credential: { type: "bearer", secret: CANARY } }],
  dns: ["1.1.1.1"],
});

describe("secret and credential never serialise", () => {
  test("Secret: JSON, String, template, inspect, spread, clone", () => {
    const s = new Secret(CANARY);
    const outputs = [JSON.stringify(s), String(s), `${s}`, inspect(s), inspect({ s }), JSON.stringify({ nested: [s] }), JSON.stringify({ ...s }), JSON.stringify(structuredClone(s)), Object.keys(s).join(",")];
    for (const o of outputs) assert.ok(!o.includes(CANARY), o);
    assert.equal(s.reveal(), CANARY);
  });
  test("Credential: bearer and basic never serialise; header only via authorization()", () => {
    for (const c of [new Credential("bearer", CANARY), new Credential("basic", `user:${CANARY}`)]) {
      for (const o of [JSON.stringify(c), String(c), inspect(c), inspect([c], { depth: 9 }), JSON.stringify({ ...c })]) {
        assert.ok(!o.includes(CANARY), o);
      }
    }
    assert.equal(new Credential("bearer", CANARY).authorization(), `Bearer ${CANARY}`);
    assert.equal(new Credential("basic", "user:passw0rd!").authorization(), `Basic ${Buffer.from("user:passw0rd!").toString("base64")}`);
  });
  test("short or control-character secrets and bad types are refused", () => {
    assert.throws(() => new Secret("short"));
    assert.throws(() => new Secret("abcdefgh\nijkl"));
    assert.throws(() => new Credential("basic", "no-colon-here-at-all"));
    assert.throws(() => new Credential("oauth" as never, CANARY));
  });
  test("parsed config serialises without the canary", () => {
    const cfg = parseConfig(goodConfig());
    assert.ok(!JSON.stringify(cfg).includes(CANARY));
    assert.ok(!inspect(cfg, { depth: 10 }).includes(CANARY));
  });
});

describe("redaction", () => {
  const b64 = (s: string): string => Buffer.from(s).toString("base64");
  test("scrubs raw, base64 (all alignments), base64url, url-encoded, hex and basic-auth forms", () => {
    const secret = "pa/ss+wörd=&x-tok-12345678";
    const cred = new Credential("basic", `alice:${secret}`);
    const redact = createRedactor(cred.material());
    const forms = [
      secret,
      `alice:${secret}`,
      b64(`alice:${secret}`),
      `Basic ${b64(`alice:${secret}`)}`,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("hex"),
      Buffer.from(secret).toString("base64url"),
      b64(`x${secret}`).slice(2),
      b64(`xy${secret}z`).slice(3, -4),
      b64(secret),
      `https://alice:${encodeURIComponent(secret)}@host/`,
    ];
    for (const f of forms) {
      const out = redact(`error while doing ${f} at line 1`);
      assert.ok(!out.includes(secret) && !out.includes(encodeURIComponent(secret)), `leaked in: ${out}`);
      for (const piece of [b64(secret).slice(0, 12), b64(`alice:${secret}`).slice(0, 12)]) if (f.includes(piece)) assert.ok(!out.includes(piece), out);
    }
    assert.equal(redact("nothing to see"), "nothing to see");
  });
  test("bearer token in every embedded alignment", () => {
    const redact = createRedactor([CANARY]);
    for (const pad of ["", "a", "ab", "abc"]) {
      const enc = Buffer.from(pad + CANARY + "zz").toString("base64");
      assert.ok(!redact(enc).includes(Buffer.from(CANARY).toString("base64").slice(4, 20)) || redact(enc).includes("[REDACTED]"));
      assert.match(redact(`x ${enc} y`), /REDACTED/);
    }
  });
  test("redactError scrubs error messages", () => {
    const redact = createRedactor([CANARY]);
    const msg = redactError(redact, new Error(`connect failed with header Authorization: Bearer ${CANARY}`));
    assert.ok(!msg.includes(CANARY));
    assert.match(msg, /REDACTED/);
  });
  test("audit entries are redacted, sanitised and never hold raw control characters", () => {
    const log = new AuditLog(createRedactor([CANARY]), () => 42);
    log.record({ method: "GET", class: "denied", registry: null, host: `h${CANARY}\r\nX: y`, status: 403, decision: "deny", reason: `bad ${CANARY}` });
    const text = JSON.stringify(log.entries());
    assert.ok(!text.includes(CANARY));
    assert.ok(!/[\r\n]/.test(log.entries()[0]!.host ?? ""));
    assert.equal(log.entries()[0]!.time, 42);
  });
});

describe("config validation (strict)", () => {
  const mutate = (fn: (c: Record<string, unknown>) => void): unknown => {
    const c = goodConfig();
    fn(c);
    return c;
  };
  const reg = (c: Record<string, unknown>): Record<string, unknown> => (c.registries as Record<string, unknown>[])[0]!;
  const bad: [string, unknown][] = [
    ["http upstream", mutate((c) => (reg(c).upstream = "http://registry.example.com"))],
    ["upstream with path", mutate((c) => (reg(c).upstream = "https://registry.example.com/npm"))],
    ["upstream with userinfo", mutate((c) => (reg(c).upstream = "https://u:p@registry.example.com"))],
    ["upstream with query", mutate((c) => (reg(c).upstream = "https://registry.example.com/?a=1"))],
    ["upstream not a url", mutate((c) => (reg(c).upstream = "registry"))],
    ["ftp upstream", mutate((c) => (reg(c).upstream = "ftp://registry.example.com"))],
    ["unknown registry key", mutate((c) => (reg(c).insecure = true))],
    ["unknown top-level key", mutate((c) => (c.allowInsecureUpstream = true))],
    ["__proto__ key", JSON.parse(`{"__proto__":{"x":1},"registries":[],"dns":["1.1.1.1"]}`)],
    ["bad id", mutate((c) => (reg(c).id = "Main Reg"))],
    ["bad prefix traversal", mutate((c) => (reg(c).pathPrefix = "/a/../b"))],
    ["bad prefix trailing slash", mutate((c) => (reg(c).pathPrefix = "/a/"))],
    ["bad prefix encoded", mutate((c) => (reg(c).pathPrefix = "/a%2fb"))],
    ["credential type", mutate((c) => (reg(c).credential = { type: "digest", secret: CANARY }))],
    ["credential short", mutate((c) => (reg(c).credential = { type: "bearer", secret: "x" }))],
    ["basic without colon", mutate((c) => (reg(c).credential = { type: "basic", secret: CANARY }))],
    ["credential extra key", mutate((c) => (reg(c).credential = { type: "bearer", secret: CANARY, header: "x" }))],
    ["no registries", mutate((c) => (c.registries = []))],
    ["duplicate ids", mutate((c) => (c.registries = [reg(c), { ...reg(c), default: true }]))],
    ["two registries, no default", mutate((c) => (c.registries = [reg(c), { id: "two", upstream: "https://b.example.com" }]))],
    ["two defaults", mutate((c) => (c.registries = [{ ...reg(c), default: true }, { id: "two", upstream: "https://b.example.com", default: true }]))],
    ["allowHosts wildcard", mutate((c) => (c.allowHosts = ["*.example.com:443"]))],
    ["allowHosts no port", mutate((c) => (c.allowHosts = ["example.com"]))],
    ["allowHosts uppercase", mutate((c) => (c.allowHosts = ["Example.com:443"]))],
    ["allowHosts port 0", mutate((c) => (c.allowHosts = ["example.com:0"]))],
    ["allowHosts port 99999", mutate((c) => (c.allowHosts = ["example.com:99999"]))],
    ["allowHosts url", mutate((c) => (c.allowHosts = ["https://example.com:443"]))],
    ["package name bad", mutate((c) => (c.packages = { allow: ["../etc"] }))],
    ["package name '-'", mutate((c) => (c.packages = { allow: ["-"] }))],
    ["package uppercase scope slash", mutate((c) => (c.packages = { allow: ["@a/b/c"] }))],
    ["prefix too short", mutate((c) => (c.packages = { allowPrefixes: ["a"] }))],
    ["prefix bad chars", mutate((c) => (c.packages = { allowPrefixes: ["a/../"] }))],
    ["limit not integer", mutate((c) => (c.limits = { maxConcurrent: 1.5 }))],
    ["limit too big", mutate((c) => (c.limits = { maxRedirects: 999 }))],
    ["limit zero concurrency", mutate((c) => (c.limits = { maxConcurrent: 0 }))],
    ["limit string", mutate((c) => (c.limits = { maxResponseBytes: "1000" }))],
    ["unknown limit", mutate((c) => (c.limits = { maxFoo: 1 }))],
    ["no dns", mutate((c) => delete c.dns)],
    ["empty dns", mutate((c) => (c.dns = []))],
    ["dns hostname", mutate((c) => (c.dns = ["dns.google"]))],
    ["listen host name", mutate((c) => (c.listen = { host: "localhost" }))],
    ["listen port", mutate((c) => (c.listen = { port: 70000 }))],
    ["not an object", "config"],
    ["array", []],
    ["null", null],
  ];
  for (const [name, input] of bad) {
    test(`rejects: ${name}`, () => {
      assert.throws(() => parseConfig(input), (e: unknown) => {
        assert.ok(e instanceof ConfigError, String(e));
        assert.ok(!e.message.includes(CANARY), "error must not echo secrets");
        return true;
      });
    });
  }
  test("accepts a full valid config, applies defaults, single registry is default", () => {
    const cfg = parseConfig({
      registries: [{ id: "main", upstream: "https://Registry.Example.com:8443", pathPrefix: "/api/npm/npm-repo", credential: { type: "basic", secret: `bob:${CANARY}` } }],
      allowHosts: ["objects.githubusercontent.com:443"],
      packages: { allow: ["left-pad", "@scope/pkg", "Legacy_Name"], allowPrefixes: ["@bisect/", "tmp-"] },
      limits: { maxConcurrent: 4 },
      dns: ["1.1.1.1", "2606:4700:4700::1111"],
      listen: { cidr: "10.201.5.0/24", port: 3128 },
    });
    assert.equal(cfg.listen.cidr, "10.201.5.0/24");
    assert.equal(cfg.allowClients.length, 1, "the listen range doubles as the default client range");
    const r = cfg.registries[0] as RegistryConfig;
    assert.equal(r.upstreamOrigin, "https://registry.example.com:8443");
    assert.ok(r.isDefault);
    assert.equal(cfg.limits.maxConcurrent, 4);
    assert.equal(cfg.limits.maxUrlLength, DEFAULT_LIMITS.maxUrlLength);
    assert.ok(cfg.allowHosts.has("objects.githubusercontent.com:443"));
  });
  test("a seam or insecure flag cannot come from config", () => {
    for (const key of ["testDial", "allowHttp", "insecure", "__testOnly"]) {
      assert.throws(() => parseConfig({ ...goodConfig(), [key]: true }), ConfigError);
    }
  });
});

const registry = parseConfig({
  registries: [
    { id: "main", default: true, upstream: "https://registry.example.com", pathPrefix: "/api/npm/repo", credential: { type: "bearer", secret: CANARY } },
    { id: "other", upstream: "https://other.example.com", default: false },
  ],
  dns: ["1.1.1.1"],
}).registries;
const main = registry[0] as RegistryConfig;
const defaultRegistry: RegistryConfig = { ...main, isDefault: true };
const other = registry[1] as RegistryConfig;
const routes = [defaultRegistry, other];
const allowed = new Set(["left-pad", "@scope/pkg", "Mixed", "@bisect/one", "prefix-x"]);
const ctx = { registries: routes, limits: { maxUrlLength: 512, maxHeaderBytes: 8192 }, isPackageAllowed: (n: string) => allowed.has(n) };
const okHeaders = ["Host", "proxy:3128", "Accept", "application/json"];
const c = (url: string, method = "GET", headers: readonly string[] = okHeaders): ReturnType<typeof classifyRequest> => classifyRequest({ method, url, rawHeaders: headers }, ctx);

describe("request classification: accepted shapes", () => {
  const accepted: [string, string, string, string][] = [
    ["/left-pad", "packument", "left-pad", "/api/npm/repo/left-pad"],
    ["/@scope%2fpkg", "packument", "@scope/pkg", "/api/npm/repo/@scope%2Fpkg"],
    ["/@scope%2Fpkg", "packument", "@scope/pkg", "/api/npm/repo/@scope%2Fpkg"],
    ["/@scope/pkg", "packument", "@scope/pkg", "/api/npm/repo/@scope%2Fpkg"],
    ["/left-pad/-/left-pad-1.3.0.tgz", "tarball", "left-pad", "/api/npm/repo/left-pad/-/left-pad-1.3.0.tgz"],
    ["/left-pad/-/left-pad-1.0.0-beta.1+build.5.tgz", "tarball", "left-pad", "/api/npm/repo/left-pad/-/left-pad-1.0.0-beta.1+build.5.tgz"],
    ["/@scope/pkg/-/pkg-2.0.0.tgz", "tarball", "@scope/pkg", "/api/npm/repo/@scope/pkg/-/pkg-2.0.0.tgz"],
    ["/@scope%2fpkg/-/pkg-2.0.0.tgz", "tarball", "@scope/pkg", "/api/npm/repo/@scope/pkg/-/pkg-2.0.0.tgz"],
    ["/left%2dpad", "packument", "left-pad", "/api/npm/repo/left-pad"],
    ["/Mixed", "packument", "Mixed", "/api/npm/repo/Mixed"],
  ];
  for (const [url, cls, name, path] of accepted) {
    test(`accepts ${url}`, () => {
      const v = c(url);
      assert.ok(v.ok, JSON.stringify(v));
      assert.equal(v.class, cls);
      assert.equal(v.name, name);
      assert.equal(v.upstreamPath, path);
    });
  }
  test("HEAD is accepted", () => {
    const v = c("/left-pad", "HEAD");
    assert.ok(v.ok && v.method === "HEAD");
  });
  test("non-default registry is routed by id prefix, default takes the rest", () => {
    const v = c("/_r/other/left-pad");
    assert.ok(v.ok);
    assert.equal(v.registry.id, "other");
    assert.equal(v.upstreamPath, "/left-pad");
    const d = c("/left-pad");
    assert.ok(d.ok);
    assert.equal(d.registry.id, "main");
  });
});

describe("request classification: rejected (path/URL normalisation fuzz table)", () => {
  const cases: [string, string, number][] = [
    // traversal, in every encoding
    ["/..", "traversal", 400],
    ["/../etc/passwd", "traversal", 400],
    ["/%2e%2e/etc/passwd", "traversal", 400],
    ["/%2E%2E/", "empty-segment", 400],
    ["/%2e%2e", "traversal", 400],
    ["/.%2e", "traversal", 400],
    ["/%2e.", "traversal", 400],
    ["/left-pad/../../x", "traversal", 400],
    ["/left-pad/%2e%2e/%2e%2e/x", "traversal", 400],
    ["/.", "traversal", 400],
    ["/left-pad/./x", "traversal", 400],
    ["/%2e", "traversal", 400],
    // double encoding
    ["/%252e%252e", "double-encoding", 400],
    ["/%252e%252e%252fetc", "double-encoding", 400],
    ["/left%252dpad", "double-encoding", 400],
    ["/%25", "double-encoding", 400],
    ["/%2525", "double-encoding", 400],
    // encoded slash tricks
    ["/left-pad%2f..%2fx", "encoded-slash", 400],
    ["/left%2fpad", "encoded-slash", 400],
    ["/%2fleft-pad", "encoded-slash", 400],
    ["/@scope%2f%2fpkg", "encoded-slash", 400],
    ["/@scope%2fa%2fb", "encoded-slash", 400],
    ["/@scope%2f", "encoded-slash", 400],
    ["/%2f%2f", "encoded-slash", 400],
    ["/left-pad%2F", "encoded-slash", 400],
    // backslashes
    ["/left-pad\\..\\x", "bad-characters", 400],
    ["/%5cleft-pad", "bad-characters", 400],
    ["/left-pad%5c..%5cx", "bad-characters", 400],
    ["/%5C", "bad-characters", 400],
    // NUL, control, whitespace, DEL, non-ASCII
    ["/left-pad%00", "bad-characters", 400],
    ["/left-pad\u0000", "bad-characters", 400],
    ["/left-pad\r\nX-Injected: 1", "bad-characters", 400],
    ["/left-pad%0d%0aX-Injected:%201", "bad-characters", 400],
    ["/left-pad%0a", "bad-characters", 400],
    ["/left pad", "bad-characters", 400],
    ["/left-pad%20", "bad-characters", 400],
    ["/left-pad%7f", "bad-characters", 400],
    ["/left-pad\t", "bad-characters", 400],
    ["/lëft-pad", "bad-characters", 400],
    ["/left-pad%c3%a9", "bad-characters", 400],
    ["/left-pad‮", "bad-characters", 400],
    ["/%ef%bc%8f", "bad-characters", 400],
    ["/left-pad／..", "bad-characters", 400],
    ["/․․", "bad-characters", 400],
    ["/left-pad%e2%80%8b", "bad-characters", 400],
    // malformed percent
    ["/%", "bad-percent-encoding", 400],
    ["/%zz", "bad-percent-encoding", 400],
    ["/left-pad%2", "bad-percent-encoding", 400],
    ["/%c0%ae%c0%ae", "bad-percent-encoding", 400],
    ["/%e0%80%af", "bad-percent-encoding", 400],
    // form of the target
    ["http://registry.example.com/left-pad", "not-origin-form", 400],
    ["https://evil.test/left-pad", "not-origin-form", 400],
    ["//evil.test/left-pad", "not-origin-form", 400],
    ["*", "not-origin-form", 400],
    ["left-pad", "not-origin-form", 400],
    ["", "missing-url", 400],
    ["/", "empty-segment", 400],
    ["//", "not-origin-form", 400],
    ["/left-pad/", "empty-segment", 400],
    ["/left-pad//x", "empty-segment", 400],
    ["/left-pad#frag", "fragment-not-allowed", 400],
    // query strings (covert channel)
    ["/left-pad?write=true", "query-not-allowed", 403],
    ["/left-pad?", "query-not-allowed", 403],
    ["/left-pad/-/left-pad-1.0.0.tgz?x=y", "query-not-allowed", 403],
    // npm API surface
    ["/-/npm/v1/tokens", "npm-api-path", 403],
    ["/-/npm/v1/tokens/token/abc", "npm-api-path", 403],
    ["/-/user/org.couchdb.user:x", "npm-api-path", 403],
    ["/-/whoami", "npm-api-path", 403],
    ["/-/v1/search", "npm-api-path", 403],
    ["/-/package/left-pad/dist-tags", "npm-api-path", 403],
    ["/-/package/left-pad/dist-tags/latest", "npm-api-path", 403],
    ["/-/npm/v1/security/advisories/bulk", "npm-api-path", 403],
    ["/%2d/whoami", "npm-api-path", 403],
    ["/-", "npm-api-path", 403],
    ["/-rev/x", "npm-api-path", 403],
    // other package paths
    ["/left-pad/1.0.0", "path-not-allowed", 403],
    ["/left-pad/latest", "path-not-allowed", 403],
    ["/left-pad/dist-tags", "path-not-allowed", 403],
    ["/left-pad/-rev/1-abc", "path-not-allowed", 403],
    ["/left-pad/-/left-pad.tgz", "path-not-allowed", 403],
    ["/left-pad/-/left-pad-1.0.tgz", "path-not-allowed", 403],
    ["/left-pad/-/left-pad-1.0.0.tar", "path-not-allowed", 403],
    ["/left-pad/-/other-1.0.0.tgz", "path-not-allowed", 403],
    ["/left-pad/-/left-pad-1.0.0.tgz/extra", "path-not-allowed", 403],
    ["/left-pad/-/-/left-pad-1.0.0.tgz", "path-not-allowed", 403],
    ["/left-pad/x/left-pad-1.0.0.tgz", "path-not-allowed", 403],
    ["/left-pad/-/left-pad-1.0.0.tgz%2f..", "encoded-slash", 400],
    ["/left-pad/-/left-pad-1.0.0-.tgz", "path-not-allowed", 403],
    ["/@scope", "invalid-package-name", 403],
    ["/@scope/", "empty-segment", 400],
    ["/@scope/pkg/-/other-2.0.0.tgz", "path-not-allowed", 403],
    ["/@scope/pkg/-/@scope/pkg-2.0.0.tgz", "path-not-allowed", 403],
    ["/@/pkg", "invalid-package-name", 403],
    // names
    ["/left-pad.", "package-not-allowlisted", 403],
    ["/.hidden", "invalid-package-name", 403],
    ["/_private", "invalid-package-name", 403],
    ["/node_modules", "package-not-allowlisted", 403],
    ["/@@scope/pkg", "invalid-package-name", 403],
    ["/left-pad@1.0.0", "invalid-package-name", 403],
    ["/left,pad", "invalid-package-name", 403],
    ["/left:pad", "invalid-package-name", 403],
    // allowlist (case sensitive, exact, no prefixes unless configured)
    ["/LEFT-PAD", "package-not-allowlisted", 403],
    ["/Left-Pad", "package-not-allowlisted", 403],
    ["/mixed", "package-not-allowlisted", 403],
    ["/@Scope/pkg", "package-not-allowlisted", 403],
    ["/@scope/PKG", "package-not-allowlisted", 403],
    ["/lodash", "package-not-allowlisted", 403],
    ["/left-pad-evil", "package-not-allowlisted", 403],
    ["/left-pa", "package-not-allowlisted", 403],
    ["/@scope/pkg2", "package-not-allowlisted", 403],
    ["/%6c%65%66%74%2d%70%61%64x", "package-not-allowlisted", 403],
  ];
  for (const [url, reason, status] of cases) {
    test(`rejects ${JSON.stringify(url)} -> ${reason}`, () => {
      const v = c(url);
      assert.equal(v.ok, false, JSON.stringify(v));
      if (!v.ok) {
        assert.equal(v.reason, reason);
        assert.equal(v.status, status);
      }
    });
  }
  test("overlong URL", () => {
    const v = c(`/${"a".repeat(600)}`);
    assert.ok(!v.ok && v.status === 414);
    const v2 = c(`/left-pad/-/left-pad-1.0.0.tgz`, "GET");
    assert.ok(v2.ok);
    assert.ok(!c(`/${"a".repeat(511)}`).ok);
    assert.ok(!c(`/${"a".repeat(513)}`).ok);
  });
  test("a 214+ char package name is refused even inside the URL limit", () => {
    const v = classifyRequest({ method: "GET", url: `/${"a".repeat(215)}`, rawHeaders: okHeaders }, { ...ctx, limits: { maxUrlLength: 2048, maxHeaderBytes: 8192 }, isPackageAllowed: () => true });
    assert.ok(!v.ok && v.reason === "invalid-package-name");
  });
  test("methods other than GET/HEAD", () => {
    for (const m of ["PUT", "POST", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT", "get", "Get", "PROPFIND", "", "GET "]) {
      const v = c("/left-pad", m);
      assert.ok(!v.ok && v.status === 405 && v.reason === "method-not-allowed", m);
    }
    assert.ok(!classifyRequest({ method: undefined, url: "/left-pad", rawHeaders: okHeaders }, ctx).ok);
    assert.ok(!classifyRequest({ method: "GET", url: undefined, rawHeaders: okHeaders }, ctx).ok);
  });
});

describe("header block validation (injection, smuggling)", () => {
  const cases: [string, readonly string[], string | undefined][] = [
    ["ok", ["Host", "p:1", "Accept", "*/*"], undefined],
    ["missing host", ["Accept", "*/*"], "missing-host"],
    ["duplicate host", ["Host", "a", "host", "b"], "duplicate-host"],
    ["duplicate host same value", ["Host", "a", "Host", "a"], "duplicate-host"],
    ["duplicate content-length", ["Host", "a", "Content-Length", "0", "content-length", "5"], "duplicate-content-length"],
    ["duplicate content-length equal", ["Host", "a", "Content-Length", "0", "Content-Length", "0"], "duplicate-content-length"],
    ["duplicate transfer-encoding", ["Host", "a", "Transfer-Encoding", "chunked", "Transfer-Encoding", "chunked"], "duplicate-transfer-encoding"],
    ["CL+TE", ["Host", "a", "Content-Length", "5", "Transfer-Encoding", "chunked"], "conflicting-length-headers"],
    ["CL 0 + TE", ["Host", "a", "Content-Length", "0", "Transfer-Encoding", "chunked"], "conflicting-length-headers"],
    ["TE alone", ["Host", "a", "Transfer-Encoding", "chunked"], "request-body-not-allowed"],
    ["TE identity", ["Host", "a", "transfer-encoding", "identity"], "request-body-not-allowed"],
    ["CL body on GET", ["Host", "a", "Content-Length", "5"], "request-body-not-allowed"],
    ["CL with plus", ["Host", "a", "Content-Length", "+0"], "request-body-not-allowed"],
    ["CL list", ["Host", "a", "Content-Length", "0, 0"], "request-body-not-allowed"],
    ["CL 0 ok", ["Host", "a", "Content-Length", "0"], undefined],
    ["CR in value", ["Host", "a", "X-A", "b\rInjected: 1"], "bad-header-value"],
    ["LF in value", ["Host", "a", "X-A", "b\nInjected: 1"], "bad-header-value"],
    ["NUL in value", ["Host", "a", "X-A", "b\u0000c"], "bad-header-value"],
    ["space in name", ["Host", "a", "X A", "b"], "bad-header-name"],
    ["colon in name", ["Host", "a", "X:A", "b"], "bad-header-name"],
    ["name with newline", ["Host", "a", "X\nA", "b"], "bad-header-name"],
    ["empty name", ["Host", "a", "", "b"], "bad-header-name"],
    ["TE with trailing space name", ["Host", "a", "Transfer-Encoding ", "chunked"], "bad-header-name"],
    ["host with @", ["Host", "evil.com@good.com"], "bad-host-header"],
    ["host with slash", ["Host", "a/b"], "bad-host-header"],
    ["host with space", ["Host", "a b"], "bad-host-header"],
    ["host empty", ["Host", ""], "bad-host-header"],
    ["odd count", ["Host", "a", "X"], "malformed-headers"],
  ];
  for (const [name, headers, expected] of cases) {
    test(name, () => assert.equal(checkHeaderBlock(headers, 8192), expected));
  }
  test("header block over the size limit", () => {
    assert.equal(checkHeaderBlock(["Host", "a", "X-Big", "v".repeat(9000)], 8192), "headers-too-large");
  });
  test("classifyRequest applies it (smuggling never classifies)", () => {
    const v = c("/left-pad", "GET", ["Host", "a", "Content-Length", "5", "Transfer-Encoding", "chunked"]);
    assert.ok(!v.ok && v.reason === "conflicting-length-headers");
  });
});

describe("header policy", () => {
  const target = new URL("https://registry.example.com/api/npm/repo/left-pad");
  const client = {
    accept: "application/vnd.npm.install-v1+json",
    "accept-encoding": "gzip, deflate",
    "user-agent": "npm/10.1.0 node/v24.0.0 linux x64\r\nX-Evil: 1",
    authorization: "Bearer attacker-supplied",
    cookie: "a=b",
    "proxy-authorization": "Basic eA==",
    "proxy-connection": "keep-alive",
    forwarded: "for=1.2.3.4",
    "x-forwarded-for": "1.2.3.4",
    "x-forwarded-host": "evil.test",
    "x-real-ip": "1.2.3.4",
    referer: `install ${CANARY}`,
    "npm-command": "install",
    "npm-session": "abcdef",
    "npm-scope": "@scope",
    "pacote-req-type": "packument",
    "x-custom-exfil": "secret-data",
    connection: "keep-alive, X-Foo",
    "x-foo": "bar",
    host: "proxy:3128",
    "content-length": "0",
    "transfer-encoding": "chunked",
    "if-none-match": '"abc"',
  };
  test("only allowlisted headers survive, client auth/cookie/proxy/forwarded stripped", () => {
    const h = buildUpstreamHeaders(client, target, { registry: main, tainted: false });
    assert.deepEqual(Object.keys(h).sort(), ["accept", "accept-encoding", "authorization", "connection", "host", "if-none-match", "npm-command", "pacote-req-type", "user-agent"].sort());
    assert.equal(h.authorization, `Bearer ${CANARY}`, "credential is the proxy's, not the client's");
    assert.equal(h.host, "registry.example.com");
    assert.ok(!/[\r\n]/.test(h["user-agent"] as string));
    assert.ok(!JSON.stringify(h).includes("attacker-supplied"));
  });
  test("client Authorization is never forwarded even without a configured credential", () => {
    const h = buildUpstreamHeaders(client, target, { registry: other, tainted: false });
    assert.equal(h.authorization, undefined);
    assert.ok(!Object.keys(h).some((k) => /cookie|proxy|forward|x-/.test(k)));
  });
  test("credential only for the matching origin (suffix/port/scheme/userinfo lookalikes)", () => {
    const lookalikes = [
      "https://registry.example.com.evil.net/x",
      "https://evilregistry.example.com/x",
      "https://registry.example.com:8443/x",
      "https://registry.example.co/x",
      "https://sub.registry.example.com/x",
      "http://registry.example.com/x",
      "https://registry.example.com@evil.net/x",
      "https://REGISTRY.EXAMPLE.COM.evil.net/x",
      "https://xregistry.example.com/x",
    ];
    for (const u of lookalikes) {
      const h = buildUpstreamHeaders({}, new URL(u), { registry: main, tainted: false });
      assert.equal(h.authorization, undefined, u);
    }
    assert.equal(buildUpstreamHeaders({}, new URL("https://registry.example.com:443/x"), { registry: main, tainted: false }).authorization, `Bearer ${CANARY}`);
    assert.equal(buildUpstreamHeaders({}, new URL("https://REGISTRY.example.com/y"), { registry: main, tainted: false }).authorization, `Bearer ${CANARY}`);
  });
  test("once tainted by a cross-origin hop the credential never returns, even back at the origin", () => {
    const h = buildUpstreamHeaders({}, target, { registry: main, tainted: true });
    assert.equal(h.authorization, undefined);
  });
  test("user-agent sanitisation", () => {
    assert.equal(sanitiseUserAgent("npm/10.1.0 node/v24"), "npm/10.1.0 node/v24");
    assert.equal(sanitiseUserAgent(undefined), "ratchet-registry-proxy");
    assert.equal(sanitiseUserAgent("\r\n\u0000<>\"'"), "ratchet-registry-proxy");
    assert.equal(sanitiseUserAgent("x".repeat(500)).length, 100);
    assert.equal(sanitiseUserAgent(["a", "b"]), "ratchet-registry-proxy");
  });
  test("odd header values are dropped, not forwarded", () => {
    const h = buildUpstreamHeaders({ accept: "a\r\nb", "npm-command": "install; rm -rf /", "accept-encoding": "x".repeat(300), "if-none-match": ["a", "b"] as never }, target, { registry: main, tainted: false });
    assert.equal(h.accept, undefined);
    assert.equal(h["npm-command"], undefined);
    assert.equal(h["accept-encoding"], "identity");
    assert.equal(h["if-none-match"], undefined);
  });
});

describe("redirect policy", () => {
  const origin = "https://registry.example.com";
  const cur = new URL(`${origin}/api/npm/repo/left-pad/-/left-pad-1.0.0.tgz`);
  const state = (over: object = {}): Parameters<typeof decideRedirect>[2] => ({
    registryOrigin: origin,
    allowHosts: new Set(["cdn.example.net:443", "cdn.example.net:8443"]),
    maxRedirects: 3,
    visited: [cur.href],
    ...over,
  });
  const follow = (loc: string | undefined, s = state()): ReturnType<typeof decideRedirect> => decideRedirect(cur, loc, s);

  test("same-origin absolute", () => {
    const d = follow(`${origin}/other/path.tgz`);
    assert.ok(d.action === "follow" && !d.crossOrigin && d.url.href === `${origin}/other/path.tgz`);
  });
  test("relative forms resolve against the current URL and stay same-origin", () => {
    for (const [loc, want] of [
      ["/abs/x.tgz", `${origin}/abs/x.tgz`],
      ["x.tgz", `${origin}/api/npm/repo/left-pad/-/x.tgz`],
      ["../y.tgz", `${origin}/api/npm/repo/left-pad/y.tgz`],
      ["?sig=1", `${origin}/api/npm/repo/left-pad/-/left-pad-1.0.0.tgz?sig=1`],
    ] as const) {
      const d = follow(loc);
      assert.ok(d.action === "follow" && !d.crossOrigin, loc);
      assert.equal((d as { url: URL }).url.href, want);
    }
  });
  test("cross-origin to an allowlisted host: follow, flagged cross-origin (credentials dropped)", () => {
    const d = follow("https://cdn.example.net/blob/abc");
    assert.ok(d.action === "follow" && d.crossOrigin);
    const d2 = follow("https://cdn.example.net:8443/blob/abc");
    assert.ok(d2.action === "follow" && d2.crossOrigin);
  });
  test("protocol-relative to an allowlisted host is cross-origin", () => {
    const d = follow("//cdn.example.net/blob");
    assert.ok(d.action === "follow" && d.crossOrigin);
  });
  const denied: [string, string | undefined, number, string][] = [
    ["cross-origin not allowlisted", "https://evil.example.org/x", 403, "redirect-host-not-allowed"],
    ["allowlisted host wrong port", "https://cdn.example.net:9999/x", 403, "redirect-host-not-allowed"],
    ["suffix lookalike", `${origin}.evil.net/x`, 403, "redirect-host-not-allowed"],
    ["prefix lookalike", "https://evilregistry.example.com/x", 403, "redirect-host-not-allowed"],
    ["subdomain", "https://sub.registry.example.com/x", 403, "redirect-host-not-allowed"],
    ["same host other port", "https://registry.example.com:8443/x", 403, "redirect-host-not-allowed"],
    ["userinfo trick", "https://registry.example.com@evil.example.org/x", 403, "redirect-userinfo"],
    ["userinfo present", "https://user:pw@cdn.example.net/x", 403, "redirect-userinfo"],
    ["https to http downgrade", "http://registry.example.com/x", 403, "redirect-not-https"],
    ["http on allowlisted host", "http://cdn.example.net/x", 403, "redirect-not-https"],
    ["ftp", "ftp://cdn.example.net/x", 403, "redirect-not-https"],
    ["javascript", "javascript:alert(1)", 403, "redirect-not-https"],
    ["data", "data:text/plain,hi", 403, "redirect-not-https"],
    ["file", "file:///etc/passwd", 403, "redirect-not-https"],
    ["missing", undefined, 502, "bad-redirect-location"],
    ["empty", "", 502, "bad-redirect-location"],
    ["CRLF", `${origin}/x\r\nSet-Cookie: a=b`, 502, "bad-redirect-location"],
    ["backslash", "https:\\\\evil.example.org\\x", 502, "bad-redirect-location"],
    ["NUL", `${origin}/x\u0000`, 502, "bad-redirect-location"],
    ["too long", `${origin}/${"a".repeat(3000)}`, 502, "bad-redirect-location"],
    ["self loop", cur.href, 508, "redirect-loop"],
  ];
  for (const [name, loc, status, reason] of denied) {
    test(`denies: ${name}`, () => {
      const d = follow(loc);
      assert.ok(d.action === "deny", JSON.stringify(d));
      assert.equal(d.status, status);
      assert.equal(d.reason, reason);
    });
  }
  test("hop limit", () => {
    const visited = [cur.href, `${origin}/a`, `${origin}/b`, `${origin}/c`];
    const d = follow(`${origin}/d`, state({ visited }));
    assert.ok(d.action === "deny" && d.reason === "redirect-limit");
    assert.ok(follow(`${origin}/d`, state({ visited: visited.slice(0, 3) })).action === "follow");
    assert.ok(decideRedirect(cur, `${origin}/d`, state({ maxRedirects: 0 })).action === "deny");
  });
  test("A -> B -> A loop is detected across hops (fragment ignored)", () => {
    const b = `${origin}/b`;
    const d = follow(`${origin}/api/npm/repo/left-pad/-/left-pad-1.0.0.tgz#x`, state({ visited: [cur.href, b] }));
    assert.ok(d.action === "deny" && d.reason === "redirect-loop");
  });
});
