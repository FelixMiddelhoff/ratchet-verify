import assert from "node:assert/strict";
import { test } from "node:test";
import type { PythonSandbox } from "../../python-module/sandbox.js";
import { detectPythonManager, installAndTestPython } from "../../python-module/testrun.js";
import { withTempProject } from "../helpers.js";
import type { RunResult } from "../../src/sandbox/exec.js";

const ok = (output = ""): RunResult => ({ exitCode: 0, timedOut: false, output, truncated: false });
const bad = (output = "", exitCode = 1): RunResult => ({ exitCode, timedOut: false, output, truncated: false });

/** Records every call instead of running a real uv/poetry (not assumed installed on the dev/CI box). */
function fakeSandbox(dir: string, results: Record<string, RunResult>): PythonSandbox & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]): Promise<RunResult> => {
    const call = [command, ...args];
    calls.push(call);
    return results[call.join(" ")] ?? bad(`unexpected call: ${call.join(" ")}`);
  };
  return { dir, run, calls };
}

test("detects uv vs poetry from lockfile presence, and neither", async () => {
  await withTempProject({ "uv.lock": "" }, async (dir) => assert.equal(detectPythonManager(dir), "uv"));
  await withTempProject({ "poetry.lock": "" }, async (dir) => assert.equal(detectPythonManager(dir), "poetry"));
  await withTempProject({ "pyproject.toml": "" }, async (dir) => assert.equal(detectPythonManager(dir), undefined));
});

test("no lockfile -> no-manager, no calls made", async () => {
  await withTempProject({}, async (dir) => {
    const sandbox = fakeSandbox(dir, {});
    const outcome = await installAndTestPython(sandbox);
    assert.deepEqual(outcome, { status: "no-manager" });
    assert.deepEqual(sandbox.calls, []);
  });
});

test("uv: frozen sync then `uv run pytest`, passing", async () => {
  await withTempProject({ "uv.lock": "" }, async (dir) => {
    const sandbox = fakeSandbox(dir, { "uv sync --frozen": ok(), "uv run pytest": ok("5 passed") });
    const outcome = await installAndTestPython(sandbox);
    assert.equal(outcome.status, "passed");
    assert.deepEqual(sandbox.calls, [["uv", "sync", "--frozen"], ["uv", "run", "pytest"]]);
  });
});

test("poetry: install then `poetry run pytest`, failing with output kept", async () => {
  await withTempProject({ "poetry.lock": "" }, async (dir) => {
    const sandbox = fakeSandbox(dir, { "poetry install --no-interaction": ok(), "poetry run pytest": bad("1 failed") });
    const outcome = await installAndTestPython(sandbox);
    assert.equal(outcome.status, "failed");
    assert.ok("result" in outcome && outcome.result.output === "1 failed");
  });
});

test("install failure is reported as install-failed, test command never runs", async () => {
  await withTempProject({ "uv.lock": "" }, async (dir) => {
    const sandbox = fakeSandbox(dir, { "uv sync --frozen": bad("resolution conflict") });
    const outcome = await installAndTestPython(sandbox);
    assert.equal(outcome.status, "install-failed");
    assert.deepEqual(sandbox.calls, [["uv", "sync", "--frozen"]]);
  });
});

test("a timed-out test run is reported as timed-out, not failed", async () => {
  await withTempProject({ "uv.lock": "" }, async (dir) => {
    const sandbox = fakeSandbox(dir, { "uv sync --frozen": ok(), "uv run pytest": { exitCode: null, timedOut: true, output: "", truncated: false } });
    const outcome = await installAndTestPython(sandbox);
    assert.equal(outcome.status, "timed-out");
  });
});

test("testCommand option overrides the v1 default of pytest", async () => {
  await withTempProject({ "uv.lock": "" }, async (dir) => {
    const sandbox = fakeSandbox(dir, { "uv sync --frozen": ok(), "uv run python -m unittest": ok() });
    const outcome = await installAndTestPython(sandbox, { testCommand: ["python", "-m", "unittest"] });
    assert.equal(outcome.status, "passed");
  });
});
