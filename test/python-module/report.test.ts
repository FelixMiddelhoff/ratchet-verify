import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPythonReport, type PythonDependencyAssessment } from "../../python-module/report.js";
import type { RunResult } from "../../src/sandbox/exec.js";

const ok = (output = ""): RunResult => ({ exitCode: 0, timedOut: false, output, truncated: false });
const bad = (output = ""): RunResult => ({ exitCode: 1, timedOut: false, output, truncated: false });
const change = (overrides: Partial<PythonDependencyAssessment["change"]> = {}) => ({ name: "requests", kind: "changed" as const, oldVersion: "2.31.0", newVersion: "2.32.3", ...overrides });
const changelog = (overrides: Partial<PythonDependencyAssessment["changelog"]> = {}) => ({ source: "github-releases" as const, entries: [], missingVersions: [], availableVersions: [], notes: [], ...overrides });

test("passing tests with a found changelog -> safe, full confidence", () => {
  const report = buildPythonReport([{ change: change(), test: { status: "passed", result: ok() }, changelog: changelog() }]);
  assert.equal(report.overall, "safe");
  assert.equal(report.verdicts[0]!.status, "safe");
  assert.equal(report.verdicts[0]!.confidence, "full");
});

test("passing tests with no changelog found -> safe, reduced confidence with a caveat", () => {
  const report = buildPythonReport([{ change: change(), test: { status: "passed", result: ok() }, changelog: changelog({ source: "none" }) }]);
  assert.equal(report.verdicts[0]!.status, "safe");
  assert.equal(report.verdicts[0]!.confidence, "reduced");
  assert.ok(report.verdicts[0]!.caveats.some((c) => c.includes("no changelog")));
});

test("failing tests with no bisect -> broken, not isolated to a version", () => {
  const report = buildPythonReport([{ change: change(), test: { status: "failed", result: bad("boom") }, changelog: changelog() }]);
  assert.equal(report.overall, "broken");
  assert.equal(report.verdicts[0]!.status, "broken");
  assert.match(report.verdicts[0]!.summary, /not isolated/);
});

test("failing tests with an exact bisect -> broken, cites the culprit version", () => {
  const bisect = { status: "exact" as const, confirmation: "confirmed" as const, lastGood: "2.31.0", firstBad: "2.32.0", ambiguousWith: [], log: [], installs: 3 };
  const report = buildPythonReport([{ change: change(), test: { status: "failed", result: bad("boom") }, changelog: changelog(), bisect }]);
  assert.equal(report.verdicts[0]!.summary, "broken by 2.32.0 (2.31.0 still passed)");
});

test("no lockfile manager detected -> risky, unverified", () => {
  const report = buildPythonReport([{ change: change(), test: { status: "no-manager" }, changelog: changelog() }]);
  assert.equal(report.verdicts[0]!.status, "risky");
  assert.match(report.verdicts[0]!.summary, /unverified/);
});

test("baseline already failing -> risky, cannot be verified", () => {
  const report = buildPythonReport([{ change: change(), test: { status: "baseline-failing", result: bad() }, changelog: changelog() }]);
  assert.equal(report.verdicts[0]!.status, "risky");
  assert.match(report.verdicts[0]!.summary, /already fails on the old lockfile/);
});

test("a new dependency (added) gets a note, not a changelog caveat", () => {
  const report = buildPythonReport([{ change: change({ kind: "added", oldVersion: undefined }), test: { status: "passed", result: ok() }, changelog: changelog({ source: "none" }) }]);
  assert.equal(report.verdicts[0]!.status, "safe");
  assert.ok(report.verdicts[0]!.notes.some((n) => n.includes("new dependency")));
  assert.equal(report.verdicts[0]!.caveats.length, 0);
});

test("overall is the worst of several verdicts", () => {
  const report = buildPythonReport([
    { change: change({ name: "a" }), test: { status: "passed", result: ok() }, changelog: changelog() },
    { change: change({ name: "b" }), test: { status: "failed", result: bad() }, changelog: changelog() },
  ]);
  assert.equal(report.overall, "broken");
});
