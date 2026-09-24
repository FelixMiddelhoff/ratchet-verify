import { test } from "node:test";
import assert from "node:assert/strict";
import { scanUsage } from "../src/usage/index.js";
import { withTempProject, type Files } from "./helpers.js";

const run = (files: Files, name = "lib") => withTempProject(files, (dir) => scanUsage(dir, name));
const summary = (r: Awaited<ReturnType<typeof run>>) => r.sites.map((s) => `${s.file}:${s.line}:${s.symbol}`);

test("tsconfig paths alias: re-export through @/ is followed to the importer", async () => {
  const r = await run({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    "src/lib/wrap.ts": `export { thing } from "lib";`,
    "src/app.ts": `import { thing } from "@/lib/wrap";\nthing();`,
  });
  assert.ok(summary(r).includes("src/app.ts:1:thing"), summary(r).join());
  assert.equal(r.unresolved, undefined);
});

test("paths without baseUrl are relative to the tsconfig; extends + JSONC comments and trailing commas", async () => {
  const r = await run({
    "tsconfig.base.json": `// base\n{\n  /* c */ "compilerOptions": { "paths": { "~/*": ["./src/*",], }, },\n}`,
    "tsconfig.json": `{ "extends": "./tsconfig.base.json", }`,
    "src/wrap.ts": `export * from "lib";`,
    "src/app.ts": `import { a } from "~/wrap";`,
  });
  assert.ok(summary(r).includes("src/app.ts:1:a"), summary(r).join());
});

