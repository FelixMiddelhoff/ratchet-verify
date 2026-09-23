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
