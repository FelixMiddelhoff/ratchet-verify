import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runPipeline, type PipelineDeps } from "../src/pipeline/index.js";
import type { TestOutcome } from "../src/testrun/index.js";
import type { ChangelogResult } from "../src/changelog/index.js";

const result = (output = "") => ({ exitCode: 0, timedOut: false, output, truncated: false });
const passed: TestOutcome = { status: "passed", result: result() };
const failed = (output = "FAIL"): TestOutcome => ({ status: "failed", result: { ...result(output), exitCode: 1 } });

const lock = (pkgs: Record<string, string>) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...Object.fromEntries(Object.entries(pkgs).map(([n, v]) => [`node_modules/${n}`, { version: v }])) } });

const changelog = (versions: string[]): ChangelogResult => ({
  source: "github-releases",
  entries: [],
  missingVersions: [],
  availableVersions: versions,
  notes: [],
});

/** Fake world where `brokenFrom[name]` is the first version of that package that fails. */
function world(brokenFrom: Record<string, string> = {}, options: { baselineFails?: boolean } = {}) {
  const calls: string[] = [];
  const order = (v: string) => Number(v.split(".")[1]);
  const deps: PipelineDeps = {
    async testLockfile(text) {
      calls.push("lockfile");
      const isNew = Object.entries(brokenFrom).some(([name, v]) => (JSON.parse(text).packages[`node_modules/${name}`]?.version ?? "0.0.0") >= v);
      if (options.baselineFails) return failed("already red");
      return isNew ? failed("new failing") : passed;
    },
    async testDependencyAt(name, version) {
      calls.push(`${name}@${version}`);
      const from = brokenFrom[name];
      return from !== undefined && order(version) >= order(from) ? failed(`${name} ${version} broke`) : passed;
    },
    async fetchChangelog() {
      return changelog(["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"]);
    },
    async scanUsage() {
      return { sites: [], unparsed: [] };
    },
  };
  return { deps, calls };
}

const manifest = { dependencies: { a: "^1", b: "^1" } };
const input = (oldPkgs: Record<string, string>, newPkgs: Record<string, string>) => ({
  oldLockfile: lock(oldPkgs),
  newLockfile: lock(newPkgs),
  manifest,
  config: { ...DEFAULT_CONFIG },
});

test("no changed dependencies: empty safe report, nothing run", async () => {
  const { deps, calls } = world();
  const report = await runPipeline(input({ a: "1.0.0" }, { a: "1.0.0" }), deps);
  assert.deepEqual([report.overall, report.verdicts.length, calls.length], ["safe", 0, 0]);
});

test("ignored packages are left out", async () => {
  const { deps } = world();
  const report = await runPipeline({ ...input({ a: "1.0.0" }, { a: "1.5.0" }), config: { ...DEFAULT_CONFIG, ignore: ["a"] } }, deps);
  assert.equal(report.verdicts.length, 0);
});

test("passing suite: every dependency shares the passing outcome, no isolation runs", async () => {
  const { deps, calls } = world();
  const report = await runPipeline(input({ a: "1.0.0", b: "1.0.0" }, { a: "1.5.0", b: "1.1.0" }), deps);
  assert.deepEqual(report.verdicts.map((v) => v.status), ["safe", "safe"]);
  assert.deepEqual(calls, ["lockfile"]);
});

test("single direct bump that fails: bisected to the exact version, no redundant isolation run", async () => {
  const { deps, calls } = world({ a: "1.3.0" });
  const report = await runPipeline(input({ a: "1.0.0" }, { a: "1.5.0" }), deps);
  const [v] = report.verdicts;
  assert.equal(v?.status, "broken");
  assert.match(v!.summary, /broken by 1\.3\.0/);
  assert.ok(!calls.includes("a@1.5.0") || calls.filter((c) => c === "a@1.5.0").length === 0, "endpoint not re-probed");
});

test("two direct bumps, one guilty: culprit bisected, the other is not cleared or blamed", async () => {
  const { deps } = world({ a: "1.3.0" });
  const report = await runPipeline(input({ a: "1.0.0", b: "1.0.0" }, { a: "1.5.0", b: "1.1.0" }), deps);
  const byName = Object.fromEntries(report.verdicts.map((v) => [v.name, v]));
  assert.equal(byName.a?.status, "broken");
  assert.match(byName.a!.summary, /1\.3\.0/);
  assert.equal(byName.b?.status, "safe"); // b passed on its own
});

test("transitive bump while a direct one is guilty: reported as not tested alone, never safe", async () => {
  const { deps } = world({ a: "1.3.0" });
  const report = await runPipeline(input({ a: "1.0.0", t: "1.0.0" }, { a: "1.5.0", t: "1.1.0" }), deps);
  const t = report.verdicts.find((v) => v.name === "t")!;
  assert.equal(t.status, "risky");
  assert.match(t.summary, /not tested on its own/);
  assert.match(t.summary, /a/);
});

test("failure no single direct bump reproduces: nobody is cleared", async () => {
  const { deps } = world();
  deps.testLockfile = async (text) => (text.includes('"1.5.0"') && text.includes('"1.1.0"') ? failed("interaction") : passed);
  const report = await runPipeline(input({ a: "1.0.0", b: "1.0.0" }, { a: "1.5.0", b: "1.1.0" }), deps);
  assert.deepEqual(report.verdicts.map((v) => v.status), ["broken", "broken"]);
  assert.match(report.verdicts[0]!.summary, /not isolated/);
});

test("suite already failing on the old lockfile: unverified, not broken", async () => {
  const { deps } = world({}, { baselineFails: true });
  const report = await runPipeline(input({ a: "1.0.0" }, { a: "1.5.0" }), deps);
  assert.equal(report.verdicts[0]?.status, "risky");
  assert.match(report.verdicts[0]!.summary, /already fails on the old lockfile/);
});

test("registry unreachable: broken but not bisected, with the failing output", async () => {
  const { deps } = world({ a: "1.3.0" });
  deps.fetchChangelog = async () => ({ ...changelog([]), source: "none" });
  const report = await runPipeline(input({ a: "1.0.0" }, { a: "1.5.0" }), deps);
  assert.equal(report.verdicts[0]?.status, "broken");
  assert.match(report.verdicts[0]!.summary, /not isolated/);
});

test("added dependency skips the changelog fetch", async () => {
  const { deps } = world();
  let fetched = false;
  deps.fetchChangelog = async () => {
    fetched = true;
    return changelog([]);
  };
  await runPipeline(input({}, { a: "1.0.0" }), deps);
  assert.equal(fetched, false);
});