test("child baseUrl relative to its own config, exact-match key, longest prefix wins", async () => {
  const r = await run({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@x": ["./one/index.ts"], "@x/*": ["./wrong/*"], "@x/deep/*": ["./right/*"] } } }),
    "one/index.ts": `export { a } from "lib";`,
    "right/f.ts": `export { b } from "lib";`,
    "app.ts": `import { a } from "@x";\nimport { b } from "@x/deep/f";`,
  });
  assert.deepEqual(summary(r).filter((s) => s.startsWith("app.ts")), ["app.ts:1:a", "app.ts:2:b"]);
});

test("baseUrl alone resolves bare imports to project files; an unknown bare name is just an external package", async () => {
  const r = await run({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
    "src/util/wrap.ts": `export { a } from "lib";`,
    "src/app.ts": `import { a } from "util/wrap";\nimport x from "react";`,
  });
  assert.ok(summary(r).includes("src/app.ts:1:a"));
  assert.equal(r.unresolved, undefined);
});

test("alias that matches paths but no scanned file is flagged unresolved (safe downgrade)", async () => {
  const r = await run({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@gen/*": ["./generated/*"] } } }),
    "app.ts": `import { a } from "@gen/api";`,
  });
  assert.equal(r.unresolved?.length, 1);
  assert.match(r.unresolved![0]!.reason, /@gen\/api/);
});

test("non-code alias targets (json/css) and non-matching specifiers add nothing", async () => {
  const r = await run({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@cfg/*": ["./cfg/*.json"] } } }),
    "app.ts": `import c from "@cfg/x";\nimport y from "other-pkg";`,
  });
  assert.equal(r.unresolved, undefined);
});

test("extends cycle terminates; missing extends target is flagged", async () => {
  const cycle = await run({
    "tsconfig.json": JSON.stringify({ extends: "./b.json" }),
    "b.json": JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    "src/w.ts": `export { a } from "lib";`,
    "app.ts": `import { a } from "@/w";`,
  });
  assert.ok(summary(cycle).includes("app.ts:1:a"));
  const missing = await run({ "tsconfig.json": JSON.stringify({ extends: "@missing/base/tsconfig.json" }), "app.ts": `export {};` });
  assert.match(missing.unresolved![0]!.reason, /extends "@missing\/base/);
});

test("unparseable tsconfig is flagged", async () => {
  const r = await run({ "tsconfig.json": "{ not json", "app.ts": `export {};` });
  assert.equal(r.unresolved?.length, 1);
});

test("nested tsconfig only applies below its directory", async () => {
  const r = await run({
    "packages/a/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@a/*": ["./src/*"] } } }),
    "packages/a/src/w.ts": `export { a } from "lib";`,
    "packages/a/app.ts": `import { a } from "@a/w";`,
    "packages/b/app.ts": `import { a } from "@a/w";`,
  });
  assert.deepEqual(summary(r).filter((s) => s.endsWith(":a") && s.includes("app.ts")), ["packages/a/app.ts:1:a"]);
});

test("workspace package name resolves to its local entry, re-export followed", async () => {
  const r = await run({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", main: "dist/index.js" }),
    "packages/core/src/index.ts": `export { thing } from "lib";`,
    "packages/app/package.json": JSON.stringify({ name: "@acme/app" }),
    "packages/app/src/main.ts": `import { thing } from "@acme/core";`,
  });
  assert.ok(summary(r).includes("packages/app/src/main.ts:1:thing"), summary(r).join());
  assert.equal(r.unresolved, undefined);
});

test("workspace exports map (conditions and subpath) and subpath imports", async () => {
  const r = await run({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/core/package.json": JSON.stringify({ name: "core", exports: { ".": { import: "./src/main.ts" }, "./util": "./src/util.ts", "./feat/*": "./src/feat/*.ts" } }),
    "packages/core/src/main.ts": `export { a } from "lib";`,
    "packages/core/src/util.ts": `export { b } from "lib";`,
    "packages/core/src/feat/x.ts": `export { c } from "lib";`,
    "packages/app/package.json": JSON.stringify({ name: "app" }),
    "packages/app/i.ts": `import { a } from "core";\nimport { b } from "core/util";\nimport { c } from "core/feat/x";`,
  });
  assert.deepEqual(summary(r).filter((s) => s.startsWith("packages/app")), ["packages/app/i.ts:1:a", "packages/app/i.ts:2:b", "packages/app/i.ts:3:c"]);
});

test("workspace whose entry cannot be found is unresolved; package.json subpath is ignored", async () => {
  const r = await run({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/core/package.json": JSON.stringify({ name: "core", main: "dist/index.js" }),
    "packages/app/package.json": JSON.stringify({ name: "app" }),
    "packages/app/i.ts": `import { a } from "core";\nimport p from "core/package.json";`,
  });
  assert.equal(r.unresolved?.length, 1);
  assert.match(r.unresolved![0]!.reason, /workspace package core/);
});

test("workspace with dist main falls back to src", async () => {
  const r = await run({
    "package.json": JSON.stringify({ workspaces: ["p/*"] }),
    "p/core/package.json": JSON.stringify({ name: "core", main: "dist/index.js" }),
    "p/core/src/index.ts": `export { a } from "lib";`,
    "p/app/package.json": JSON.stringify({ name: "app" }),
    "p/app/i.ts": `import { a } from "core";`,
  });
  assert.ok(summary(r).includes("p/app/i.ts:1:a"));
});

test("workspace re-export cycle between packages terminates", async () => {
  const r = await run({
    "package.json": JSON.stringify({ workspaces: ["p/*"] }),
    "p/a/package.json": JSON.stringify({ name: "a" }),
    "p/a/index.ts": `export * from "b";\nexport { z } from "lib";`,
    "p/b/package.json": JSON.stringify({ name: "b" }),
    "p/b/index.ts": `export * from "a";`,
    "p/c/package.json": JSON.stringify({ name: "c" }),
    "p/c/index.ts": `import { z } from "b";`,
  });
  assert.ok(summary(r).includes("p/c/index.ts:1:z"), summary(r).join());
});

test("#imports specifier is flagged; normal package imports are not", async () => {
  const r = await run({ "app.ts": `import a from "#internal/x";\nimport b from "react";` });
  assert.equal(r.unresolved?.length, 1);
});
