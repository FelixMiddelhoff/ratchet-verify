import assert from "node:assert/strict";
import { readFile, symlink } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withPythonSandbox } from "../../python-module/sandbox.js";
import { withTempProject } from "../helpers.js";

test("copies the project, applies the candidate lockfile, and cleans up after", async () => {
  let sandboxDir = "";
  await withTempProject({ "pyproject.toml": "[project]\nname = 'x'\n", "app.py": "print('hi')" }, async (project) => {
    await withPythonSandbox({ projectDir: project, lockfile: { name: "uv.lock", content: "# candidate\n" } }, async (sandbox) => {
      sandboxDir = sandbox.dir;
      assert.equal(await readFile(join(sandbox.dir, "uv.lock"), "utf8"), "# candidate\n");
      assert.equal(await readFile(join(sandbox.dir, "app.py"), "utf8"), "print('hi')");
    });
  });
  await assert.rejects(readFile(sandboxDir, "utf8")); // temp dir removed on teardown
});

test("files option overwrites and deletes project-relative paths", async () => {
  await withTempProject({ "pyproject.toml": "old", "keep.py": "x" }, async (project) => {
    await withPythonSandbox({ projectDir: project, files: { "pyproject.toml": "new", "keep.py": null } }, async (sandbox) => {
      assert.equal(await readFile(join(sandbox.dir, "pyproject.toml"), "utf8"), "new");
      await assert.rejects(readFile(join(sandbox.dir, "keep.py"), "utf8"));
    });
  });
});

test("a project-relative file key with `..` is refused before anything is created", async () => {
  await withTempProject({}, async (project) => {
    await assert.rejects(
      withPythonSandbox({ projectDir: project, files: { "../escape.py": "x" } }, async () => {}),
      /outside the sandbox/,
    );
  });
});

test("a symlinked pyproject.toml/lockfile in the project is dropped, never written through", { skip: platform() === "win32" ? "symlinks need elevation on Windows CI runners" : false }, async () => {
  await withTempProject({ "real-target.txt": "host secret" }, async (project) => {
    await symlink(join(project, "real-target.txt"), join(project, "uv.lock"));
    await withPythonSandbox({ projectDir: project, lockfile: { name: "uv.lock", content: "candidate\n" } }, async (sandbox) => {
      assert.equal(await readFile(join(sandbox.dir, "uv.lock"), "utf8"), "candidate\n");
    });
  });
});
