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

import { rewriteYarnrcBerry, rewriteYarnrcClassic } from "../../src/sandbox/proxy-topology/index.js";

describe("rewriteYarnrcClassic", () => {
  test("drops registry/auth/network lines, keeps the rest, appends the proxy", () => {
    const out = rewriteYarnrcClassic(
      [`registry "https://registry.corp.example/"`, `"@acme:registry" "https://npm.pkg.github.com/"`, `_authToken "${TOKEN}"`, `yarn-path ".yarn/releases/yarn-1.22.js"`, `# note`, `"--install.frozen-lockfile" true`].join("\n"),
      PROXY,
      [{ id: "main", isDefault: true }, { id: "gh", isDefault: false, scopes: ["@acme"] }],
    );
    assert.ok(!out.text.includes(TOKEN) && !out.text.includes("corp.example") && !out.text.includes("github.com"));
    assert.ok(out.text.includes("yarn-path") && out.text.includes("--install.frozen-lockfile") && out.text.includes("# note"));
    assert.ok(out.text.includes(`registry "${PROXY}/"`) && out.text.includes(`"@acme:registry" "${PROXY}/_r/gh/"`));
    assert.deepEqual(out.dropped, ["registry", "@acme:registry", "_authtoken"]);
  });
});

describe("rewriteYarnrcBerry", () => {
  test("removes owned top-level keys with their blocks, keeps others, appends the proxy and whitelists its host", () => {
    const yml = [
      "nodeLinker: node-modules",
      `npmRegistryServer: "https://registry.corp.example"`,
      "npmScopes:",
      "  acme:",
      "    npmRegistryServer: https://npm.pkg.github.com",
      `    npmAuthToken: ${TOKEN}`,
      "",
      `npmAuthToken: ${TOKEN}`,
      "plugins:",
      "  - path: .yarn/plugins/x.cjs",
      "httpsProxy: http://evil.example:8080",
      "yarnPath: .yarn/releases/yarn-4.js",
    ].join("\n");
    const out = rewriteYarnrcBerry(yml, PROXY, [{ id: "main", isDefault: true }, { id: "gh", isDefault: false, scopes: ["@acme"] }]);
    assert.ok(!out.text.includes(TOKEN) && !out.text.includes("corp.example") && !out.text.includes("github.com") && !out.text.includes("evil.example"));
    for (const keep of ["nodeLinker: node-modules", "plugins:", "  - path: .yarn/plugins/x.cjs", "yarnPath: .yarn/releases/yarn-4.js"]) assert.ok(out.text.includes(keep), keep);
    assert.ok(out.text.includes(`npmRegistryServer: "${PROXY}/"`) && out.text.includes(`npmRegistryServer: "${PROXY}/_r/gh/"`));
    assert.ok(out.text.includes('- "ratchet-proxy-1a2b3c4d"'));
    assert.deepEqual(out.dropped, ["npmRegistryServer", "npmScopes", "npmAuthToken", "httpsProxy"]);
  });

  test("no project file", () => {
    const out = rewriteYarnrcBerry(undefined, PROXY, [{ id: "m", isDefault: true }]);
    assert.equal(out.text, `npmRegistryServer: "${PROXY}/"\nunsafeHttpWhitelist:\n  - "ratchet-proxy-1a2b3c4d"\nenableTelemetry: false\n`);
  });
});

import { PUBLIC_REGISTRY_ALIASES, rewriteLockfileUrls } from "../../src/sandbox/proxy-topology/index.js";

describe("rewriteLockfileUrls", () => {
  const maps = [
    ...PUBLIC_REGISTRY_ALIASES.map((from) => ({ from, to: `${PROXY}/` })),
    { from: "https://npm.corp.example/api/npm/repo", to: `${PROXY}/_r/corp` },
  ];
  test("yarn classic resolved, pnpm tarball and berry archiveUrl all move to the proxy; hashes stay", () => {
    const lock = [
      `  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#5b8a3a7765dfe001261dde915589e782f8c94d1e"`,
      "  integrity sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
      `      tarball: https://registry.npmjs.org/x/-/x-1.0.0.tgz`,
      `  resolution: "a@npm:1.0.0::__archiveUrl=${encodeURIComponent("https://npm.corp.example/api/npm/repo/a/-/a-1.0.0.tgz")}"`,
    ].join("\n");
    const out = rewriteLockfileUrls(lock, maps);
    assert.equal(out.replaced, 3);
    assert.ok(out.text.includes(`resolved "${PROXY}/left-pad/-/left-pad-1.3.0.tgz#5b8a3a7765dfe001261dde915589e782f8c94d1e"`));
    assert.ok(out.text.includes(`tarball: ${PROXY}/x/-/x-1.0.0.tgz`));
    assert.ok(out.text.includes(encodeURIComponent(`${PROXY}/_r/corp/a/-/a-1.0.0.tgz`)));
    assert.ok(out.text.includes("integrity sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA=="));
    assert.ok(!out.text.includes("registry.yarnpkg.com") && !out.text.includes("npm.corp.example"));
  });

  test("unrelated hosts are left alone", () => {
    const lock = `  resolved "https://evil.example/registry.npmjs.org/x.tgz"`;
    assert.equal(rewriteLockfileUrls(lock, maps).replaced, 0);
  });
});

import { allowedPackageNames } from "../../src/sandbox/proxy-topology/index.js";

describe("allowedPackageNames", () => {
  test("union of both lockfile states and manifest names, sorted, deduplicated", () => {
    const lock = (pk: Record<string, string>) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...Object.fromEntries(Object.entries(pk).map(([k, v]) => [`node_modules/${k}`, { version: v }])) } });
    const names = allowedPackageNames([lock({ a: "1.0.0", "@s/b": "1.0.0" }), lock({ a: "2.0.0", c: "1.0.0" })], ["d", "a"]);
    assert.deepEqual(names, ["@s/b", "a", "c", "d"]);
  });
});
