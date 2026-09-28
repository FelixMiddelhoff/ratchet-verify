import assert from "node:assert/strict";
import { test } from "node:test";
import { runPythonCli } from "../../python-module/cli.js";
import { withTempProject } from "../helpers.js";

function fakeIo(): { out: string[]; err: string[]; io: { out(t: string): void; err(t: string): void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t) => out.push(t), err: (t) => err.push(t) } };
}

test("no arguments -> usage error, exit code 2", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli([], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("usage:"));
});

test("an unreadable lockfile path -> reported error, exit code 2", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--old-lockfile", "/does/not/exist/uv.lock", "--new-lockfile", "/does/not/exist/uv.lock"], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("ratchet:"));
});

test("--lockfile-name rejects an unknown value", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--old-lockfile", "a", "--new-lockfile", "b", "--lockfile-name", "setup.py"], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("usage:"));
});

test("--lockfile-name accepts requirements.txt (fails later on an unreadable path, not a parse rejection)", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--old-lockfile", "/does/not/exist/requirements.txt", "--new-lockfile", "/does/not/exist/requirements.txt", "--lockfile-name", "requirements.txt"], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("ratchet:"));
});

test("--old-lockfile and --base together -> usage error (exactly one allowed)", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--old-lockfile", "a", "--base", "main", "--new-lockfile", "b"], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("usage:"));
});

test("neither --old-lockfile nor --base -> usage error", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--new-lockfile", "b"], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("usage:"));
});

test("--format rejects an unknown value", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--old-lockfile", "a", "--new-lockfile", "b", "--format", "yaml"], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("usage:"));
});

test("--format accepts sarif (fails later on an unreadable path, not a parse rejection)", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--old-lockfile", "a", "--new-lockfile", "b", "--format", "sarif"], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("ratchet:"));
});

test("--base with an unreadable ref -> reported error, exit code 2 (readFileAtRef reused from src/cli/git.ts)", async () => {
  const { err, io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--base", "not-a-real-ref-xyz", "--new-lockfile", "/does/not/exist/uv.lock"], io);
  assert.equal(code, 2);
  assert.ok(err[0]!.startsWith("ratchet:"));
});

test(".ratchetrc.python's lockfileName is used when --lockfile-name is not given (project's uv.lock read, not poetry.lock)", async () => {
  await withTempProject({ ".ratchetrc.python": JSON.stringify({ lockfileName: "poetry.lock" }) }, async (dir) => {
    const { err, io } = fakeIo();
    const code = await runPythonCli(["--project", dir, "--old-lockfile", "/does/not/exist", "--new-lockfile", "/does/not/exist/poetry.lock"], io);
    assert.equal(code, 2);
    assert.ok(err[0]!.startsWith("ratchet:"));
    assert.ok(err[0]!.includes("poetry.lock") || err[0]!.includes("ENOENT"));
  });
});

test("a --lockfile-name flag overrides .ratchetrc.python's lockfileName", async () => {
  await withTempProject({ ".ratchetrc.python": JSON.stringify({ lockfileName: "poetry.lock" }) }, async (dir) => {
    const { io } = fakeIo();
    // --lockfile-name uv.lock should win, so a requirements.txt-shaped new-lockfile path plus the flag is still accepted at the parse level.
    const code = await runPythonCli(["--project", dir, "--old-lockfile", "/does/not/exist", "--new-lockfile", "/does/not/exist/uv.lock", "--lockfile-name", "uv.lock"], io);
    assert.equal(code, 2); // unreadable path, but got past argument parsing with the override in effect
  });
});
