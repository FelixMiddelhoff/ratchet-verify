import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCliArgs } from "../src/cli/args.js";
import { runCli, type DepsFactory, type DepsFactoryOptions } from "../src/cli/main.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { diffLockfileTexts } from "../src/lockfile/index.js";
import { runPipeline, type PipelineDeps } from "../src/pipeline/index.js";
import { renderJson } from "../src/report/index.js";
import { renderMarkdown } from "../src/ci/comment.js";
import { withSandbox } from "../src/sandbox/index.js";
import { managerByName } from "../src/testrun/index.js";
import { scanUsage } from "../src/usage/index.js";
import { discoverWorkspaces } from "../src/workspaces/index.js";
import { pkg, withTempProject } from "./helpers.js";

const passResult = { exitCode: 0, timedOut: false, output: "", truncated: false };
const pass = { status: "passed" as const, result: passResult };
const fail = { status: "failed" as const, result: { ...passResult, exitCode: 1 } };

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), env: {} }, out, err };
}

/** A sibling temp dir (outside any project) holding a package.json that must never be touched. */
async function withVictim<T>(body: (victim: string, name: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ratchet-victim-"));
  await writeFile(join(dir, "package.json"), '{"name":"victim","workspaces":[]}');
  try {
    return await body(dir, dir.slice(dirname(dir).length + 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- S1: sandbox confinement ------------------------------------------------------------------------------

test("S1 sandbox: files keys escaping the sandbox are rejected and the host file survives", async () => {
  await withVictim(async (victim, name) => {
    await withTempProject({ "package.json": "{}" }, async (project) => {
      // sandbox dir is <tmp>/ratchet-sandbox-x/project, so ../../<name> is the sibling victim dir
      for (const key of [`../../${name}/package.json`, `..\\..\\${name}\\package.json`, `a/../../../${name}/package.json`, `${victim}/package.json`, "C:\\x\\package.json", "C:/x/package.json", "/abs/package.json", "\\\\srv\\share\\package.json", "..\\x"]) {
        await assert.rejects(withSandbox({ projectDir: project, files: { [key]: null } }, async () => {}), /outside|confine/i, key);
        await assert.rejects(withSandbox({ projectDir: project, files: { [key]: "pwned" } }, async () => {}), /outside|confine/i, key);
      }
      assert.equal(readFileSync(join(victim, "package.json"), "utf8"), '{"name":"victim","workspaces":[]}');
    });
  });
});

test("S1 sandbox: legit nested keys still work and create missing directories", async () => {
  await withTempProject({ "package.json": "{}" }, (project) =>
    withSandbox({ projectDir: project, files: { "packages/new/package.json": "{}", "package.json": null } }, async (s) => {
      assert.equal(readFileSync(join(s.dir, "packages/new/package.json"), "utf8"), "{}");
      assert.equal(existsSync(join(s.dir, "package.json")), false);
    }),
  );
});

test("S1 sandbox: a symlinked directory inside the project cannot be used to write outside", async () => {
  await withVictim(async (victim) => {
    await withTempProject({ "package.json": "{}" }, async (project) => {
      try {
        await symlink(victim, join(project, "link"), "junction");
      } catch {
        return; // cannot create links here
      }
      await assert.rejects(withSandbox({ projectDir: project, files: { "link/package.json": "pwned" } }, async () => {}), /outside|confine|symlink/i);
      assert.equal(readFileSync(join(victim, "package.json"), "utf8"), '{"name":"victim","workspaces":[]}');
    });
  });
});

test("S1 cli: --old-workspace-package-json keys are validated at parse time", () => {
  for (const key of ["../../x", "..\\x", "C:\\x", "/etc", "a/../../b"]) {
    assert.throws(() => parseCliArgs(["--old", "l", "--old-workspace-package-json", `${key}=f.json`]), /outside|confine|relative/i, key);
  }
});

// ---- S2 / S3: discovery and --old-workspace-package-json ------------------------------------------------------

test("S2 discovery: patterns with .., absolute paths and drive letters are ignored; only in-project dirs are found", async () => {
  await withVictim(async (victim, name) => {
    await withTempProject(
      {
        "package.json": JSON.stringify({ workspaces: [`../${name}`, `..\\${name}`, victim, "C:\\x", "/abs/y", "packages/*", "../*"] }),
        "packages/a/package.json": JSON.stringify({ name: "a" }),
      },
      async (dir) => {
        assert.deepEqual((await discoverWorkspaces(dir)).map((w) => w.dir), ["packages/a"]);
      },
    );
  });
});

test("S2 discovery: ignored patterns are announced on stderr", async () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lib": { version: "1.0.0" } } });
  await withTempProject(
    { "package.json": pkg({ workspaces: ["../victim", "packages/*"] }), "package-lock.json": lock, "old.json": lock, "packages/a/package.json": JSON.stringify({ name: "a" }) },
    async (dir) => {
      const { io, err } = capture();
      const deps: DepsFactory = () => ({ testLockfile: async () => pass, testDependencyAt: async () => pass, fetchChangelog: async () => ({ source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] }), scanUsage: async () => ({ sites: [], unparsed: [] }) });
      await runCli([dir, "--old", join(dir, "old.json")], io, deps);
      assert.match(err.join("\n"), /ignored workspace pattern "\.\.\/victim"/);
    },
  );
});

test("S2 discovery: a workspace directory that is a link to outside the project is not followed", async () => {
  await withVictim(async (victim) => {
    await withTempProject({ "package.json": JSON.stringify({ workspaces: ["packages/link", "packages/real"] }), "packages/real/package.json": JSON.stringify({ name: "real" }) }, async (dir) => {
      try {
        await symlink(victim, join(dir, "packages/link"), "junction");
      } catch {
        return;
      }
      assert.deepEqual((await discoverWorkspaces(dir)).map((w) => w.dir), ["packages/real"]);
    });
  });
});

const lockOf = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lib": { version: v } } });
const okDeps = (seen?: (o: DepsFactoryOptions) => void): DepsFactory => (o) => {
  seen?.(o);
  return { testLockfile: async () => pass, testDependencyAt: async () => pass, fetchChangelog: async () => ({ source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] }), scanUsage: async () => ({ sites: [], unparsed: [] }) };
};

test("S3 cli: --old-workspace-package-json key must be a discovered workspace; unreadable file is a clear error", async () => {
  await withTempProject(
    { "package.json": pkg({ workspaces: ["packages/*"] }), "package-lock.json": lockOf("1.1.0"), "old.json": lockOf("1.0.0"), "packages/a/package.json": "{}", "f.json": "{}" },
    async (dir) => {
      const run = async (...extra: string[]) => {
        const c = capture();
        const code = await runCli([dir, "--old", join(dir, "old.json"), ...extra], c.io, okDeps());
        return { code, err: c.err.join("\n") };
      };
      const notWs = await run("--old-workspace-package-json", `packages/zzz=${join(dir, "f.json")}`);
      assert.equal(notWs.code, 2);
      assert.match(notWs.err, /packages\/zzz.*not a (discovered )?workspace/i);
      const missing = await run("--old-workspace-package-json", `packages/a=${join(dir, "nope.json")}`);
      assert.equal(missing.code, 2);
      assert.match(missing.err, /cannot read .*nope\.json/i);
      const ok = await run("--old-workspace-package-json", `packages/a=${join(dir, "f.json")}`);
      assert.equal(ok.code, 0, ok.err);
    },
  );
});

// ---- S4: glob cost ----------------------------------------------------------------------------------------------

test("S4 discovery: repeated ** segments finish quickly", async () => {
  const tree: Record<string, string> = {};
  for (let i = 0; i < 64; i++) tree[`t/${i.toString(2).padStart(6, "0").replaceAll("0", "a").replaceAll("1", "b").split("").join("/")}/x.txt`] = "x";
  tree["t/a/a/a/a/a/a/package.json"] = JSON.stringify({ name: "deep" });
  await withTempProject({ "package.json": JSON.stringify({ workspaces: [`t/${Array(12).fill("**").join("/")}`, `t/${Array(6).fill("**/a").join("/")}`, "!t/**/**/**/zzz"] }), ...tree }, async (dir) => {
    const start = Date.now();
    const found = await discoverWorkspaces(dir);
    assert.ok(Date.now() - start < 2000, `took ${Date.now() - start}ms`);
    assert.deepEqual(found.map((w) => w.name), ["deep"]);
  });
});

// ---- S5: tsconfig paths index -----------------------------------------------------------------------------------

test("S5 usage: a tsconfig with 200k paths keys stays fast; longest prefix still wins", async () => {
  const paths: Record<string, string[]> = { "@a/*": ["src/a/*"], "@a/b/*": ["src/b/*"], "exact": ["src/exact"] };
  for (let i = 0; i < 200_000; i++) paths[`@k${i}/*`] = [`src/k${i}/*`];
  const files: Record<string, string> = { "tsconfig.json": JSON.stringify({ compilerOptions: { paths } }), "src/b/c.ts": "export { default } from 'lib';", "src/a/b/c.ts": "export const x = 1;", "src/exact.ts": "export const y = 2;", "src/app.ts": "import { default as l } from '@a/b/c'; import '@a/b/c'; import 'exact'; import 'other'; export { l };" };
  for (let i = 0; i < 60; i++) files[`src/f${i}.ts`] = `import '@k${i}/x'; import 'lodash${i}'; import 'lib';`;
  await withTempProject(files, async (dir) => {
    const start = Date.now();
    const scan = await scanUsage(dir, "lib");
    assert.ok(Date.now() - start < 8000, `took ${Date.now() - start}ms`);
    // '@a/b/c' resolves to src/b/c.ts (longest prefix @a/b/), which re-exports lib: app.ts is a user of lib
    assert.ok(scan.sites.some((s) => s.file === "src/app.ts"), JSON.stringify(scan.sites.map((s) => s.file)));
  });
});

// ---- S6 / S7: usage scan gaps -----------------------------------------------------------------------------------

test("S6 usage: .vue/.svelte/.astro/.mdx files are never parsed and make the scan partial", async () => {
  await withTempProject(
    { "a.vue": "<script>import debug from 'debug'</script>", "b/c.svelte": "<script>import debug from 'debug'</script>", "d.astro": "---\nimport debug from 'debug'\n---", "e.mdx": "import debug from 'debug'", "node_modules/x/y.vue": "x", "ok.ts": "export const z = 1;" },
    async (dir) => {
      const scan = await scanUsage(dir, "debug");
      assert.deepEqual(scan.sites, []);
      const files = (scan.unresolved ?? []).filter((u) => /file type not scanned/.test(u.reason)).map((u) => u.file).sort();
      assert.deepEqual(files, ["a.vue", "b/c.svelte", "d.astro", "e.mdx"]);
    },
  );
  await withTempProject({ "ok.ts": "export const z = 1;" }, async (dir) => assert.equal((await scanUsage(dir, "debug")).unresolved, undefined));
});

test("S7 usage: symlinked directories are not followed and are reported", async () => {
  await withTempProject({ "src/a.ts": "import debug from 'debug'; debug();" }, async (dir) => {
    try {
      await symlink(join(dir, "src"), join(dir, "linked"), "junction");
      await symlink(dir, join(dir, "src/loop"), "junction");
    } catch {
      return;
    }
    const scan = await scanUsage(dir, "debug");
    assert.equal(scan.sites.length, 1);
    const reasons = (scan.unresolved ?? []).filter((u) => /symlink/i.test(u.reason)).map((u) => u.file).sort();
    assert.deepEqual(reasons, ["linked", "src/loop"]);
  });
});

// ---- C1: pnpm importers on different versions --------------------------------------------------------------------

const pnpmTwo = (a: string, b: string) => `lockfileVersion: '9.0'

importers:

  packages/a:
    dependencies:
      chalk:
        specifier: ^4
        version: ${a}

  packages/b:
    dependencies:
      chalk:
        specifier: ^5
        version: ${b}

packages:

  chalk@${a}:
    resolution: {integrity: sha512-a}

  chalk@${b}:
    resolution: {integrity: sha512-b}
`;
const twoWs = [
  { name: "@acme/a", dir: "packages/a", manifest: { dependencies: { chalk: "^4" } } },
  { name: "@acme/b", dir: "packages/b", manifest: { dependencies: { chalk: "^5" } } },
];

test("C1 pnpm: importers on different versions of one package: a bump pairs up and is attributed to its importer", () => {
  const changes = diffLockfileTexts(pnpmTwo("4.0.0", "5.0.0"), pnpmTwo("4.0.0", "5.1.0"), {}, twoWs);
  assert.deepEqual(changes.map((c) => [c.name, c.kind, c.oldVersion, c.newVersion, c.direct, c.declaredIn]), [["chalk", "changed", "5.0.0", "5.1.0", true, ["@acme/b"]]]);
  const moved = diffLockfileTexts(pnpmTwo("4.0.0", "5.0.0"), pnpmTwo("4.1.0", "5.0.0"), {}, twoWs);
  assert.deepEqual(moved.map((c) => [c.kind, c.direct, c.declaredIn]), [["changed", true, ["@acme/a"]]]);
});

function probeDeps(calls: { name: string; version: string; scope: unknown }[], newLock: string, versions = ["5.0.0", "5.0.5", "5.1.0"]): PipelineDeps {
  return {
    testLockfile: async (text) => (text === newLock ? fail : pass),
    testDependencyAt: async (name, version, scope) => {
      calls.push({ name, version, scope });
      const args = managerByName("pnpm").pinDependency(name, version, "", scope);
      return args ? fail : { status: "install-failed", result: passResult };
    },
    fetchChangelog: async () => ({ source: "none", entries: [], missingVersions: [], availableVersions: versions, notes: [] }),
    scanUsage: async () => ({ sites: [], unparsed: [] }),
  };
}

test("C1 pipeline: the bump of importer b's copy is isolated and probed as a direct dependency of b", async () => {
  const oldLock = pnpmTwo("4.0.0", "5.0.0");
  const newLock = pnpmTwo("4.0.0", "5.1.0");
  const calls: { name: string; version: string; scope: unknown }[] = [];
  const report = await runPipeline({ oldLockfile: oldLock, newLockfile: newLock, manifest: {}, workspaces: twoWs, config: { ...DEFAULT_CONFIG } }, probeDeps(calls, newLock));
  assert.ok(calls.length > 0);
  for (const c of calls) assert.deepEqual(c.scope, { workspaceProject: true, workspace: { name: "@acme/b", dir: "packages/b" } });
  assert.ok(report.verdicts[0]!.evidence.some((e) => e.kind === "bisect"));
  assert.equal(report.verdicts[0]!.status, "broken");
  assert.equal(report.verdicts[0]!.direct, true);
});

test("C1 pipeline: when a and b declare the same version, moving it is ambiguous and not tested on its own", async () => {
  const same = (v: string) => pnpmTwo(v, v).replace(/chalk@\S+:\n {4}resolution: \{integrity: sha512-b\}\n/, "");
  const oldLock = same("4.0.0");
  const newLock = same("4.1.0");
  const calls: { name: string; version: string; scope: unknown }[] = [];
  const report = await runPipeline({ oldLockfile: oldLock, newLockfile: newLock, manifest: {}, workspaces: twoWs, config: { ...DEFAULT_CONFIG } }, probeDeps(calls, newLock, ["4.0.0", "4.0.5", "4.1.0"]));
  assert.ok(calls.length > 0);
  for (const c of calls) assert.deepEqual(c.scope, { workspaceProject: true, ambiguous: true }); // never a single-workspace pin
  assert.notEqual(report.verdicts[0]!.status, "safe");
  assert.equal(report.verdicts[0]!.evidence.some((e) => e.kind === "bisect" && e.exact && e.ambiguousWith.length === 0), false); // probes that could not run prove nothing
});

// ---- C2: pnpm-workspace.yaml parsing ------------------------------------------------------------------------------

const apps = (yaml: string, extra: Record<string, string> = {}) => withTempProject({ "package.json": "{}", "pnpm-workspace.yaml": yaml, "apps/web/package.json": '{"name":"web"}', "apps/api/package.json": '{"name":"api"}', "libs/a,b/package.json": '{"name":"comma"}', ...extra }, async (dir) => (await discoverWorkspaces(dir)).map((w) => w.name));

test("C2 pnpm-workspace.yaml: list items at column 0, flow lists with quoted commas, explicit empty list", async () => {
  assert.deepEqual(await apps("packages:\n- 'apps/*'\n- '!apps/api'\n"), ["web"]);
  assert.deepEqual(await apps("packages:\n- apps/*\ncatalog:\n  x: 1\n"), ["api", "web"]);
  assert.deepEqual(await apps("packages: ['apps/web', \"libs/a,b\"]\n"), ["web", "comma"]);
  assert.deepEqual(await apps("packages: [\n  'apps/web',\n  'apps/api'\n]\n"), ["api", "web"]);
  assert.deepEqual(await apps("packages: []\n"), []);
  assert.deepEqual(await apps("catalog:\n  x: 1\npackages:\n  - apps/api # trailing\n"), ["api"]);
});

test("C2 pnpm-workspace.yaml: a file that yields no packages is announced", async () => {
  const lock = lockOf("1.0.0");
  await withTempProject({ "package.json": pkg({}), "pnpm-workspace.yaml": "catalog:\n  x: 1\n", "package-lock.json": lockOf("1.1.0"), "old.json": lock }, async (dir) => {
    const { io, err } = capture();
    await runCli([dir, "--old", join(dir, "old.json")], io, okDeps());
    assert.match(err.join("\n"), /pnpm-workspace\.yaml.*no workspace packages/i);
  });
});

// ---- C3 / C4: base-ref workspace state -----------------------------------------------------------------------------

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
}

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
}

