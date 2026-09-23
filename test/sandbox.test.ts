import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSandboxEnv, runCommand, sandboxPaths, withSandbox } from "../src/sandbox/index.js";
import { generateLockfile, pkg, withTempProject } from "./helpers.js";

test("env: only allowlisted variables pass through, credentials never do", () => {
  const paths = sandboxPaths("/sb");
  const env = buildSandboxEnv(paths, {
    PATH: "/bin",
    GITHUB_TOKEN: "gh",
    NPM_TOKEN: "npm",
    AWS_SECRET_ACCESS_KEY: "aws",
    npm_config__authToken: "auth",
  });
  assert.equal(env.PATH, "/bin");
  for (const leaked of ["GITHUB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "npm_config__authToken"]) {
    assert.equal(leaked in env, false, leaked);
  }
});

test("env: home and npm user config are redirected into the sandbox", () => {
  const env = buildSandboxEnv(sandboxPaths("/sb"), {});
  assert.equal(env.HOME, sandboxPaths("/sb").home);
  assert.ok(env.npm_config_userconfig?.startsWith(sandboxPaths("/sb").home));
});

test("env: Windows-style mixed-case Path is still passed through", () => {
  assert.equal(buildSandboxEnv(sandboxPaths("/sb"), { Path: "C:\\bin" }).Path, "C:\\bin");
});

test("sandbox copies the project but not node_modules or .git, and cleans up", async () => {
  await withTempProject(
    { "package.json": pkg({}), "src/a.js": "1", "node_modules/x/i.js": "1", ".git/HEAD": "ref" },
    async (project) => {
      let sandboxDir = "";
      await withSandbox({ projectDir: project }, async (sb) => {
        sandboxDir = sb.dir;
        assert.ok(existsSync(join(sb.dir, "src/a.js")));
        assert.equal(existsSync(join(sb.dir, "node_modules")), false);
        assert.equal(existsSync(join(sb.dir, ".git")), false);
      });
      assert.equal(existsSync(sandboxDir), false);
    },
  );
});

test("sandbox is removed even when the work throws", async () => {
  await withTempProject({ "package.json": pkg({}) }, async (project) => {
    let sandboxDir = "";
    await assert.rejects(
      withSandbox({ projectDir: project }, async (sb) => {
        sandboxDir = sb.dir;
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(existsSync(sandboxDir), false);
  });
});

test("lockfile override replaces the project's lockfile in the sandbox only", async () => {
  await withTempProject({ "package.json": pkg({}), "package-lock.json": "old" }, async (project) => {
    await withSandbox({ projectDir: project, lockfile: { name: "package-lock.json", content: "new" } }, async (sb) => {
      assert.equal(readFileSync(join(sb.dir, "package-lock.json"), "utf8"), "new");
    });
    assert.equal(readFileSync(join(project, "package-lock.json"), "utf8"), "old");
  });
});

test("runCommand kills a hung process at the timeout", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>) },
    timeoutMs: 500,
  });
  assert.equal(result.timedOut, true);
});

test("runCommand keeps only the output tail when over the cap", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "console.log('x'.repeat(5000) + 'END')"],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>) },
    timeoutMs: 10_000,
    maxOutputBytes: 100,
  });
  assert.equal(result.truncated, true);
  assert.ok(result.output.includes("END"));
  assert.ok(result.output.length <= 100);
});

// A candidate install runs arbitrary lifecycle scripts (the "mini Shai-Hulud" attack class).
test("isolation: a malicious preinstall script sees no credentials and a sandboxed home", async () => {
  const probe = `
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    fs.writeFileSync(path.join(__dirname, "probe.json"), JSON.stringify({
      secret: process.env.SECRET_TOKEN ?? null,
      npmToken: process.env.NPM_TOKEN ?? null,
      home: os.homedir(),
    }));`;
  await withTempProject(
    {
      "package.json": pkg({ dependencies: { evil: "file:./evil" } }),
      "evil/package.json": pkg({ name: "evil", scripts: { preinstall: "node probe.js" } }),
      "evil/probe.js": probe,
    },
    async (project) => {
      const lock = await generateLockfile(project);
      const sourceEnv = { ...process.env, SECRET_TOKEN: "hunter2", NPM_TOKEN: "npm_abc" };
      await withSandbox({ projectDir: project, lockfile: { name: "package-lock.json", content: lock }, sourceEnv }, async (sb) => {
        const install = await sb.run("npm", ["ci"], 120_000);
        assert.equal(install.exitCode, 0, install.output);
        const seen = JSON.parse(readFileSync(join(sb.dir, "evil", "probe.json"), "utf8"));
        assert.equal(seen.secret, null);
        assert.equal(seen.npmToken, null);
        assert.ok(seen.home.includes("ratchet-sandbox-"), seen.home);
      });
    },
  );
});
