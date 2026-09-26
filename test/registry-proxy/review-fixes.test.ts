import assert from "node:assert/strict";
import test from "node:test";
import { classifyAddress } from "../../src/sandbox/registry-proxy/netguard.js";
import { plausibleTarballUrl } from "../../src/sandbox/registry-proxy/packument.js";
import { sourceRegistries } from "../../src/sandbox/proxy-topology/index.js";
import { CLIENT_CERT, CLIENT_KEY } from "./mtls-fixtures.js";

// Regression tests for the independent security review (docs: security-review-0.7).

test("LOW-2: a same-origin (credentialed) tarball URL must have the package and version as whole path segments and no query", () => {
  const ok = (url: string, name = "left-pad", version = "1.0.0"): boolean => plausibleTarballUrl(new URL(url), name, version);
  assert.equal(ok("https://r.example/left-pad/-/left-pad-1.0.0.tgz"), true, "npm layout");
  assert.equal(ok("https://r.example/api/npm/repo/left-pad/-/left-pad-1.0.0.tgz"), true, "Artifactory/Nexus layout");
  assert.equal(ok("https://r.example/download/@acme/pkg/1.0.0/abcdef", "@acme/pkg"), true, "GitHub Packages layout");
  assert.equal(ok("https://r.example/special/left-pad-1.0.0.tgz"), true, "flat file layout");
  assert.equal(ok("https://r.example/admin/a/export?v=1.0.0", "a"), false, "substring match on a short name used to pass");
  assert.equal(ok("https://r.example/left-pad/-/left-pad-1.0.0.tgz?token=x"), false, "query strings are refused");
  assert.equal(ok("https://r.example/private/data-1.0.0-left-pad-export"), false, "name and version only as substrings");
  assert.equal(ok("https://r.example/left-pad/../secret/1.0.0"), false, "traversal");
});

test("LOW-4: cloud metadata endpoints that are not link-local are never reachable, even for a host marked private", () => {
  for (const ip of ["168.63.129.16", "100.100.100.200", "fd00:ec2::254", "169.254.169.254"]) assert.equal(classifyAddress(ip), "never", ip);
  assert.equal(classifyAddress("100.64.0.1"), "private", "the rest of CGNAT stays a private range");
  assert.equal(classifyAddress("168.63.129.15"), "public");
});

test("LOW-5: a global client certificate that ends up on several registries is called out", () => {
  const inline = (pem: string): string => pem.trim().split("\n").join("\\n");
  const rc = ["registry=https://a.example/", "@b:registry=https://b.example/", `cert=${inline(CLIENT_CERT)}`, `key=${inline(CLIENT_KEY)}`].join("\n");
  const r = sourceRegistries([rc], {});
  assert.ok(r.notes.some((n) => /global client certificate.*all 2 registries/.test(n)), r.notes.join("\n"));
  assert.ok(!r.notes.join("\n").includes("BEGIN"));
});

test("MEDIUM-3: the registry path (which can carry a token) is not printed in notes", () => {
  const r = sourceRegistries(["registry=https://dl.cloudsmith.example/FAKETOKEN12345678/org/repo/npm/"], {});
  assert.ok(!r.notes.join("\n").includes("FAKETOKEN12345678"), r.notes.join("\n"));
  assert.match(r.notes.join("\n"), /dl\.cloudsmith\.example.*path not shown/);
});
