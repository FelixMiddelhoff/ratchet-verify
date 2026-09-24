import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLockfileTexts } from "../src/lockfile/index.js";
import { discoverWorkspaces } from "../src/workspaces/index.js";
import { managerByName } from "../src/testrun/index.js";
import { runPipeline, type PipelineDeps } from "../src/pipeline/index.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { withTempProject } from "./helpers.js";

const ws = [
  { name: "@acme/a", dir: "packages/a", manifest: { dependencies: { chalk: "^4" } } },
  { name: "@acme/b", dir: "packages/b", manifest: { devDependencies: { lodash: "^4" } } },
];

const npmLock = (chalk: string, lodash: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "root", workspaces: ["packages/*"] },
      "node_modules/@acme/a": { resolved: "packages/a", link: true },
      "node_modules/@acme/b": { resolved: "packages/b", link: true },
      "packages/a": { name: "@acme/a", version: "1.0.0", dependencies: { chalk: "^4" } },
      "packages/b": { name: "@acme/b", version: "1.0.0" },
      "node_modules/chalk": { version: chalk },
      "node_modules/lodash": { version: lodash },
      "node_modules/deep": { version: "1.0.0" },
      "packages/b/node_modules/chalk": { version: chalk },
    },
  });

test("npm workspaces: links and workspace sources skipped, dep direct if ANY workspace names it", () => {
  const changes = diffLockfileTexts(npmLock("4.0.0", "4.0.0"), npmLock("4.1.0", "4.1.0"), {}, ws);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.equal(byPath["node_modules/chalk"]!.direct, true);
  assert.deepEqual(byPath["node_modules/chalk"]!.declaredIn, ["@acme/a"]);
  assert.deepEqual(byPath["node_modules/lodash"]!.declaredIn, ["@acme/b"]);
  assert.equal(changes.some((c) => c.name.startsWith("@acme")), false);
  // workspace b does not name chalk: its own nested copy is transitive there
  assert.equal(byPath["packages/b/node_modules/chalk"]!.direct, false);
});

test("without workspace info the same lockfile keeps the root-only behaviour", () => {
  const changes = diffLockfileTexts(npmLock("4.0.0", "4.0.0"), npmLock("4.1.0", "4.1.0"), {});
  assert.equal(changes.find((c) => c.name === "chalk" && c.path === "node_modules/chalk")!.direct, false);
  assert.equal(changes.every((c) => c.declaredIn === undefined), true);
});

test("root manifest counts as declarer alongside a workspace", () => {
  const changes = diffLockfileTexts(npmLock("4.0.0", "4.0.0"), npmLock("4.1.0", "4.1.0"), { dependencies: { chalk: "^4" } }, ws);
  assert.deepEqual(changes.find((c) => c.path === "node_modules/chalk")!.declaredIn, ["(root)", "@acme/a"]);
});

test("nested workspace copy is direct when that workspace names it", () => {
  const withB = [ws[0]!, { ...ws[1]!, manifest: { dependencies: { chalk: "^4" } } }];
  const c = diffLockfileTexts(npmLock("4.0.0", "4.0.0"), npmLock("4.1.0", "4.1.0"), {}, withB).find((x) => x.path === "packages/b/node_modules/chalk")!;
  assert.equal(c.direct, true);
  assert.deepEqual(c.declaredIn, ["@acme/b"]);
});

const pnpmLock = (chalk: string) => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      lodash:
        specifier: ^4
        version: 4.17.21

  packages/a:
    dependencies:
      chalk:
        specifier: ^4
        version: ${chalk}
      '@acme/b':
        specifier: workspace:*
        version: link:../b

  packages/b:
    dependencies:
      chalk:
        specifier: ^5
        version: 5.0.0

packages:

  chalk@${chalk}:
    resolution: {integrity: sha512-a}

  chalk@5.0.0:
    resolution: {integrity: sha512-b}

  lodash@4.17.21:
    resolution: {integrity: sha512-c}
`;

test("pnpm importers: every importer counts; two chalk versions: workspace-a's keeps the plain path", () => {
  const changes = diffLockfileTexts(pnpmLock("4.0.0"), pnpmLock("4.1.0"), {}, ws);
  assert.deepEqual(changes.map((c) => [c.name, c.direct, c.oldVersion, c.newVersion]), [["chalk", true, "4.0.0", "4.1.0"]]);
});

test("yarn workspaces: workspace entries are skipped, direct through workspace manifest", () => {
  const lock = (v: string) => `# yarn lockfile v1\n\n\nchalk@^4:\n  version "${v}"\n  resolved "https://registry.yarnpkg.com/chalk/-/chalk-${v}.tgz#abc"\n`;
  const changes = diffLockfileTexts(lock("4.0.0"), lock("4.1.0"), {}, ws);
  assert.deepEqual(changes.map((c) => [c.name, c.direct, c.declaredIn]), [["chalk", true, ["@acme/a"]]]);
  const berry = (v: string) => `__metadata:\n  version: 6\n\n"chalk@npm:^4":\n  version: ${v}\n  resolution: "chalk@npm:${v}"\n\n"@acme/a@workspace:packages/a":\n  version: 0.0.0-use.local\n  resolution: "@acme/a@workspace:packages/a"\n`;
  assert.deepEqual(diffLockfileTexts(berry("4.0.0"), berry("4.1.0"), {}, ws).map((c) => [c.name, c.direct]), [["chalk", true]]);
});

