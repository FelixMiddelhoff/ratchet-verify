import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { proxyRegistryUrl, rewriteNpmrc } from "../../src/sandbox/proxy-topology/index.js";

const PROXY = "http://ratchet-proxy-1a2b3c4d:3128";
const TOKEN = "npm_SUPERSECRETTOKEN0123456789";

describe("rewriteNpmrc", () => {
  test("drops every registry, auth and network setting; keeps behavioural ones", () => {
    const project = [
      "# team settings",
      "registry=https://registry.corp.example/",
      "@acme:registry=https://npm.pkg.github.com/",
      `//registry.corp.example/:_authToken=${TOKEN}`,
      "//npm.pkg.github.com/:_authToken=${GH_TOKEN}",
      `_auth=${TOKEN}`,
      "always-auth=true",
      "https-proxy=http://evil.example:8080",
      "cafile=/etc/ssl/corp.pem",
      "legacy-peer-deps=true",
      "engine-strict=true",
    ].join("\n");
    const out = rewriteNpmrc(project, PROXY, [{ id: "main", isDefault: true }, { id: "gh", isDefault: false, scopes: ["@acme"] }]);
    assert.ok(!out.text.includes(TOKEN) && !out.text.includes("evil.example") && !out.text.includes("corp.example") && !out.text.includes("GH_TOKEN"));
    assert.ok(out.text.includes("legacy-peer-deps=true") && out.text.includes("engine-strict=true") && out.text.includes("# team settings"));
    assert.ok(out.text.includes(`registry=${PROXY}/\n`));
    assert.ok(out.text.includes(`@acme:registry=${PROXY}/_r/gh/`));
    assert.ok(out.text.includes("replace-registry-host=always"));
    assert.deepEqual(out.dropped, ["registry", "@acme:registry", "//<host>/:_authToken", "//<host>/:_authToken", "_auth", "always-auth", "https-proxy", "cafile"]);
    assert.ok(!out.dropped.join(" ").includes(TOKEN));
  });

  test("case, spacing and CRLF cannot smuggle a setting through", () => {
    const out = rewriteNpmrc(`Registry = https://x.example/\r\n  _AuthToken=${TOKEN}\r\n//h/:_AUTHTOKEN=${TOKEN}\r\nfoo=bar\r\n`, PROXY, [{ id: "m", isDefault: true }]);
    assert.ok(!out.text.includes("x.example") && !out.text.includes(TOKEN));
    assert.ok(out.text.includes("foo=bar"));
  });

  test("no project file: only the proxy settings", () => {
    const out = rewriteNpmrc(undefined, PROXY, [{ id: "m", isDefault: true }]);
    assert.equal(out.text, `registry=${PROXY}/\nreplace-registry-host=always\naudit=false\nfund=false\n`);
    assert.deepEqual(out.dropped, []);
  });

  test("exactly one default registry", () => {
    assert.throws(() => rewriteNpmrc("", PROXY, []), /exactly one default/);
    assert.throws(() => rewriteNpmrc("", PROXY, [{ id: "a" }, { id: "b" }]), /exactly one default/);
  });

  test("non-default registries live under /_r/<id>/", () => {
    assert.equal(proxyRegistryUrl(`${PROXY}/`, { id: "gh", isDefault: false }), `${PROXY}/_r/gh/`);
    assert.equal(proxyRegistryUrl(PROXY, { id: "main", isDefault: true }), `${PROXY}/`);
  });
});
