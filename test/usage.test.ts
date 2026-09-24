import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSource, scanUsage } from "../src/usage/index.js";
import { withTempProject } from "./helpers.js";

/** [line, symbol, kind] triples keep expectations readable. */
const scan = (code: string, file = "a.js") =>
  scanSource(file, code, "lib").map((s) => [s.line, s.symbol, s.kind]);

test("named import records each imported name, not the local alias", () => {
  assert.deepEqual(scan(`import { a, b as c } from "lib";`), [
    [1, "a", "import"],
    [1, "b", "import"],
  ]);
});

test("default import records default plus member calls on it", () => {
  assert.deepEqual(scan(`import _ from "lib";\n_.chunk([]);`), [
    [1, "default", "import"],
    [2, "chunk", "member-access"],
  ]);
});

test("namespace import records member accesses only", () => {
  assert.deepEqual(scan(`import * as ns from "lib";\nns.one();\nns["two"]();`), [
    [2, "one", "member-access"],
    [3, "two", "member-access"],
  ]);
});

test("namespace that is never dereferenced counts as whole-module use", () => {
  assert.deepEqual(scan(`import * as ns from "lib";\nexport { ns };`), [[1, "*", "import"]]);
});

test("side-effect import is whole-module use", () => {
  assert.deepEqual(scan(`import "lib";`), [[1, "*", "import"]]);
});

test("require with destructuring records the destructured names", () => {
  assert.deepEqual(scan(`const { a, b: c } = require("lib");`), [
    [1, "a", "require"],
    [1, "b", "require"],
  ]);
});

test("require bound to a variable records member accesses", () => {
  assert.deepEqual(scan(`const l = require("lib");\nl.run();`), [[2, "run", "member-access"]]);
});

test("require with inline property access records that property", () => {
  assert.deepEqual(scan(`const f = require("lib").format;`), [[1, "format", "require"]]);
});

test("dynamic import: await + destructuring", () => {
  assert.deepEqual(scan(`const { a } = await import("lib");`), [[1, "a", "dynamic-import"]]);
});

test("dynamic import: then callback destructuring", () => {
  assert.deepEqual(scan(`import("lib").then(({ a }) => a());`), [[1, "a", "dynamic-import"]]);
});

test("dynamic import with an unknown use is whole-module", () => {
  assert.deepEqual(scan(`loadIt(import("lib"));`), [[1, "*", "dynamic-import"]]);
});

test("re-exports: named, star, and namespace", () => {
  assert.deepEqual(scan(`export { a, b as c } from "lib";\nexport * from "lib";\nexport * as x from "lib";`), [
    [1, "a", "re-export"],
    [1, "b", "re-export"],
    [2, "*", "re-export"],
    [3, "*", "re-export"],
  ]);
});

test("subpath imports are matched and tagged", () => {
  const [site] = scanSource("a.js", `import { x } from "lib/sub/deep";`, "lib");
  assert.equal(site?.symbol, "x");
  assert.equal(site?.subpath, "lib/sub/deep");
});

test("similar package names and relative paths are not matches", () => {
  assert.deepEqual(scan(`import a from "lib-extra";\nimport b from "./lib";\nconst c = require("library");`), []);
});

test("TypeScript: type-only imports and import-equals are seen", () => {
  assert.deepEqual(scan(`import type { T } from "lib";\nimport l = require("lib");\nl.go();`, "a.ts"), [
    [1, "T", "import"],
    [3, "go", "member-access"],
  ]);
});

test("TSX and JSX files parse", () => {
  assert.deepEqual(scan(`import { Btn } from "lib";\nconst x = <Btn />;`, "a.tsx"), [[1, "Btn", "import"]]);
});

test("site carries the trimmed source line as snippet", () => {
  const [site] = scanSource("a.js", `  import { a } from "lib";`, "lib");
  assert.equal(site?.snippet, `import { a } from "lib";`);
});

test("scanUsage walks the tree, skips node_modules and .d.ts, and reports syntax errors", async () => {
  await withTempProject(
    {
      "src/a.ts": `import { a } from "lib";`,
      "src/deep/b.js": `const { b } = require("lib");`,
      "node_modules/x/i.js": `require("lib");`,
      "types.d.ts": `import { z } from "lib";`,
      "broken.js": `import { c } from "lib"; const = ;`,
    },
    async (dir) => {
      const result = await scanUsage(dir, "lib");
      assert.deepEqual(
        result.sites.map((s) => `${s.file}:${s.line}:${s.symbol}`),
        ["broken.js:1:c", "src/a.ts:1:a", "src/deep/b.js:1:b"],
      );
      assert.deepEqual(result.unparsed, [{ file: "broken.js" }]);
    },
  );
});

test("member use of a named import or destructured require is recorded too", () => {
  assert.deepEqual(scan(`import { program as p } from "lib";
p.parse();`), [
    [1, "program", "import"],
    [2, "parse", "member-access"],
  ]);
  assert.deepEqual(scan(`const { program } = require("lib");
program.option("-d");`), [
    [1, "program", "require"],
    [2, "option", "member-access"],
  ]);
});

// ---- gap (b): local shadowing ------------------------------------------------

test("shadowing: param named like the import is not package use", () => {
  assert.deepEqual(scan(`import _ from "lib";\nfunction f(_) { return _.chunk(); }\n_.real();`), [
    [1, "default", "import"],
    [3, "real", "member-access"],
  ]);
});

