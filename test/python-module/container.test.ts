import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPythonContainerEnv, buildPythonRunArgs, detectRuntime, ensureImage, ensurePythonManagerInImage, runPythonInContainer, type Exec, type PythonContainerSettings } from "../../python-module/container.js";
import { withPythonSandbox } from "../../python-module/sandbox.js";
import { withTempProject } from "../helpers.js";

const docker: PythonContainerSettings = { runtime: "docker", image: "python:3.12-slim", rootless: false };
const ok = (output = ""): Awaited<ReturnType<Exec>> => ({ exitCode: 0, timedOut: false, output, truncated: false });
const fail = (): Awaited<ReturnType<Exec>> => ({ exitCode: 1, timedOut: false, output: "not found", truncated: false });

function fakeEngine(answer: (args: string[]) => Awaited<ReturnType<Exec>>) {
  const calls: { command: string; args: string[] }[] = [];
  const exec: Exec = async ({ command, args }) => {
    calls.push({ command, args });
    return answer(args);
  };
  return { exec, calls };
}

test("run args: a single bind mount, dropped capabilities, no host paths besides the sandbox root", () => {
  const args = buildPythonRunArgs({ settings: docker, root: "/tmp/ratchet-py-sandbox-abc", name: "n1", command: "uv", args: ["sync", "--frozen"] });
  const joined = args.join(" ");
  assert.equal(args.filter((a) => a === "--mount").length, 1);
  assert.match(joined, /--mount type=bind,source=\/tmp\/ratchet-py-sandbox-abc,target=\/sandbox --workdir \/sandbox\/project/);
  assert.match(joined, /--cap-drop ALL --security-opt no-new-privileges --pids-limit 1024/);
  assert.ok(!args.includes("-v") && !args.includes("--volume"), "no other volumes");
  assert.deepEqual(args.slice(-4), ["python:3.12-slim", "uv", "sync", "--frozen"], "image, then the command");
});

test("run args: offline adds --network none before the image; default run has no --network flag", () => {
  const off = buildPythonRunArgs({ settings: docker, root: "/r", name: "n", command: "uv", args: ["run", "pytest"], offline: true });
  const i = off.indexOf("--network");
  assert.deepEqual(off.slice(i, i + 2), ["--network", "none"]);
  assert.ok(!buildPythonRunArgs({ settings: docker, root: "/r", name: "n", command: "uv", args: ["sync"] }).includes("--network"));
});

test("run args: rejects a comma in the root path and a reserved/invalid network name", () => {
  assert.throws(() => buildPythonRunArgs({ settings: docker, root: "/r,x", name: "n", command: "uv", args: [] }), /comma/);
  assert.throws(() => buildPythonRunArgs({ settings: docker, root: "/r", name: "n", command: "uv", args: [], network: "host" }), /refusing network/);
  assert.throws(() => buildPythonRunArgs({ settings: docker, root: "/r", name: "n", command: "uv", args: [], network: "bad name" }), /refusing network/);
});

test("container env: HOME/XDG/pip/uv/poetry all redirected under the sandbox mount, nothing else", () => {
  const env = buildPythonContainerEnv();
  assert.equal(env.HOME, "/sandbox/.home");
  assert.equal(env.PIP_CACHE_DIR, "/sandbox/.home/.cache/pip");
  assert.equal(env.UV_CACHE_DIR, "/sandbox/.home/.cache/uv");
  assert.equal(env.POETRY_CACHE_DIR, "/sandbox/.home/.cache/pypoetry");
  assert.equal(env.XDG_CONFIG_HOME, "/sandbox/.home/.config");
});

test("runPythonInContainer: only the offline phase gets --network none", async () => {
  const netFlag = async (phase?: { offline?: boolean }) => {
    const engine = fakeEngine(() => ok());
    await runPythonInContainer(docker, "/r", "uv", ["run", "pytest"], 1000, engine.exec, phase);
    return engine.calls[0]!.args.includes("none");
  };
  assert.equal(await netFlag(), false);
  assert.equal(await netFlag({ offline: true }), true);
});

test("ensurePythonManagerInImage: passes when found, throws an actionable message when missing", async () => {
  await assert.doesNotReject(ensurePythonManagerInImage(docker, "uv", fakeEngine(() => ok()).exec));
  await assert.rejects(ensurePythonManagerInImage(docker, "poetry", fakeEngine(() => fail()).exec), /does not ship poetry/);
});

test("ensurePythonManagerInImage: pip is assumed present, never probed for", async () => {
  const engine = fakeEngine(() => fail());
  await assert.doesNotReject(ensurePythonManagerInImage(docker, "pip", engine.exec));
  assert.equal(engine.calls.length, 0);
});

// ---- Real engine (skipped where docker/podman is unavailable) ----

const engine = await detectRuntime("auto");
const withEngine = (name: string, fn: () => Promise<void>) => test(name, { skip: engine ? false : "no container engine available" }, fn);
const settings = (): PythonContainerSettings => ({ runtime: engine!.runtime, rootless: engine!.rootless, image: "python:3.12-slim" });

withEngine("container: image is available, and withPythonSandbox routes a real command through it", async () => {
  await ensureImage(settings());
  await withTempProject({ "app.py": "print('hi')" }, async (project) => {
    await withPythonSandbox({ projectDir: project, container: settings() }, async (sandbox) => {
      assert.equal(sandbox.isolation, "container");
      const result = await sandbox.run("python3", ["-c", "print('ran in container')"], 60_000);
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /ran in container/);
    });
  });
});
