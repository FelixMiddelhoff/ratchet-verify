import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCliArgs } from "../src/cli/args.js";
import { runCli, type DepsFactory } from "../src/cli/main.js";
import { parseConfig } from "../src/config.js";
import { pkg, withTempProject } from "./helpers.js";

const lock = (v: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lib": { version: v } } });

const passResult = { exitCode: 0, timedOut: false, output: "", truncated: false };
const fakeDeps = (status: "passed" | "failed"): DepsFactory => () => ({
  // Only the new lockfile (1.1.0) is affected; the old baseline always passes.
  testLockfile: async (text) => ({ status: text.includes("1.1.0") ? status : "passed", result: passResult }),
  testDependencyAt: async () => ({ status: "passed", result: passResult }),
  fetchChangelog: async () => ({ source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] }),
  scanUsage: async () => ({ sites: [], unparsed: [] }),
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), env: {} }, out, err };
}

const files = { "package.json": pkg({ dependencies: { lib: "^1" } }), "package-lock.json": lock("1.1.0"), "old-lock.json": lock("1.0.0") };

test("args: defaults, flags and validation", () => {
  assert.deepEqual(parseCliArgs(["--base", "main"]), {
    projectDir: ".", base: "main", oldLockfile: undefined, oldPackageJson: undefined, newLockfile: undefined, format: "text", failOn: undefined, isolation: undefined, network: undefined, reportDir: undefined, help: false, version: false,
  });
  assert.equal(parseCliArgs(["proj", "--old", "o.json", "--json"]).format, "json");
  assert.equal(parseCliArgs(["--sarif", "--old", "o"]).format, "sarif");
  assert.throws(() => parseCliArgs(["--json", "--sarif"]), /mutually exclusive/);
  assert.throws(() => parseCliArgs(["--base", "x", "--old", "y"]), /mutually exclusive/);
  assert.throws(() => parseCliArgs(["--fail-on", "nope"]), /--fail-on/);
  assert.throws(() => parseCliArgs(["a", "b"]), /at most one/);
  assert.throws(() => parseCliArgs(["--bogus"]));
});

test("config: defaults, overrides, and strict validation", () => {
  assert.equal(parseConfig("{}").maxInstalls, 10);
  assert.deepEqual(parseConfig('{"ignore":["x"],"failOn":"risky"}').ignore, ["x"]);
  assert.throws(() => parseConfig('{"ignor":[]}'), /unknown option/);
  assert.throws(() => parseConfig('{"maxInstalls":0}'), /maxInstalls/);
  assert.throws(() => parseConfig('{"failOn":"safe"}'), /failOn/);
  assert.throws(() => parseConfig('{"ignore":"x"}'), /ignore/);
});

test("--help prints usage and exits 0", async () => {
  const { io, out } = capture();
  assert.equal(await runCli(["--help"], io), 0);
  assert.match(out[0]!, /Usage: ratchet/);
});

test("missing --base/--old is a usage error (exit 2)", async () => {
  const { io, err } = capture();
  assert.equal(await runCli([], io), 2);
  assert.match(err[0]!, /--base/);
});

test("passing bump: text report, exit 0", async () => {
  await withTempProject(files, async (dir) => {
    const { io, out } = capture();
    const code = await runCli([dir, "--old", join(dir, "old-lock.json")], io, fakeDeps("passed"));
    assert.equal(code, 0);
    assert.match(out[0]!, /lib 1\.0\.0 -> 1\.1\.0 \(direct\)/);
  });
});

test("failing bump: exit 1; --json output parses", async () => {
  await withTempProject(files, async (dir) => {
    const { io, out } = capture();
    const code = await runCli([dir, "--old", join(dir, "old-lock.json"), "--json"], io, fakeDeps("failed"));
    assert.equal(code, 1);
    assert.equal(JSON.parse(out[0]!).overall, "broken");
  });
});

test("--fail-on risky turns a risky verdict into exit 1, default does not", async () => {
  await withTempProject({ ...files, "package.json": pkg({ dependencies: { lib: "^1" } }) }, async (dir) => {
    // A project with no test script yields the "unverified" (risky) verdict.
    const noTests: DepsFactory = () => ({ ...fakeDeps("passed")({ projectDir: dir, oldLockfile: "", manager: "npm", isolation: { info: { level: "temp-dir" }, notes: [] } }), testLockfile: async () => ({ status: "no-test-script" as const }) });
    const base = [dir, "--old", join(dir, "old-lock.json")];
    assert.equal(await runCli(base, capture().io, noTests), 0);
    assert.equal(await runCli([...base, "--fail-on", "risky"], capture().io, noTests), 1);
  });
});

test(".ratchetrc is loaded: ignore removes the dependency", async () => {
  await withTempProject({ ...files, ".ratchetrc": '{"ignore":["lib"]}' }, async (dir) => {
    const { io, out } = capture();
    assert.equal(await runCli([dir, "--old", join(dir, "old-lock.json"), "--json"], io, fakeDeps("failed")), 0);
    assert.equal(JSON.parse(out[0]!).verdicts.length, 0);
  });
});

