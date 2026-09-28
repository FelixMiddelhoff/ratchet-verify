import assert from "node:assert/strict";
import { test } from "node:test";
import type { PythonChangelogRequest, PythonChangelogResult } from "../../python-module/changelog.js";
import type { PythonPipelineDeps } from "../../python-module/pipeline.js";
import { runPythonPipeline } from "../../python-module/pipeline.js";
import type { PythonTestOutcome } from "../../python-module/testrun.js";
import type { RunResult } from "../../src/sandbox/exec.js";

const ok = (output = ""): RunResult => ({ exitCode: 0, timedOut: false, output, truncated: false });
const bad = (output = ""): RunResult => ({ exitCode: 1, timedOut: false, output, truncated: false });

const OLD_LOCK = `
[[package]]
name = "requests"
version = "2.31.0"
`;
const NEW_LOCK = `
[[package]]
name = "requests"
version = "2.32.3"
`;
const changelog: PythonChangelogResult = { source: "github-releases", entries: [], missingVersions: [], availableVersions: ["2.31.0", "2.31.5", "2.32.0", "2.32.3"], notes: [] };

function deps(overrides: Partial<PythonPipelineDeps> = {}): PythonPipelineDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    testLockfile: async (text) => {
      calls.push(`testLockfile:${text.includes("2.32.3") ? "new" : "old"}`);
      return { status: "passed", result: ok() };
    },
    testDependencyAt: async (name, version) => {
      calls.push(`testDependencyAt:${name}@${version}`);
      return { status: "passed", result: ok() };
    },
    fetchChangelog: async (request: PythonChangelogRequest) => {
      calls.push(`fetchChangelog:${request.name}`);
      return changelog;
    },
    ...overrides,
    calls,
  } as PythonPipelineDeps & { calls: string[] };
}

test("no dependency changes -> empty report, no calls", async () => {
  const d = deps();
  const report = await runPythonPipeline({ oldLockfileText: OLD_LOCK, newLockfileText: OLD_LOCK }, d);
  assert.deepEqual(report, { schemaVersion: 1, overall: "safe", verdicts: [] });
  assert.deepEqual(d.calls, []);
});

test("passing suite -> safe, single testLockfile call reused for the changed dependency", async () => {
  const d = deps();
  const report = await runPythonPipeline({ oldLockfileText: OLD_LOCK, newLockfileText: NEW_LOCK }, d);
  assert.equal(report.overall, "safe");
  assert.equal(report.verdicts[0]!.name, "requests");
  assert.deepEqual(d.calls, ["fetchChangelog:requests", "testLockfile:new"]);
});

test("failing suite, baseline also fails -> baseline-failing, no bisection attempted", async () => {
  const d = deps({
    testLockfile: async (text) => (text.includes("2.32.3") ? { status: "failed", result: bad("boom") } : { status: "failed", result: bad("already red") }),
  });
  const report = await runPythonPipeline({ oldLockfileText: OLD_LOCK, newLockfileText: NEW_LOCK }, d);
  assert.match(report.verdicts[0]!.summary, /already fails on the old lockfile/);
  assert.ok(!d.calls.some((c) => c.startsWith("testDependencyAt")));
});

test("failing suite, single changed dependency reproduces it alone -> bisected and blamed", async () => {
  const d = deps({
    testLockfile: async (text) => (text.includes("2.32.3") ? { status: "failed", result: bad("boom") } : { status: "passed", result: ok() }),
    testDependencyAt: async (_name, version) => (version === "2.32.3" || version === "2.32.0" ? { status: "failed", result: bad("boom") } : { status: "passed", result: ok() }),
  });
  const report = await runPythonPipeline({ oldLockfileText: OLD_LOCK, newLockfileText: NEW_LOCK, maxInstalls: 10 }, d);
  assert.equal(report.overall, "broken");
  assert.match(report.verdicts[0]!.summary, /broken by 2\.32\.0/);
});
