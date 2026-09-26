import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dropSymlinksRatchetWrites, withSandbox } from "../src/sandbox/index.js";
import type { SandboxProxy } from "../src/sandbox/proxy-client.js";

// threat: a pull request commits a symlink named like a file ratchet rewrites; the write must never reach the host file it points at.

const proxy: SandboxProxy = { network: "n", proxyUrl: "http://p:3128", registries: [{ id: "main", isDefault: true }], lockUrlMappings: [] };

function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false; // Windows without the symlink privilege
  }
}

test("symlinked .npmrc, lockfile and package.json in the checkout never make a write land outside the sandbox copy", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ratchet-symlink-"));
  try {
    const project = join(base, "project");
    mkdirSync(join(project, "packages", "a"), { recursive: true });
    const victims = { rc: join(base, "victim-rc"), lock: join(base, "victim-lock"), pkg: join(base, "victim-pkg"), nested: join(base, "victim-nested") };
    writeFileSync(victims.rc, "//host.example/:_authToken=HOST-SECRET-TOKEN\nkeep=me\n");
    for (const f of [victims.lock, victims.pkg, victims.nested]) writeFileSync(f, "original host content\n");
    writeFileSync(join(project, "yarn-note.txt"), "x");
    const ok = [
      link(victims.rc, join(project, ".npmrc")),
      link(victims.lock, join(project, "package-lock.json")),
      link(victims.pkg, join(project, "package.json")),
      link(victims.nested, join(project, "packages", "a", ".npmrc")),
    ];
    if (ok.includes(false)) return t.skip("cannot create symlinks here");

    await withSandbox(
      { projectDir: project, container: { runtime: "docker", image: "node:24", rootless: true }, proxy, lockfile: { name: "package-lock.json", content: '{"attacker":"controlled"}' }, packageJson: '{"name":"x"}' },
      async (sb) => {
        assert.ok(sb.dir.length > 0);
      },
    );
    assert.equal(readFileSync(victims.rc, "utf8"), "//host.example/:_authToken=HOST-SECRET-TOKEN\nkeep=me\n", "host .npmrc untouched");
    assert.equal(readFileSync(victims.lock, "utf8"), "original host content\n", "host file behind the lockfile link untouched");
    assert.equal(readFileSync(victims.pkg, "utf8"), "original host content\n", "host file behind the package.json link untouched");
    assert.equal(readFileSync(victims.nested, "utf8"), "original host content\n", "nested rc link target untouched");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("dropSymlinksRatchetWrites removes only links with those names, keeps regular files and other links", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-symlink-"));
  try {
    writeFileSync(join(dir, "target.txt"), "t");
    writeFileSync(join(dir, "package.json"), "{}");
    if (!link(join(dir, "target.txt"), join(dir, ".npmrc")) || !link(join(dir, "target.txt"), join(dir, "other-link"))) return t.skip("cannot create symlinks here");
    const dropped = await dropSymlinksRatchetWrites(dir);
    assert.deepEqual(dropped, [".npmrc"]);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), "{}");
    assert.equal(readFileSync(join(dir, "other-link"), "utf8"), "t", "unrelated links are left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
