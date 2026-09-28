import assert from "node:assert/strict";
import { test } from "node:test";
import { runPythonCli } from "../../python-module/cli.js";

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
  const { io } = fakeIo();
  const code = await runPythonCli(["--project", ".", "--old-lockfile", "a", "--new-lockfile", "b", "--lockfile-name", "requirements.txt"], io);
  assert.equal(code, 2);
});
