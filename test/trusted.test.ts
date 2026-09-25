import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.js";
import { applyTrustedRegistryConfig } from "../src/cli/trusted.js";

const reader = (files: Record<string, string>) => ({ list: async () => Object.keys(files), read: async (p: string) => files[p]! });
const hostile = () =>
  parseConfig(JSON.stringify({ registryAuth: true, registryAllowlist: false, registryAllowHosts: ["attacker.example"], registryDns: ["6.6.6.6"], registryPrivateHosts: ["attacker.example"], registryCaFile: "evil-ca.pem" }));

test("a hostile working-tree .ratchetrc cannot change where a credential goes: base ref settings win", async () => {
  const config = hostile();
  const base = { registryAuth: true, registryDns: ["10.1.1.1"], registryPrivateHosts: ["npm.corp.example"], registryCaFile: "/etc/ssl/corp.pem" };
  const t = await applyTrustedRegistryConfig(config, "origin/main", reader({ ".ratchetrc": JSON.stringify(base), ".npmrc": "registry=https://npm.corp.example/\n" }));
  assert.deepEqual([config.registryAuth, config.registryAllowlist, config.registryAllowHosts, config.registryDns, config.registryPrivateHosts, config.registryCaFile], [true, true, [], ["10.1.1.1"], ["npm.corp.example"], "/etc/ssl/corp.pem"]);
  assert.equal(t.npmrc, "registry=https://npm.corp.example/\n");
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /ignored/);
  assert.ok(!t.notes[0]!.includes("attacker"), "notes name settings, not values");
});

test("no .ratchetrc at the base: the feature is off, whatever the pull request enables; a hostile .npmrc is never read", async () => {
  const config = hostile();
  const t = await applyTrustedRegistryConfig(config, "origin/main", reader({ "package.json": "{}" }));
  assert.deepEqual([config.registryAuth, config.registryAllowlist, config.registryAllowHosts, config.registryDns, config.registryCaFile], [false, true, [], DEFAULT_CONFIG.registryDns, undefined]);
  assert.equal(t.npmrc, undefined);
});

test("identical settings produce no note; a relative CA file is refused under --base", async () => {
  const same = parseConfig("{}");
  assert.deepEqual((await applyTrustedRegistryConfig(same, "b", reader({}))).notes, []);
  await assert.rejects(applyTrustedRegistryConfig(parseConfig("{}"), "b", reader({ ".ratchetrc": '{"registryAuth":true,"registryCaFile":"ca.pem"}' })), /absolute path/);
});
