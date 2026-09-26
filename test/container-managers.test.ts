import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectRuntime, ensureImage, ensureManagerInImage, runCommand, withSandbox, type ContainerSettings } from "../src/sandbox/index.js";
import { installAndTest, managerByName } from "../src/testrun/index.js";
import { pkg, withTempProject } from "./helpers.js";

// ---- Preflight with a fake engine (always runs) ----

const fakeExec = (exitCode: number) => async () => ({ exitCode, timedOut: false, output: "", truncated: false });
const fake: ContainerSettings = { runtime: "docker", image: "node:24", rootless: false };

test("ensureManagerInImage: passes when the manager is in the image, otherwise names image, manager and the fix", async () => {
  await ensureManagerInImage(fake, "pnpm", fakeExec(0));
  await assert.rejects(ensureManagerInImage(fake, "pnpm", fakeExec(1)), /node:24 does not ship pnpm.*containerImage.*--isolation temp-dir/s);
  await assert.rejects(ensureManagerInImage(fake, "pnpm; rm -rf /", fakeExec(0)), /invalid package manager name/);
});

// ---- Real engine: managers inside the container (skipped without docker/podman; runs in CI) ----

const engine = await detectRuntime("auto");
const withEngine = (name: string, fn: () => Promise<void>) => test(name, { skip: engine ? false : "no container engine available", timeout: 900_000 }, fn);
const settings = (image: string): ContainerSettings => ({ runtime: engine!.runtime, rootless: engine!.rootless, image, network: "open" });
const hostEnv = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

/** Local derived image: node:24 plus the manager (this is also the recipe docs/configuration.md gives). */
async function buildManagerImage(tag: string, run: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-image-"));
  try {
    writeFileSync(join(dir, "Dockerfile"), `FROM node:24\nRUN ${run}\n`);
    const built = await runCommand({ command: engine!.runtime, args: ["build", "-t", tag, dir], cwd: dir, env: hostEnv(), timeoutMs: 600_000 });
    assert.equal(built.exitCode, 0, built.output);
    return tag;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

withEngine("container: the stock image lacks pnpm (preflight says so), npm and yarn are there", async () => {
  await ensureImage(settings("node:24"));
  await ensureManagerInImage(settings("node:24"), "npm");
  await ensureManagerInImage(settings("node:24"), "yarn");
  await assert.rejects(ensureManagerInImage(settings("node:24"), "pnpm"), /does not ship pnpm/);
});

for (const major of [9, 10]) withEngine(`container: pnpm ${major} installs from a lockfile, runs tests and pins one dependency, all inside the container`, async () => {
  const image = await buildManagerImage(`ratchet-test-pnpm${major}`, `npm install -g pnpm@${major}`);
  await ensureManagerInImage(settings(image), "pnpm");
  const files = { "package.json": pkg({ dependencies: { "is-number": "6.0.0" }, scripts: { test: `node -e "require('is-number')"` } }) };
  await withTempProject(files, async (project) => {
    const lock = await withSandbox({ projectDir: project, container: settings(image) }, async (sb) => {
      const made = await sb.run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], 300_000);
      assert.equal(made.exitCode, 0, made.output);
      return readFileSync(join(sb.dir, "pnpm-lock.yaml"), "utf8");
    });
    assert.match(lock, /is-number@?[/ ]*6\.0\.0/);
    const spec = managerByName("pnpm");
    const outcome = await withSandbox({ projectDir: project, container: settings(image), lockfile: { name: spec.lockfile, content: lock } }, (sb) => installAndTest(sb, { testTimeoutMs: 120_000 }));
    assert.equal(outcome.status, "passed", JSON.stringify(outcome));
    const pinned = await withSandbox({ projectDir: project, container: settings(image), lockfile: { name: spec.lockfile, content: lock } }, async (sb) => {
      const args = spec.pinDependency("is-number", "7.0.0", lock);
      assert.ok(args);
      const pin = await sb.run("pnpm", args, 300_000);
      assert.equal(pin.exitCode, 0, pin.output);
      return readFileSync(join(sb.dir, "pnpm-lock.yaml"), "utf8");
    });
    assert.match(pinned, /is-number@?[/ ]*7\.0\.0/);
  });
});

withEngine("container: yarn berry (release pinned by yarnPath, run by the image's yarn 1) installs and tests", async () => {
  const files = { "package.json": pkg({ dependencies: { "is-number": "6.0.0" }, scripts: { test: `node -e "require('is-number')"` } }) };
  await withTempProject(files, async (project) => {
    const made = await withSandbox({ projectDir: project, container: settings("node:24") }, async (sb) => {
      const set = await sb.run("yarn", ["set", "version", "4.9.2"], 300_000);
      assert.equal(set.exitCode, 0, set.output);
      const install = await sb.run("yarn", ["install", "--mode=skip-build"], 300_000);
      assert.equal(install.exitCode, 0, install.output);
      return {
        lock: readFileSync(join(sb.dir, "yarn.lock"), "utf8"),
        rc: readFileSync(join(sb.dir, ".yarnrc.yml"), "utf8"),
        release: readFileSync(join(sb.dir, ".yarn", "releases", "yarn-4.9.2.cjs")),
      };
    });
    assert.match(made.lock, /__metadata/);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(project, ".yarn", "releases"), { recursive: true });
    writeFileSync(join(project, ".yarnrc.yml"), made.rc);
    writeFileSync(join(project, ".yarn", "releases", "yarn-4.9.2.cjs"), made.release);
    const outcome = await withSandbox({ projectDir: project, container: settings("node:24"), lockfile: { name: "yarn.lock", content: made.lock } }, (sb) => installAndTest(sb, { testTimeoutMs: 120_000 }));
    assert.equal(outcome.status, "passed", JSON.stringify(outcome));
  });
});
