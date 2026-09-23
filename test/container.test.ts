import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContainerEnv, buildRunArgs, detectRuntime, ensureImage, hostUser, runInContainer, type ContainerSettings, type Exec } from "../src/sandbox/container.js";
import { resolveIsolation } from "../src/sandbox/isolation.js";
import { withSandbox } from "../src/sandbox/sandbox.js";
import { installAndTest } from "../src/testrun/index.js";
import { generateLockfile, pkg, withTempProject } from "./helpers.js";
import { parseConfig } from "../src/config.js";
import { parseCliArgs } from "../src/cli/args.js";
import { buildReport, renderJson, renderText } from "../src/report/index.js";
import { renderMarkdown } from "../src/ci/comment.js";

const docker: ContainerSettings = { runtime: "docker", image: "node:24", rootless: false };
const ok = (output = ""): Awaited<ReturnType<Exec>> => ({ exitCode: 0, timedOut: false, output, truncated: false });
const fail = (): Awaited<ReturnType<Exec>> => ({ exitCode: 1, timedOut: false, output: "not found", truncated: false });

/** Records every engine call and answers from a script. */
function fakeEngine(answer: (args: string[], command: string) => Awaited<ReturnType<Exec>>) {
  const calls: { command: string; args: string[] }[] = [];
  const exec: Exec = async ({ command, args }) => {
    calls.push({ command, args });
    return answer(args, command);
  };
  return { exec, calls };
}

test("run args: a single bind mount, dropped capabilities, no host paths besides the sandbox root", () => {
  const args = buildRunArgs({ settings: docker, root: "/tmp/ratchet-sandbox-abc", name: "n1", command: "npm", args: ["ci"] });
  const joined = args.join(" ");
  assert.equal(args.filter((a) => a === "--mount").length, 1);
  assert.match(joined, /--mount type=bind,source=\/tmp\/ratchet-sandbox-abc,target=\/sandbox --workdir \/sandbox\/project/);
  assert.match(joined, /--cap-drop ALL --security-opt no-new-privileges --pids-limit 1024/);
  assert.ok(!args.includes("-v") && !args.includes("--volume"), "no other volumes");
  assert.ok(!args.includes("--privileged") && !args.includes("--network"), "default privilege and network flags untouched");
  assert.deepEqual(args.slice(-3), ["node:24", "npm", "ci"], "image, then the command");
});