test("shadowing: block-scoped const/let and catch variable are not package use", () => {
  assert.deepEqual(
    scan(`import _ from "lib";\nfunction f() { const _ = mk(); _.a(); }\ntry {} catch (_) { _.b(); }\nfor (let _ of xs) { _.c(); }`),
    [[1, "default", "import"]],
  );
});

test("shadowing: a hoisted var in a nested block shadows the whole function", () => {
  assert.deepEqual(scan(`import _ from "lib";\nfunction f() { if (x) { var _ = 1; } _.a(); }`), [[1, "default", "import"]]);
});

test("shadowing conservative: use before a let/const declaration, and eval scopes, still count", () => {
  assert.deepEqual(scan(`import _ from "lib";\nfunction f() { _.early(); const _ = 1; }`), [
    [1, "default", "import"],
    [2, "early", "member-access"],
  ]);
  assert.deepEqual(scan(`import _ from "lib";\nfunction f(_) { eval("x"); _.a(); }`), [
    [1, "default", "import"],
    [2, "a", "member-access"],
  ]);
});

test("shadowing conservative: shadowed-only namespace falls back to whole-module use", () => {
  assert.deepEqual(scan(`import * as ns from "lib";\nfunction f(ns) { ns.x(); }`), [[1, "*", "import"]]);
});

test("shadowing: a require binding inside a function is not shadowed by itself", () => {
  assert.deepEqual(scan(`function f() { const l = require("lib"); l.go(); }`), [[1, "go", "member-access"]]);
});

// ---- gap (c): CommonJS forwarding --------------------------------------------

const project = async (files: Record<string, string>) =>
  withTempProject(files, async (dir) => {
    const r = await scanUsage(dir, "lib");
    return { sites: r.sites.map((s) => `${s.file}:${s.line}:${s.symbol}:${s.kind}`), unresolved: r.unresolved ?? [] };
  });

test("cjs: module.exports = require(pkg) attributes importers' member use to pkg", async () => {
  const r = await project({
    "db.js": `module.exports = require("lib");`,
    "app.js": `const db = require("./db");\ndb.connect();`,
  });
  assert.deepEqual(r.sites, ["app.js:2:connect:member-access", "db.js:1:*:require"]);
  assert.deepEqual(r.unresolved, []);
});

test("cjs: exports.x = require(pkg).x forwards only x", async () => {
  const r = await project({
    "wrap.js": `exports.parse = require("lib").parse;`,
    "app.js": `const { parse, other } = require("./wrap");`,
  });
  assert.deepEqual(r.sites, ["app.js:1:parse:require", "wrap.js:1:parse:require"]);
});

test("cjs: forwarding an unrelated module is a non-match", async () => {
  const r = await project({
    "u.js": `module.exports = require("./helpers");`,
    "helpers.js": `module.exports = { a: 1 };`,
    "app.js": `const u = require("./u");\nu.a();`,
  });
  assert.deepEqual(r.sites, []);
  assert.deepEqual(r.unresolved, []);
});

test("cjs conservative: exports derived from the package in an unfollowable form are flagged", async () => {
  const r = await project({
    "w.js": `const l = require("lib");\nmodule.exports = wrap(l);`,
  });
  assert.equal(r.unresolved.length, 1);
  assert.match(JSON.stringify(r.unresolved), /w\.js/);
});

test("cjs conservative: computed require path is flagged once a forwarder exists", async () => {
  const r = await project({
    "db.js": `module.exports = require("lib");`,
    "loader.js": `module.exports = (n) => require(n);`,
  });
  assert.equal(r.unresolved.length, 1);
});

// ---- gap (a): re-exports through own modules ---------------------------------

test("re-export chain: importer of own module is attributed to pkg", async () => {
  const r = await project({
    "db.ts": `export { default as db, connect } from "lib";`,
    "mid.ts": `export * from "./db";`,
    "app.ts": `import { db, connect as c } from "./mid.js";\ndb.query();`,
  });
  assert.deepEqual(r.sites, [
    "app.ts:1:connect:import",
    "app.ts:1:default:import",
    "app.ts:2:query:member-access",
    "db.ts:1:connect:re-export",
    "db.ts:1:default:re-export",
  ]);
});

test("re-export: local import-then-export and namespace access resolve", async () => {
  const r = await project({
    "a.ts": `import * as l from "lib";\nexport { l as lib };\nexport const run = l.run;`,
    "b.ts": `import { lib, run } from "./a";\nlib.go();`,
  });
  assert.ok(r.sites.includes("b.ts:1:run:import"));
  assert.ok(r.sites.some((s) => s.startsWith("b.ts:2:go")) || r.sites.includes("b.ts:1:*:import"));
});

test("re-export: names the own module does not forward are non-matches", async () => {
  const r = await project({
    "a.ts": `export { one } from "lib";\nexport const two = 2;`,
    "b.ts": `import { two } from "./a";`,
  });
  assert.deepEqual(r.sites, ["a.ts:1:one:re-export"]);
});

test("re-export conservative: namespace of a forwarder used whole is a wildcard", async () => {
  const r = await project({
    "a.ts": `export * from "lib";`,
    "b.ts": `import * as everything from "./a";\nregister(everything);`,
  });
  assert.deepEqual(r.sites, ["a.ts:1:*:re-export", "b.ts:1:*:import"]);
});

test("re-export cycle terminates", async () => {
  const r = await project({
    "a.ts": `export * from "./b";\nexport { x } from "lib";`,
    "b.ts": `export * from "./a";`,
    "c.ts": `import { x } from "./b";`,
  });
  assert.ok(r.sites.includes("c.ts:1:x:import"));
  assert.deepEqual(r.unresolved, []);
});