test("bad .ratchetrc is a runtime error (exit 2) naming the problem", async () => {
  await withTempProject({ ...files, ".ratchetrc": '{"typo":1}' }, async (dir) => {
    const { io, err } = capture();
    assert.equal(await runCli([dir, "--old", join(dir, "old-lock.json")], io, fakeDeps("passed")), 2);
    assert.match(err[0]!, /unknown option/);
  });
});

test("--base reads the lockfile from a git ref", async () => {
  await withTempProject(files, async (dir) => {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    // Commit the OLD lockfile as package-lock.json, then restore the new one in the working tree.
    const { copyFileSync, writeFileSync, readFileSync } = await import("node:fs");
    const newLock = readFileSync(join(dir, "package-lock.json"), "utf8");
    copyFileSync(join(dir, "old-lock.json"), join(dir, "package-lock.json"));
    git("add", "package.json", "package-lock.json");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "package-lock.json"), newLock);

    const { io, out } = capture();
    assert.equal(await runCli([dir, "--base", "HEAD", "--json"], io, fakeDeps("passed")), 0);
    assert.equal(JSON.parse(out[0]!).verdicts[0].oldVersion, "1.0.0");
  });
});

test("unreadable base ref is a runtime error", async () => {
  await withTempProject(files, async (dir) => {
    const { io, err } = capture();
    assert.equal(await runCli([dir, "--base", "nope"], io, fakeDeps("passed")), 2);
    assert.match(err[0]!, /git show/);
  });
});

test("missing lockfile: explains what is supported instead of ENOENT", async () => {
  await withTempProject({ "package.json": pkg({}), "old.json": lock("1.0.0") }, async (dir) => {
    const { io, err } = capture();
    assert.equal(await runCli([dir, "--old", join(dir, "old.json")], io, fakeDeps("passed")), 2);
    assert.match(err[0]!, /no lockfile at .*npm install/);
  });
});

test("--version prints the package version", async () => {
  const { io, out } = capture();
  assert.equal(await runCli(["--version"], io), 0);
  assert.match(out[0]!, /^\d+\.\d+\.\d+/);
});

const yarnLock = (v: string) => `# yarn lockfile v1


lib@^1:
  version "${v}"
  resolved "https://registry.yarnpkg.com/lib/-/lib-${v}.tgz#abc"
`;

test("yarn.lock project: lockfile detected, base read with git show, manager passed to deps", async () => {
  await withTempProject({ "package.json": pkg({ dependencies: { lib: "^1" }, scripts: { test: "x" } }), "yarn.lock": yarnLock("1.0.0") }, async (dir) => {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...a], { cwd: dir });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    await writeFile(join(dir, "yarn.lock"), yarnLock("1.1.0"));
    const seen: string[] = [];
    const factory: DepsFactory = (o) => (seen.push(o.manager), fakeDeps("passed")(o));
    const { io, out } = capture();
    assert.equal(await runCli([dir, "--base", "HEAD", ], io, factory), 0);
    assert.deepEqual(seen, ["yarn"]);
    assert.match(out[0]!, /lib 1\.0\.0 -> 1\.1\.0 \(direct\)/);
  });
});

const pnpmLock = (v: string) => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      lib:
        specifier: ^1
        version: ${v}

packages:

  lib@${v}:
    resolution: {integrity: sha512-x}

snapshots:

  lib@${v}: {}
`;

test("pnpm-lock.yaml project: lockfile detected, base read with git show, manager passed to deps", async () => {
  await withTempProject({ "package.json": pkg({ dependencies: { lib: "^1" }, scripts: { test: "x" } }), "pnpm-lock.yaml": pnpmLock("1.0.0") }, async (dir) => {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...a], { cwd: dir });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    await writeFile(join(dir, "pnpm-lock.yaml"), pnpmLock("1.1.0"));
    const seen: string[] = [];
    const factory: DepsFactory = (o) => (seen.push(o.manager), fakeDeps("passed")(o));
    const { io, out } = capture();
    assert.equal(await runCli([dir, "--base", "HEAD"], io, factory), 0);
    assert.deepEqual(seen, ["pnpm"]);
    assert.match(out[0]!, /lib 1\.0\.0 -> 1\.1\.0 \(direct\)/);
  });
});

test("--old pnpm lockfile with an arbitrary file name is recognised by content", async () => {
  await withTempProject({ "package.json": pkg({ dependencies: { lib: "^1" }, scripts: { test: "x" } }), "pnpm-lock.yaml": pnpmLock("1.1.0"), "old.yaml": pnpmLock("1.0.0") }, async (dir) => {
    const seen: string[] = [];
    const factory: DepsFactory = (o) => (seen.push(o.manager), fakeDeps("passed")(o));
    const { io } = capture();
    assert.equal(await runCli([dir, "--old", join(dir, "old.yaml")], io, factory), 0);
    assert.deepEqual(seen, ["pnpm"]);
  });
});
