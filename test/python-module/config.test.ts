import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PYTHON_CONFIG, loadPythonConfig, parsePythonConfig } from "../../python-module/config.js";
import { withTempProject } from "../helpers.js";

test("missing config file -> all defaults", async () => {
  await withTempProject({}, async (dir) => assert.deepEqual(await loadPythonConfig(dir), DEFAULT_PYTHON_CONFIG));
});

test("parsePythonConfig: valid fields override defaults, rest stay default", () => {
  const config = parsePythonConfig(JSON.stringify({ lockfileName: "poetry.lock", maxInstalls: 5 }));
  assert.equal(config.lockfileName, "poetry.lock");
  assert.equal(config.maxInstalls, 5);
  assert.equal(config.testTimeoutMs, DEFAULT_PYTHON_CONFIG.testTimeoutMs);
  assert.equal(config.format, "text");
});

test("parsePythonConfig: unknown key is an error, not silently ignored", () => {
  assert.throws(() => parsePythonConfig(JSON.stringify({ typo: true })), /unknown option/);
});

test("parsePythonConfig: rejects a bad lockfileName, format, and non-positive maxInstalls", () => {
  assert.throws(() => parsePythonConfig(JSON.stringify({ lockfileName: "setup.py" })), /"lockfileName"/);
  assert.throws(() => parsePythonConfig(JSON.stringify({ format: "yaml" })), /"format"/);
  assert.throws(() => parsePythonConfig(JSON.stringify({ maxInstalls: 0 })), /"maxInstalls"/);
});

test("loadPythonConfig reads .ratchetrc.python from the project directory", async () => {
  await withTempProject({ ".ratchetrc.python": JSON.stringify({ format: "json", testCommand: ["pytest", "-x"] }) }, async (dir) => {
    const config = await loadPythonConfig(dir);
    assert.equal(config.format, "json");
    assert.deepEqual(config.testCommand, ["pytest", "-x"]);
  });
});