test("discoverWorkspaces: npm/yarn arrays and yarn classic { packages }, globs, negation, no package.json", async () => {
  await withTempProject(
    {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/*", "tools/deep/**", "!packages/skip"] } }),
      "packages/a/package.json": JSON.stringify({ name: "a", dependencies: { x: "1" } }),
      "packages/skip/package.json": JSON.stringify({ name: "skip" }),
      "packages/notpkg/readme.md": "x",
      "tools/deep/one/two/package.json": JSON.stringify({ name: "two" }),
    },
    async (dir) => {
      const found = await discoverWorkspaces(dir);
      assert.deepEqual(found.map((w) => [w.name, w.dir]), [["a", "packages/a"], ["two", "tools/deep/one/two"]]);
      assert.deepEqual(found[0]!.manifest.dependencies, { x: "1" });
    },
  );
});

test("discoverWorkspaces: pnpm-workspace.yaml packages list; none = empty", async () => {
  await withTempProject(
    {
      "package.json": JSON.stringify({ name: "r" }),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - \"libs/core\" # comment\n  - '!apps/old'\nother: 1\n",
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/old/package.json": JSON.stringify({ name: "old" }),
      "libs/core/package.json": JSON.stringify({ name: "core" }),
    },
    async (dir) => assert.deepEqual((await discoverWorkspaces(dir)).map((w) => w.name), ["web", "core"]),
  );
  await withTempProject({ "package.json": "{}" }, async (dir) => assert.deepEqual(await discoverWorkspaces(dir), []));
});

test("pin commands target the declaring workspace; several declarers are not isolatable", () => {
  const scope = { workspaceProject: true, workspace: { name: "@acme/a", dir: "packages/a" } };
  assert.deepEqual(managerByName("npm").pinDependency("x", "1.0.0", "", scope), ["install", "x@1.0.0", "-w", "packages/a", "--package-lock-only", "--ignore-scripts"]);
  assert.deepEqual(managerByName("pnpm").pinDependency("x", "1.0.0", "", scope), ["add", "x@1.0.0", "--filter", "@acme/a", "--lockfile-only", "--ignore-scripts"]);
  assert.deepEqual(managerByName("yarn").pinDependency("x", "1.0.0", "# yarn lockfile v1", scope), ["workspace", "@acme/a", "add", "x@1.0.0", "--ignore-scripts"]);
  assert.deepEqual(managerByName("yarn").pinDependency("x", "1.0.0", "__metadata:\n", scope), ["workspace", "@acme/a", "add", "x@1.0.0", "--mode=skip-build"]);
  assert.deepEqual(managerByName("pnpm").pinDependency("x", "1.0.0", "", { workspaceProject: true }), ["add", "x@1.0.0", "-w", "--lockfile-only", "--ignore-scripts"]);
  assert.deepEqual(managerByName("yarn").pinDependency("x", "1.0.0", "# yarn lockfile v1", { workspaceProject: true }), ["add", "x@1.0.0", "-W", "--ignore-scripts"]);
  for (const m of ["npm", "yarn", "pnpm"] as const) assert.equal(managerByName(m).pinDependency("x", "1.0.0", "", { ambiguous: true }), undefined);
});

test("pipeline: per-workspace attribution in the report; usage in a sibling workspace is listed", async () => {
  const pass = { status: "passed" as const, result: { exitCode: 0, timedOut: false, output: "", truncated: false } };
  const deps: PipelineDeps = {
    testLockfile: async () => pass,
    testDependencyAt: async () => pass,
    fetchChangelog: async () => ({ source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] }),
    scanUsage: async () => ({ sites: [{ file: "packages/b/src/x.ts", line: 1, symbol: "red", kind: "import", snippet: "import { red } from 'chalk'" }], unparsed: [] }),
  };
  const report = await runPipeline(
    { oldLockfile: npmLock("4.0.0", "4.17.21"), newLockfile: npmLock("4.1.0", "4.17.21"), manifest: {}, workspaces: ws, config: { ...DEFAULT_CONFIG } },
    deps,
  );
  const chalk = report.verdicts.find((v) => v.name === "chalk" && v.direct)!;
  assert.deepEqual(chalk.workspaces, { declared: ["@acme/a"], used: ["@acme/b"] });
});
