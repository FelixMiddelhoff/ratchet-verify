import assert from "node:assert/strict";
import { test } from "node:test";
import { diffPythonLockfiles, normalizePackageName, parsePythonLock } from "../../python-module/lockfile.js";

const POETRY_LOCK_OLD = `
[[package]]
name = "requests"
version = "2.31.0"
description = "Python HTTP for Humans."
optional = false
python-versions = ">=3.7"

[[package]]
name = "Flask_Cors"
version = "3.0.10"
description = "..."
`;

const POETRY_LOCK_NEW = `
[[package]]
name = "requests"
version = "2.32.3"
description = "Python HTTP for Humans."
optional = false
python-versions = ">=3.7"

[[package]]
name = "urllib3"
version = "2.2.2"
description = "..."
`;

const UV_LOCK = `
version = 1
requires-python = ">=3.11"

[[package]]
name = "requests"
version = "2.31.0"
source = { registry = "https://pypi.org/simple" }

[package.metadata]
requires-dist = []
`;

test("parsePythonLock reads poetry.lock [[package]] tables", () => {
  const pkgs = parsePythonLock(POETRY_LOCK_OLD);
  assert.equal(pkgs.size, 2);
  assert.deepEqual(pkgs.get("requests"), { name: "requests", version: "2.31.0" });
  // PEP 503 normalization: "Flask_Cors" -> "flask-cors".
  assert.deepEqual(pkgs.get("flask-cors"), { name: "Flask_Cors", version: "3.0.10" });
});

test("parsePythonLock reads uv.lock, ignoring non-package tables", () => {
  const pkgs = parsePythonLock(UV_LOCK);
  assert.equal(pkgs.size, 1);
  assert.deepEqual(pkgs.get("requests"), { name: "requests", version: "2.31.0" });
});

test("normalizePackageName treats -, _, . as equivalent and case-insensitive", () => {
  assert.equal(normalizePackageName("Flask_Cors"), "flask-cors");
  assert.equal(normalizePackageName("flask.cors"), "flask-cors");
  assert.equal(normalizePackageName("flask--cors"), "flask-cors");
});

test("diffPythonLockfiles reports changed, added and removed", () => {
  const changes = diffPythonLockfiles(parsePythonLock(POETRY_LOCK_OLD), parsePythonLock(POETRY_LOCK_NEW));
  assert.deepEqual(changes, [
    { name: "requests", kind: "changed", oldVersion: "2.31.0", newVersion: "2.32.3" },
    { name: "Flask_Cors", kind: "removed", oldVersion: "3.0.10" },
    { name: "urllib3", kind: "added", oldVersion: undefined, newVersion: "2.2.2" },
  ].sort((a, b) => a.name.localeCompare(b.name)));
});
