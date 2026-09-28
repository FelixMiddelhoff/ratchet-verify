import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPythonReport, type PythonDependencyAssessment } from "../../python-module/report.js";
import type { RunResult } from "../../src/sandbox/exec.js";

const ok = (output = ""): RunResult => ({ exitCode: 0, timedOut: false, output, truncated: false });
const bad = (output = ""): RunResult => ({ exitCode: 1, timedOut: false, output, truncated: false });
const change = (overrides: Partial<PythonDependencyAssessment["change"]> = {}) => ({ name: "requests", kind: "changed" as const, oldVersion: "2.31.0", newVersion: "2.32.3", ...overrides });
const changelog = (overrides: Partial<PythonDependencyAssessment["changelog"]> = {}) => ({ source: "github-releases" as const, entries: [], missingVersions: [], availableVersions: [], notes: [], ...overrides });
const usage = (overrides: Partial<PythonDependencyAssessment["usage"]> = {}) => ({ sites: [], unparsed: [], ...overrides });
const match = (overrides: Partial<PythonDependencyAssessment["match"]> = {}) => ({ hits: [], majorBoundary: false, hasBreakingSections: false, ...overrides });
const base = (overrides: Partial<PythonDependencyAssessment> = {}): PythonDependencyAssessment => ({
  change: change(),
  test: { status: "passed", result: ok() },
  changelog: changelog(),
  usage: usage(),
  match: match(),
  ...overrides,
});

test("passing tests with a found changelog -> safe, full confidence", () => {
  const report = buildPythonReport([base()]);
  assert.equal(report.overall, "safe");
  assert.equal(report.verdicts[0]!.status, "safe");
  assert.equal(report.verdicts[0]!.confidence, "full");
});

test("passing tests with no changelog found -> safe, reduced confidence with a caveat", () => {
  const report = buildPythonReport([base({ changelog: changelog({ source: "none" }) })]);
  assert.equal(report.verdicts[0]!.status, "safe");
  assert.equal(report.verdicts[0]!.confidence, "reduced");
  assert.ok(report.verdicts[0]!.caveats.some((c) => c.includes("no changelog")));
});

test("failing tests with no bisect -> broken, not isolated to a version", () => {
  const report = buildPythonReport([base({ test: { status: "failed", result: bad("boom") } })]);
  assert.equal(report.overall, "broken");
  assert.equal(report.verdicts[0]!.status, "broken");
  assert.match(report.verdicts[0]!.summary, /not isolated/);
});

test("failing tests with an exact bisect -> broken, cites the culprit version", () => {
  const bisect = { status: "exact" as const, confirmation: "confirmed" as const, lastGood: "2.31.0", firstBad: "2.32.0", ambiguousWith: [], log: [], installs: 3 };
  const report = buildPythonReport([base({ test: { status: "failed", result: bad("boom") }, bisect })]);
  assert.equal(report.verdicts[0]!.summary, "broken by 2.32.0 (2.31.0 still passed)");
});

test("no lockfile manager detected -> risky, unverified", () => {
  const report = buildPythonReport([base({ test: { status: "no-manager" } })]);
  assert.equal(report.verdicts[0]!.status, "risky");
  assert.match(report.verdicts[0]!.summary, /unverified/);
});

test("baseline already failing -> risky, cannot be verified", () => {
  const report = buildPythonReport([base({ test: { status: "baseline-failing", result: bad() } })]);
  assert.equal(report.verdicts[0]!.status, "risky");
  assert.match(report.verdicts[0]!.summary, /already fails on the old lockfile/);
});

test("a new dependency (added) gets a note, not a changelog caveat", () => {
  const report = buildPythonReport([base({ change: change({ kind: "added", oldVersion: undefined }), changelog: changelog({ source: "none" }) })]);
  assert.equal(report.verdicts[0]!.status, "safe");
  assert.ok(report.verdicts[0]!.notes.some((n) => n.includes("new dependency")));
  assert.equal(report.verdicts[0]!.caveats.length, 0);
});

test("overall is the worst of several verdicts", () => {
  const report = buildPythonReport([
    base({ change: change({ name: "a" }) }),
    base({ change: change({ name: "b" }), test: { status: "failed", result: bad() } }),
  ]);
  assert.equal(report.overall, "broken");
});

test("passing tests, but the changelog names an imported symbol as breaking -> risky, call-site evidence", () => {
  const site = { file: "app.py", line: 3, symbol: "get_legacy", kind: "from-import" as const, module: "requests", snippet: "from requests import get_legacy" };
  const m = match({
    hits: [{ confidence: "high" as const, reason: "named in a breaking-change section", version: "2.32.0", excerpt: "`get_legacy` was removed", site }],
  });
  const report = buildPythonReport([base({ usage: usage({ sites: [site] }), match: m })]);
  assert.equal(report.verdicts[0]!.status, "risky");
  assert.equal(report.verdicts[0]!.evidence[0]!.kind, "call-site");
});

test("usage scan with unparsed files -> safe but reduced confidence with a caveat", () => {
  const report = buildPythonReport([base({ usage: usage({ unparsed: [{ file: "broken.py" }] }) })]);
  assert.equal(report.verdicts[0]!.status, "safe");
  assert.equal(report.verdicts[0]!.confidence, "reduced");
  assert.ok(report.verdicts[0]!.caveats.some((c) => c.includes("usage scan incomplete")));
});
