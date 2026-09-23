import { test } from "node:test";
import assert from "node:assert/strict";
import { withSandbox } from "../src/sandbox/index.js";
import { detectPackageManager, detectTestScript, installAndTest } from "../src/testrun/index.js";
import { generateLockfile, pkg, withTempProject } from "./helpers.js";

const nodeScript = (code: string) => `node -e "${code}"`;

async function outcomeFor(testScript: string | undefined, testTimeoutMs?: number) {
  const scripts = testScript === undefined ? {} : { test: testScript };
  return withTempProject({ "package.json": pkg({ scripts }) }, async (project) => {
    const lock = await generateLockfile(project);
    return withSandbox({ projectDir: project, lockfile: { name: "package-lock.json", content: lock } }, (sb) =>
      installAndTest(sb, { testTimeoutMs }),
    );
  });
}

test("detects package manager from lockfile presence", async () => {
  for (const [file, expected] of [
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["pnpm-lock.yaml", "pnpm"],
  ] as const) {
    await withTempProject({ [file]: "" }, async (dir) => assert.equal(detectPackageManager(dir), expected));
  }
  await withTempProject({ "package.json": "{}" }, async (dir) => assert.equal(detectPackageManager(dir), undefined));
});

test("detects scripts.test, and its absence", async () => {
  await withTempProject({ "package.json": pkg({ scripts: { test: "x" } }) }, async (dir) =>
    assert.equal(await detectTestScript(dir), "x"),
  );
  await withTempProject({ "package.json": pkg({}) }, async (dir) => assert.equal(await detectTestScript(dir), undefined));
});

test("passing test script is reported as passed", async () => {
  const outcome = await outcomeFor(nodeScript("process.exit(0)"));
  assert.equal(outcome.status, "passed");
});

test("failing test script is reported as failed with its output", async () => {
  const outcome = await outcomeFor(nodeScript("console.error('BOOM'); process.exit(1)"));
  assert.equal(outcome.status, "failed");
  assert.ok("result" in outcome && outcome.result.output.includes("BOOM"));
});

test("hung test script is a timed-out failure, not a hang", async () => {
  const outcome = await outcomeFor(nodeScript("setInterval(()=>{},1000)"), 1500);
  assert.equal(outcome.status, "timed-out");
});

test("project without a test script is reported, not run", async () => {
  assert.equal((await outcomeFor(undefined)).status, "no-test-script");
});

test("project without a lockfile is reported", async () => {
  await withTempProject({ "package.json": pkg({ scripts: { test: "x" } }) }, async (project) => {
    const outcome = await withSandbox({ projectDir: project }, (sb) => installAndTest(sb));
    assert.equal(outcome.status, "no-lockfile");
  });
});
