import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sourceRegistries, yarnrcToNpmrc } from "../../src/sandbox/proxy-topology/index.js";

const TOKEN = "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const YML = [
  "nodeLinker: node-modules",
  'npmRegistryServer: "https://npm.corp.example/api/npm/repo/"',
  "npmAuthToken: ${CORP_TOKEN}  # from the environment",
  "npmScopes:",
  "  acme:",
  '    npmRegistryServer: "https://npm.pkg.github.com"',
  "    npmAuthToken: ${GH_TOKEN}",
  "  plain:",
  '    npmAuthIdent: "bob:secret"',
  "npmRegistries:",
  "  //extra.example/path:",
  "    npmAuthToken: extra-token",
  "unsafeHttpWhitelist:",
  "  - evil.example",
  "",
].join("\n");

describe("yarnrcToNpmrc (yarn berry credential source)", () => {
  test("registries, scopes and per-registry auth become npmrc lines, other keys are ignored", () => {
    const rc = yarnrcToNpmrc(YML);
    assert.match(rc, /^registry=https:\/\/npm\.corp\.example\/api\/npm\/repo\/$/m);
    assert.match(rc, /^\/\/npm\.corp\.example\/api\/npm\/repo\/:_authToken=\$\{CORP_TOKEN\}$/m);
    assert.match(rc, /^@acme:registry=https:\/\/npm\.pkg\.github\.com$/m);
    assert.match(rc, /^\/\/npm\.pkg\.github\.com\/:_authToken=\$\{GH_TOKEN\}$/m);
    assert.match(rc, /^\/\/extra\.example\/path\/:_authToken=extra-token$/m);
    assert.ok(!rc.includes("evil.example") && !rc.includes("nodeLinker"));
  });

  test("feeds sourceRegistries: default and scoped registry with their tokens; an unset variable is an error naming it", () => {
    const rc = yarnrcToNpmrc(YML);
    const r = sourceRegistries([rc], { CORP_TOKEN: TOKEN, GH_TOKEN: GH });
    assert.deepEqual(
      r.registries.map((x) => [x.id, x.upstream, x.credential?.type]),
      [["main", "https://npm.corp.example", "bearer"], ["r1", "https://npm.pkg.github.com", "bearer"]],
    );
    assert.throws(() => sourceRegistries([rc], { CORP_TOKEN: TOKEN }), /GH_TOKEN/);
    assert.equal(yarnrcToNpmrc("nodeLinker: node-modules\n"), "");
  });

  test("npmAuthIdent becomes a basic credential", () => {
    const r = sourceRegistries([yarnrcToNpmrc('npmRegistryServer: "https://r.example/"\nnpmAuthIdent: "bob:secret"\n')], {});
    assert.equal(r.registries[0]!.credential?.type, "basic");
  });
});