test("C3 --base: removed workspaces are restored, added ones removed, from root workspaces globs at the base ref", async () => {
  await withTempProject({}, async (dir) => {
    git(dir, "init", "-q");
    await put(dir, {
      "package.json": pkg({ workspaces: ["packages/*"], dependencies: { lib: "^1" } }),
      "package-lock.json": lockOf("1.0.0"),
      "packages/a/package.json": '{"name":"a","v":"old"}',
      "packages/gone/package.json": '{"name":"gone"}',
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    await rm(join(dir, "packages"), { recursive: true });
    await put(dir, {
      "package.json": pkg({ workspaces: ["packages/*", "apps/*"], dependencies: { lib: "^1" } }),
      "package-lock.json": lockOf("1.1.0"),
      "packages/a/package.json": '{"name":"a","v":"new"}',
      "apps/new/package.json": '{"name":"new"}',
    });
    let seen: DepsFactoryOptions | undefined;
    const c = capture();
    const code = await runCli([dir, "--base", "HEAD"], c.io, okDeps((o) => (seen = o)));
    assert.equal(code, 0, c.err.join("\n"));
    assert.deepEqual(seen!.oldFiles, { "apps/new/package.json": null, "packages/a/package.json": '{"name":"a","v":"old"}', "packages/gone/package.json": '{"name":"gone"}' });
  });
});

test("C3 --base: an old pnpm-workspace.yaml and its workspaces are restored", async () => {
  const pl = (v: string) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lib:\n        specifier: ^1\n        version: ${v}\n\npackages:\n\n  lib@${v}:\n    resolution: {integrity: sha512-a}\n`;
  await withTempProject({}, async (dir) => {
    git(dir, "init", "-q");
    await put(dir, { "package.json": pkg({ dependencies: { lib: "^1" } }), "pnpm-lock.yaml": pl("1.0.0"), "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n", "apps/x/package.json": '{"name":"x"}' });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    await rm(join(dir, "apps"), { recursive: true });
    await put(dir, { "pnpm-lock.yaml": pl("1.1.0"), "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n", "libs/y/package.json": '{"name":"y"}' });
    let seen: DepsFactoryOptions | undefined;
    const c = capture();
    assert.equal(await runCli([dir, "--base", "HEAD"], c.io, okDeps((o) => (seen = o))), 0, c.err.join("\n"));
    assert.deepEqual(seen!.oldFiles, { "apps/x/package.json": '{"name":"x"}', "libs/y/package.json": null, "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" });
  });
});

test("C3 --base: a project subdirectory of a repo reads the base state relative to itself", async () => {
  await withTempProject({}, async (root) => {
    git(root, "init", "-q");
    const dir = join(root, "proj");
    await put(dir, { "package.json": pkg({ workspaces: ["packages/*"] }), "package-lock.json": lockOf("1.0.0"), "packages/a/package.json": '{"name":"a","v":"old"}' });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    await put(dir, { "package-lock.json": lockOf("1.1.0"), "packages/a/package.json": '{"name":"a","v":"new"}' });
    let seen: DepsFactoryOptions | undefined;
    const c = capture();
    assert.equal(await runCli([dir, "--base", "HEAD"], c.io, okDeps((o) => (seen = o))), 0, c.err.join("\n"));
    assert.deepEqual(seen!.oldFiles, { "packages/a/package.json": '{"name":"a","v":"old"}' });
  });
});

test("C4 readOldWorkspaceManifests: only 'absent at base' is null; any other git failure is rethrown clearly", async () => {
  const { readOldWorkspaceManifests } = await import("../src/cli/main.js");
  const args = parseCliArgs(["--base", "main"]);
  const reader = (broken: boolean) => ({
    list: async () => ["package.json", "packages/a/package.json", "packages/b/package.json"],
    read: async (path: string) => {
      if (broken && path === "packages/b/package.json") throw new Error("git show main:packages/b/package.json failed: fatal: bad object 1234");
      return `text of ${path}`;
    },
  });
  const ok = await readOldWorkspaceManifests(args, "/p", ["packages/a", "packages/c"], '{"workspaces":["packages/*"]}', reader(false));
  assert.deepEqual(ok, { "packages/a/package.json": "text of packages/a/package.json", "packages/b/package.json": "text of packages/b/package.json", "packages/c/package.json": null });
  await assert.rejects(readOldWorkspaceManifests(args, "/p", ["packages/a"], '{"workspaces":["packages/*"]}', reader(true)), /cannot read packages\/b\/package\.json at main.*bad object/s);
});

test("C4 --base: an unknown ref is exit 2 with the git message, not a silently empty baseline", async () => {
  await withTempProject({}, async (dir) => {
    git(dir, "init", "-q");
    await put(dir, { "package.json": pkg({ workspaces: ["packages/*"] }), "package-lock.json": lockOf("1.1.0"), "packages/a/package.json": "{}" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const c = capture();
    assert.equal(await runCli([dir, "--base", "no-such-ref"], c.io, okDeps()), 2);
    assert.match(c.err.join("\n"), /no-such-ref/);
  });
});

// ---- C5: selectors ---------------------------------------------------------------------------------------------------

test("C5 selectors: unnamed workspaces use path selectors where the manager has them, else are not tested alone", () => {
  const scope = { workspaceProject: true, workspace: { name: "packages/a", dir: "packages/a", unnamed: true } };
  assert.deepEqual(managerByName("pnpm").pinDependency("x", "1.0.0", "", scope), ["add", "x@1.0.0", "--filter", "./packages/a", "--lockfile-only", "--ignore-scripts"]);
  assert.deepEqual(managerByName("npm").pinDependency("x", "1.0.0", "", scope), ["install", "x@1.0.0", "-w", "packages/a", "--package-lock-only", "--ignore-scripts"]);
  assert.equal(managerByName("yarn").pinDependency("x", "1.0.0", "# yarn lockfile v1", scope), undefined);
  assert.equal(managerByName("yarn").pinDependency("x", "1.0.0", "__metadata:\n", scope), undefined);
});

test("C5 discovery marks unnamed workspaces", async () => {
  await withTempProject({ "package.json": JSON.stringify({ workspaces: ["p/*"] }), "p/a/package.json": "{}", "p/b/package.json": '{"name":"b"}' }, async (dir) => {
    const found = await discoverWorkspaces(dir);
    assert.deepEqual(found.map((w) => [w.name, w.unnamed ?? false]), [["p/a", true], ["b", false]]);
  });
});

test("C5 a workspace literally named (root) does not collide with the root manifest", async () => {
  const lock = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/chalk": { version: v } } });
  const oldLock = lock("4.0.0");
  const newLock = lock("4.1.0");
  const wsRoot = [{ name: "(root)", dir: "packages/r", manifest: {} }];
  const calls: unknown[] = [];
  const deps: PipelineDeps = {
    testLockfile: async (t) => (t === newLock ? fail : pass),
    testDependencyAt: async (_n, _v, scope) => {
      calls.push(scope);
      return fail;
    },
    fetchChangelog: async () => ({ source: "none", entries: [], missingVersions: [], availableVersions: ["4.0.0", "4.0.5", "4.1.0"], notes: [] }),
    scanUsage: async () => ({ sites: [{ file: "packages/r/x.ts", line: 1, symbol: "s", kind: "import", snippet: "x" }, { file: "top.ts", line: 1, symbol: "s", kind: "import", snippet: "x" }], unparsed: [] }),
  };
  const report = await runPipeline({ oldLockfile: oldLock, newLockfile: newLock, manifest: { dependencies: { chalk: "^4" } }, workspaces: wsRoot, config: { ...DEFAULT_CONFIG } }, deps);
  assert.deepEqual(calls[0], { workspaceProject: true }); // the root manifest declares it, not the workspace named "(root)"
  const w = report.verdicts[0]!.workspaces!;
  assert.deepEqual(w.declared, ["(root)"]);
  assert.equal(w.used.length, 2);
  assert.notEqual(w.used[0], w.used[1]);
});

// ---- T: plumbing, report shape, glob edges -----------------------------------------------------------------------

test("T realDeps: workspace files apply to the old lockfile's baseline only, always to probes", async () => {
  const { oldFilesFor } = await import("../src/pipeline/real.js");
  const opts = { projectDir: "/p", oldLockfile: "OLD", oldFiles: { "packages/a/package.json": "x" }, config: { ...DEFAULT_CONFIG } };
  assert.deepEqual(oldFilesFor(opts, "OLD"), opts.oldFiles);
  assert.equal(oldFilesFor(opts, "NEW"), undefined);
});

test("T report: JSON and Markdown carry the workspaces shape", async () => {
  const lock = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/chalk": { version: v } } });
  const ws = [{ name: "@acme/a", dir: "packages/a", manifest: { dependencies: { chalk: "^4" } } }];
  const deps: PipelineDeps = {
    testLockfile: async () => pass,
    testDependencyAt: async () => pass,
    fetchChangelog: async () => ({ source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] }),
    scanUsage: async () => ({ sites: [{ file: "packages/a/i.ts", line: 1, symbol: "red", kind: "import", snippet: "x" }], unparsed: [] }),
  };
  const report = await runPipeline({ oldLockfile: lock("4.0.0"), newLockfile: lock("4.1.0"), manifest: {}, workspaces: ws, config: { ...DEFAULT_CONFIG } }, deps);
  const json = JSON.parse(renderJson(report));
  assert.deepEqual(json.verdicts[0].workspaces, { declared: ["@acme/a"], used: ["@acme/a"] });
  assert.match(renderMarkdown(report), /`chalk` \[@acme\/a\]/);
  const single = await runPipeline({ oldLockfile: lock("4.0.0"), newLockfile: lock("4.1.0"), manifest: { dependencies: { chalk: "^4" } }, config: { ...DEFAULT_CONFIG } }, deps);
  assert.equal("workspaces" in JSON.parse(renderJson(single)).verdicts[0], false);
});

test("T glob edges: ** with negation, trailing slash, nested node_modules, backslash patterns", async () => {
  const p = (name: string) => JSON.stringify({ name });
  const files = { "packages/a/package.json": p("a"), "packages/deep/legacy/package.json": p("legacy"), "packages/deep/keep/package.json": p("keep"), "packages/a/node_modules/dep/package.json": p("dep"), "tools/t/package.json": p("t") };
  const names = (patterns: string[]) => withTempProject({ "package.json": JSON.stringify({ workspaces: patterns }), ...files }, async (dir) => (await discoverWorkspaces(dir)).map((w) => w.name));
  assert.deepEqual(await names(["packages/**", "!packages/**/legacy"]), ["a", "keep"]);
  assert.deepEqual(await names(["packages/**"]), ["a", "keep", "legacy"]);
  assert.deepEqual(await names(["tools/*/"]), ["t"]);
  assert.deepEqual(await names(["./tools/*"]), ["t"]);
  assert.deepEqual(await names(["packages\\a", "tools\\*"]), ["a", "t"]);
  assert.deepEqual(await names(["packages/**/node_modules/*"]), []);
});
