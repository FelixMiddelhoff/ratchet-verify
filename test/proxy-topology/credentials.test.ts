import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CredentialSourceError, sourceRegistries } from "../../src/sandbox/proxy-topology/index.js";
import { secretForms } from "../../src/sandbox/registry-proxy/index.js";

const TOKEN = "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

describe("sourceRegistries", () => {
  test("default and scoped registries with the matching credentials, nothing else", () => {
    const project = ["registry=https://npm.corp.example/api/npm/repo/", `//npm.corp.example/api/npm/repo/:_authToken=\${CORP_TOKEN}`, "@acme:registry=https://npm.pkg.github.com/", "//npm.pkg.github.com/:_authToken=${GH_TOKEN}", "proxy=http://evil.example"].join("\n");
    const user = `//registry.npmjs.org/:_authToken=${TOKEN}\n`;
    const r = sourceRegistries([project, user], { CORP_TOKEN: TOKEN, GH_TOKEN: GH, UNRELATED: "x" });
    assert.deepEqual(r.registries.map((x) => [x.id, x.upstream, x.pathPrefix, x.isDefault, x.credential?.type]), [
      ["main", "https://npm.corp.example", "/api/npm/repo", true, "bearer"],
      ["r1", "https://npm.pkg.github.com", undefined, false, "bearer"],
    ]);
    assert.deepEqual(r.client, [{ id: "main", isDefault: true }, { id: "r1", isDefault: false, scopes: ["@acme"] }]);
    assert.deepEqual(r.upstreamPrefixes, [{ id: "main", prefix: "https://npm.corp.example/api/npm/repo/" }, { id: "r1", prefix: "https://npm.pkg.github.com/" }]);
    const text = JSON.stringify(r.notes);
    for (const f of [...secretForms(TOKEN), ...secretForms(GH), "evil.example"]) assert.ok(!text.includes(f));
  });

  test("project file beats user file; the public registry is the default when none is set", () => {
    const r = sourceRegistries([`registry=https://a.example/\n//a.example/:_authToken=${TOKEN}`, "registry=https://b.example/"], {});
    assert.equal(r.registries[0]!.upstream, "https://a.example");
    const pub = sourceRegistries([], {});
    assert.equal(pub.registries[0]!.upstream, "https://registry.npmjs.org");
    assert.equal(pub.registries[0]!.credential, undefined);
  });

  test("longest nerf-dart prefix wins; basic auth forms", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const r = sourceRegistries([`registry=https://h.example/a/b/\n//h.example/:_authToken=${TOKEN}\n//h.example/a/:_auth=${b64("user:secretpass1")}`], {});
    assert.equal(r.registries[0]!.credential!.type, "basic");
    assert.equal(r.registries[0]!.credential!.authorization(), `Basic ${b64("user:secretpass1")}`);
    const u = sourceRegistries([`registry=https://h.example/\n//h.example/:username=bob\n//h.example/:_password=${b64("pw-pw-pw-pw")}`], {});
    assert.equal(u.registries[0]!.credential!.authorization(), `Basic ${b64("bob:pw-pw-pw-pw")}`);
  });

  test("unset ${VAR} is an error naming the variable, never an empty token; http and credentials in URLs are refused", () => {
    assert.throws(() => sourceRegistries(["registry=https://a.example/\n//a.example/:_authToken=${NOPE_TOKEN}"], {}), (e: unknown) => e instanceof CredentialSourceError && /NOPE_TOKEN/.test(e.message));
    assert.throws(() => sourceRegistries(["registry=${NOPE_URL}"], {}), /NOPE_URL/);
    assert.throws(() => sourceRegistries(["registry=http://a.example/"], {}), /https/);
    assert.throws(() => sourceRegistries([`registry=https://user:${TOKEN}@a.example/`], {}), (e: unknown) => e instanceof CredentialSourceError && !e.message.includes(TOKEN));
  });

  test("a scope on the default registry's own URL does not create a second registry", () => {
    const r = sourceRegistries(["registry=https://a.example/\n@x:registry=https://a.example/"], {});
    assert.equal(r.registries.length, 1);
    assert.deepEqual(r.client, [{ id: "main", isDefault: true, scopes: ["@x"] }]);
  });

  test("privateHosts opt one registry host into private addresses, others stay guarded", () => {
    const r = sourceRegistries(["registry=https://10.0.0.5/\n@x:registry=https://other.example/"], {}, ["10.0.0.5"]);
    assert.deepEqual(r.registries.map((x) => [x.upstream, x.allowPrivateAddresses]), [["https://10.0.0.5", true], ["https://other.example", undefined]]);
  });
});
