import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLockfileTexts, parseLockfile } from "../src/lockfile/index.js";

type Pkgs = Record<string, string>;

const v3 = (pkgs: Pkgs, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "app" },
      ...Object.fromEntries(Object.entries(pkgs).map(([p, v]) => [p, { version: v }])),
      ...extra,
    },
  });

const v1 = (deps: object) => JSON.stringify({ lockfileVersion: 1, dependencies: deps });

const manifest = { dependencies: { a: "^1.0.0" }, devDependencies: { d: "^1.0.0" } };

test("v3: version bump of a direct dependency", () => {
  const changes = diffLockfileTexts(
    v3({ "node_modules/a": "1.0.0" }),
    v3({ "node_modules/a": "1.1.0" }),
    manifest,
  );
  assert.deepEqual(changes, [
    { name: "a", path: "node_modules/a", kind: "changed", oldVersion: "1.0.0", newVersion: "1.1.0", direct: true },
  ]);
});

test("v3: transitive-only bump is flagged transitive", () => {
  const changes = diffLockfileTexts(
    v3({ "node_modules/a": "1.0.0", "node_modules/t": "2.0.0" }),
    v3({ "node_modules/a": "1.0.0", "node_modules/t": "2.0.1" }),
    manifest,
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.name, "t");
  assert.equal(changes[0]?.direct, false);
});

test("v3: added and removed dependencies", () => {
  const changes = diffLockfileTexts(
    v3({ "node_modules/a": "1.0.0", "node_modules/gone": "1.0.0" }),
    v3({ "node_modules/a": "1.0.0", "node_modules/d": "3.0.0" }),
    manifest,
  );
  assert.deepEqual(
    changes.map((c) => [c.name, c.kind, c.direct]),
    [
      ["d", "added", true],
      ["gone", "removed", false],
    ],
  );
});

test("identical lockfiles produce no changes", () => {
  const lock = v3({ "node_modules/a": "1.0.0" });
  assert.deepEqual(diffLockfileTexts(lock, lock, manifest), []);
});

test("nested copy of a direct dependency name is transitive", () => {
  const changes = diffLockfileTexts(
    v3({ "node_modules/x/node_modules/a": "0.9.0" }),
    v3({ "node_modules/x/node_modules/a": "0.9.1" }),
    manifest,
  );
  assert.equal(changes[0]?.name, "a");
  assert.equal(changes[0]?.direct, false);
});

test("scoped package names are parsed whole", () => {
  const parsed = parseLockfile(v3({ "node_modules/@scope/pkg": "1.0.0" }));
  assert.equal(parsed.get("node_modules/@scope/pkg")?.name, "@scope/pkg");
});

test("root, links and workspace entries are ignored", () => {
  const parsed = parseLockfile(
    v3({ "node_modules/a": "1.0.0" }, {
      "node_modules/ws": { resolved: "packages/ws", link: true },
      "packages/ws": { version: "1.0.0" },
    }),
  );
  assert.deepEqual([...parsed.keys()], ["node_modules/a"]);
});

test("v2 prefers the flat packages map over the legacy tree", () => {
  const text = JSON.stringify({
    lockfileVersion: 2,
    packages: { "": {}, "node_modules/a": { version: "2.0.0" } },
    dependencies: { a: { version: "1.0.0" } },
  });
  assert.equal(parseLockfile(text).get("node_modules/a")?.version, "2.0.0");
});

test("v1: nested dependency tree is flattened to install paths", () => {
  const parsed = parseLockfile(
    v1({ a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } }),
  );
  assert.equal(parsed.get("node_modules/a/node_modules/b")?.version, "2.0.0");
});

test("v1: diff detects a bump", () => {
  const changes = diffLockfileTexts(
    v1({ a: { version: "1.0.0" } }),
    v1({ a: { version: "1.2.0" } }),
    manifest,
  );
  assert.equal(changes[0]?.newVersion, "1.2.0");
  assert.equal(changes[0]?.direct, true);
});

test("v1 to v3 migration of an unchanged tree yields no changes", () => {
  const changes = diffLockfileTexts(
    v1({ a: { version: "1.0.0" } }),
    v3({ "node_modules/a": "1.0.0" }),
  );
  assert.deepEqual(changes, []);
});

test("unsupported lockfile shape throws", () => {
  assert.throws(() => parseLockfile("{}"), /Unsupported lockfile/);
});