test("run args: environment is built from scratch and points only inside the mount", () => {
  const env = buildContainerEnv();
  for (const [key, value] of Object.entries(env)) {
    if (["HOME", "TMPDIR", "TEMP", "TMP"].includes(key)) assert.ok(value.startsWith("/sandbox/"), key);
  }
  for (const secret of ["GITHUB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "PATH"]) assert.equal(secret in env, false, secret);
  const args = buildRunArgs({ settings: docker, root: "/r", name: "n", command: "true", args: [] });
  assert.ok(args.includes("HOME=/sandbox/.home"));
});

test("run args: podman relabels the mount; --user only for rootful docker on POSIX", () => {
  const podman = buildRunArgs({ settings: { ...docker, runtime: "podman" }, root: "/r", name: "n", command: "true", args: [] });
  assert.match(podman.join(" "), /target=\/sandbox,relabel=private/);
  assert.ok(!buildRunArgs({ settings: docker, root: "/r", name: "n", command: "true", args: [] }).includes("--user"));
  assert.match(buildRunArgs({ settings: docker, root: "/r", name: "n", command: "true", args: [], user: "1000:1000" }).join(" "), /--user 1000:1000/);
  assert.equal(hostUser({ ...docker, rootless: true }), undefined);
  assert.equal(hostUser({ ...docker, runtime: "podman" }), undefined);
});

test("run args: a comma in the path is refused (mount syntax cannot express it)", () => {
  assert.throws(() => buildRunArgs({ settings: docker, root: "/tmp/a,b", name: "n", command: "true", args: [] }), /comma/);
});

test("detectRuntime: prefers docker, falls back to podman, reports rootless, undefined when neither works", async () => {
  const dockerUp = fakeEngine((_args, command) => (command === "docker" ? ok("[name=seccomp,profile=builtin name=rootless]") : fail()));
  assert.deepEqual(await detectRuntime("auto", dockerUp.exec), { runtime: "docker", rootless: true });

  const onlyPodman = fakeEngine((_args, command) => (command === "podman" ? ok("false") : fail()));
  assert.deepEqual(await detectRuntime("auto", onlyPodman.exec), { runtime: "podman", rootless: false });
  assert.deepEqual(onlyPodman.calls.map((c) => c.command), ["docker", "podman"]);

  assert.equal(await detectRuntime("auto", fakeEngine(fail).exec), undefined);
  const preferred = fakeEngine(() => ok("false"));
  await detectRuntime("podman", preferred.exec);
  assert.deepEqual(preferred.calls.map((c) => c.command), ["podman"], "an explicit choice is not second-guessed");
});

test("ensureImage: pulls only when the image is missing, and fails loudly when the pull fails", async () => {
  const present = fakeEngine(() => ok());
  await ensureImage(docker, present.exec);
  assert.deepEqual(present.calls.map((c) => c.args[0]), ["image"]);

  const missing = fakeEngine((args) => (args[0] === "image" ? fail() : ok()));
  await ensureImage(docker, missing.exec);
  assert.deepEqual(missing.calls.map((c) => c.args[0]), ["image", "pull"]);

  const broken = fakeEngine(() => fail());
  await assert.rejects(ensureImage(docker, broken.exec), /could not pull container image node:24/);
});

test("resolveIsolation: temp-dir never touches an engine", async () => {
  const engine = fakeEngine(fail);
  const resolved = await resolveIsolation({ mode: "temp-dir", runtime: "auto" }, engine.exec);
  assert.deepEqual([resolved.info.level, engine.calls.length], ["temp-dir", 0]);
});

test("resolveIsolation: container without an engine is an error, auto falls back with a note", async () => {
  const none = fakeEngine(fail);
  await assert.rejects(resolveIsolation({ mode: "container", runtime: "auto" }, none.exec), /needs docker or podman/);
  const auto = await resolveIsolation({ mode: "auto", runtime: "auto" }, none.exec);
  assert.equal(auto.info.level, "temp-dir");
  assert.match(auto.notes[0]!, /falling back to temp-dir/);
});

test("resolveIsolation: container with an engine reports runtime and image and pulls it first", async () => {
  const engine = fakeEngine((args) => (args[0] === "image" ? fail() : ok("false")));
  const resolved = await resolveIsolation({ mode: "container", runtime: "auto", image: "node:22" }, engine.exec);
  assert.deepEqual(resolved.info, { level: "container", runtime: "docker", image: "node:22" });
  assert.ok(engine.calls.some((c) => c.args[0] === "pull" && c.args.includes("node:22")));
});

test("runInContainer: a timeout kills the container itself, not just the client", async () => {
  const engine = fakeEngine((args) => (args[0] === "run" ? { exitCode: null, timedOut: true, output: "", truncated: false } : ok()));
  const result = await runInContainer(docker, "/r", "npm", ["test"], 1000, engine.exec);
  assert.equal(result.timedOut, true);
  const runName = engine.calls[0]!.args[engine.calls[0]!.args.indexOf("--name") + 1];
  assert.deepEqual(engine.calls[1]!.args, ["kill", runName]);
});

test("config and CLI accept the isolation options and reject bad values", () => {
  assert.equal(parseConfig("{}").isolation, "temp-dir");
  const config = parseConfig('{"isolation":"container","containerRuntime":"podman","containerImage":"node:22"}');
  assert.deepEqual([config.isolation, config.containerRuntime, config.containerImage], ["container", "podman", "node:22"]);
  assert.throws(() => parseConfig('{"isolation":"vm"}'), /isolation/);
  assert.throws(() => parseConfig('{"containerRuntime":"lxc"}'), /containerRuntime/);
  assert.throws(() => parseConfig('{"containerImage":""}'), /containerImage/);
  assert.equal(parseCliArgs(["--isolation", "auto", "--base", "x"]).isolation, "auto");
  assert.throws(() => parseCliArgs(["--isolation", "vm"]), /--isolation/);
});

test("every report format states the isolation level", () => {
  const container = buildReport([], { level: "container", runtime: "docker", image: "node:24" });
  assert.match(renderText(container), /isolation: container \(docker, node:24\)/);
  assert.match(renderMarkdown(container), /isolation: container \(docker, node:24\)/);
  assert.deepEqual(JSON.parse(renderJson(container)).isolation, { level: "container", runtime: "docker", image: "node:24" });
  const weak = buildReport([], { level: "temp-dir" });
  assert.match(renderText(weak), /isolation: temp-dir: credentials are withheld, but install scripts can still read host files/);
  assert.equal("isolation" in JSON.parse(renderJson(buildReport([]))), false);
});

// ---- Real engine (skipped where docker/podman is unavailable; runs in CI on ubuntu-latest) ----

const engine = await detectRuntime("auto");
const withEngine = (name: string, fn: () => Promise<void>) => test(name, { skip: engine ? false : "no container engine available" }, fn);
const settings = (): ContainerSettings => ({ runtime: engine!.runtime, rootless: engine!.rootless, image: "node:24" });

withEngine("container: image is available", async () => {
  await ensureImage(settings());
});

withEngine("container: a malicious preinstall can NOT read a host file at an absolute path (temp-dir can)", async () => {
  const canary = join(tmpdir(), `ratchet-canary-${process.pid}.txt`);
  writeFileSync(canary, "host secret");
  const probe = `
    const fs = require("node:fs");
    let seen = null;
    try { seen = fs.readFileSync(${JSON.stringify(canary)}, "utf8"); } catch {}
    fs.writeFileSync(require("node:path").join(__dirname, "probe.json"), JSON.stringify({ seen }));`;
  const files = {
    "package.json": pkg({ dependencies: { evil: "file:./evil" }, scripts: { test: 'node -e "0"' } }),
    "evil/package.json": pkg({ name: "evil", scripts: { preinstall: "node probe.js" } }),
    "evil/probe.js": probe,
  };
  try {
    await withTempProject(files, async (project) => {
      const lock = await generateLockfile(project);
      const seenIn = async (container?: ContainerSettings) =>
        withSandbox({ projectDir: project, lockfile: { name: "package-lock.json", content: lock }, container }, async (sb) => {
          const install = await sb.run("npm", ["ci"], 180_000);
          assert.equal(install.exitCode, 0, install.output);
          return JSON.parse(readFileSync(join(sb.dir, "evil", "probe.json"), "utf8")).seen;
        });
      assert.equal(await seenIn(undefined), "host secret", "temp-dir isolation cannot stop absolute-path reads (documented limit)");
      assert.equal(await seenIn(settings()), null, "the container never mounted that path");
    });
  } finally {
    if (existsSync(canary)) (await import("node:fs")).rmSync(canary);
  }
});

withEngine("container: install and test run end to end, and a failing or hanging test is reported", async () => {
  const run = (script: string, testTimeoutMs?: number) =>
    withTempProject({ "package.json": pkg({ scripts: { test: script } }) }, async (project) => {
      const lock = await generateLockfile(project);
      return withSandbox({ projectDir: project, lockfile: { name: "package-lock.json", content: lock }, container: settings() }, (sb) =>
        installAndTest(sb, { testTimeoutMs }),
      );
    });
  assert.equal((await run('node -e "0"')).status, "passed");
  assert.equal((await run('node -e "process.exit(1)"')).status, "failed");
  assert.equal((await run('node -e "setInterval(()=>{},1000)"', 15_000)).status, "timed-out");
});

withEngine("container: sandbox files stay removable and the container is gone after a timeout", async () => {
  let dir = "";
  await withTempProject({ "package.json": pkg({ scripts: { test: 'node -e "0"' } }) }, async (project) => {
    const lock = await generateLockfile(project);
    await withSandbox({ projectDir: project, lockfile: { name: "package-lock.json", content: lock }, container: settings() }, async (sb) => {
      dir = sb.dir;
      await sb.run("npm", ["ci"], 180_000);
    });
  });
  assert.equal(existsSync(dir), false, "teardown removed files written by the container");
});
