import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, judge, renderJson, renderSarif, renderText, type DependencyAssessment } from "../src/report/index.js";
import type { BreakingHit } from "../src/match/index.js";
import type { TestOutcome } from "../src/testrun/index.js";

const passed: TestOutcome = { status: "passed", result: { exitCode: 0, timedOut: false, output: "ok", truncated: false } };
const failed = (output = "1 failing: foo is not a function"): TestOutcome => ({
  status: "failed",
  result: { exitCode: 1, timedOut: false, output, truncated: false },
});

const hit = (confidence: BreakingHit["confidence"], symbol = "foo"): BreakingHit => ({
  confidence,
  reason: "named in a breaking-change section",
  version: "1.5.0",
  excerpt: "- `foo` removed",
  site: { file: "src/a.js", line: 7, symbol, kind: "import", snippet: `import { ${symbol} } from "lib"` },
});

/** Defaults describe a fully-evaluated, uneventful minor bump. */
function assessment(overrides: Partial<DependencyAssessment> = {}): DependencyAssessment {
  return {
    change: { name: "lib", path: "node_modules/lib", kind: "changed", oldVersion: "1.0.0", newVersion: "1.5.0", direct: true },
    test: passed,
    usage: { sites: [{ file: "src/a.js", line: 1, symbol: "foo", kind: "import", snippet: "x" }], unparsed: [] },
    changelog: { source: "github-releases", entries: [], missingVersions: [], availableVersions: [], notes: [] },
    match: { hits: [], majorBoundary: false, hasBreakingSections: false },
    ...overrides,
  };
}

test("safe with every signal evaluated: full confidence, no caveats", () => {
  const v = judge(assessment());
  assert.deepEqual([v.status, v.confidence, v.caveats], ["safe", "full", []]);
});

test("safe but no changelog: downgraded to a tests-only verdict", () => {
  const v = judge(assessment({ changelog: { source: "none", entries: [], missingVersions: ["1.5.0"], availableVersions: [], notes: [] } }));
  assert.equal(v.status, "safe");
  assert.equal(v.confidence, "reduced");
  assert.ok(v.caveats.some((c) => c.includes("tests-only")));
  assert.ok(v.summary.includes("partial"));
});

test("safe but changelog missing some versions: caveat names them", () => {
  const v = judge(assessment({ changelog: { source: "github-releases", entries: [], missingVersions: ["1.2.0"], availableVersions: [], notes: [] } }));
  assert.equal(v.confidence, "reduced");
  assert.ok(v.caveats.some((c) => c.includes("1.2.0")));
});

test("major bump with no hits is never a full-confidence safe", () => {
  const v = judge(assessment({ match: { hits: [], majorBoundary: true, hasBreakingSections: false } }));
  assert.equal(v.confidence, "reduced");
  assert.ok(v.caveats.some((c) => c.includes("major")));
});

test("unparsed source files reduce confidence and are named", () => {
  const v = judge(assessment({ usage: { sites: [], unparsed: [{ file: "broken.js" }] } }));
  assert.equal(v.confidence, "reduced");
  assert.ok(v.caveats.some((c) => c.includes("broken.js")));
});

test("low-confidence whole-module hit reduces confidence but does not claim risky without an excerpt", () => {
  const v = judge(assessment({ match: { hits: [hit("low", "*")], majorBoundary: false, hasBreakingSections: true } }));
  assert.equal(v.status, "safe");
  assert.equal(v.confidence, "reduced");
});

test("risky: cites changelog excerpt and call site", () => {
  const v = judge(assessment({ match: { hits: [hit("high")], majorBoundary: false, hasBreakingSections: true } }));
  assert.equal(v.status, "risky");
  const [e] = v.evidence;
  assert.ok(e?.kind === "call-site");
  assert.deepEqual([e.file, e.line, e.changelogExcerpt], ["src/a.js", 7, "- `foo` removed"]);
});

test("broken with exact bisection: cites first bad, last good and failing output", () => {
  const v = judge(
    assessment({
      test: failed(),
      bisect: { status: "exact", lastGood: "1.2.0", firstBad: "1.3.0", ambiguousWith: [], log: [], installs: 3 },
    }),
  );
  assert.equal(v.status, "broken");
  assert.match(v.summary, /1\.3\.0/);
  const [e] = v.evidence;
  assert.ok(e?.kind === "bisect" && e.exact && e.failingOutput.includes("foo is not a function"));
});

test("broken with bisection bound reached: narrowed range, not an exact claim", () => {
  const v = judge(
    assessment({
      test: failed(),
      bisect: { status: "narrowed", lastGood: "1.2.0", firstBad: "1.9.0", ambiguousWith: [], log: [], installs: 10 },
    }),
  );
  assert.match(v.summary, /1\.2\.0 < v <= 1\.9\.0/);
  assert.ok(v.evidence[0]?.kind === "bisect" && !v.evidence[0].exact);
});

test("broken without bisection still cites failing output and says it was not isolated", () => {
  const v = judge(assessment({ test: failed("BOOM") }));
  assert.equal(v.status, "broken");
  assert.match(v.summary, /not isolated/);
  assert.ok(v.evidence[0]?.kind === "test-failure" && v.evidence[0].output === "BOOM");
});

test("hung tests and failed installs are broken, worded differently", () => {
  const hung = judge(assessment({ test: { status: "timed-out", result: { exitCode: null, timedOut: true, output: "", truncated: false } } }));
  const install = judge(assessment({ test: { status: "install-failed", result: { exitCode: 1, timedOut: false, output: "ERESOLVE", truncated: false } } }));
  assert.match(hung.summary, /hung/);
  assert.match(install.summary, /install fails/);
  assert.equal(hung.status, "broken");
  assert.equal(install.status, "broken");
});

test("failing output is cut to its tail", () => {
  const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const v = judge(assessment({ test: failed(output) }));
  const e = v.evidence[0];
  assert.ok(e?.kind === "test-failure" && e.output.split("\n").length === 40 && e.output.endsWith("line 199"));
});

test("no test script: never safe — reported as unverified with the reason", () => {
  const v = judge(assessment({ test: { status: "no-test-script" } }));
  assert.equal(v.status, "risky");
  assert.equal(v.confidence, "reduced");
  assert.match(v.summary, /^unverified/);
});

test("added dependency: no changelog caveat, no-usage note is not a caveat", () => {
  const v = judge(
    assessment({
      change: { name: "lib", path: "node_modules/lib", kind: "added", newVersion: "1.0.0", direct: true },
      changelog: { source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] },
      usage: { sites: [], unparsed: [] },
    }),
  );
  assert.deepEqual([v.status, v.confidence], ["safe", "full"]);
  assert.ok(v.notes.some((n) => n.includes("new dependency")));
});

test("overall is the worst status across dependencies", () => {
  const report = buildReport([assessment(), assessment({ match: { hits: [hit("high")], majorBoundary: false, hasBreakingSections: true } })]);
  assert.equal(report.overall, "risky");
  assert.equal(buildReport([assessment(), assessment({ test: failed() })]).overall, "broken");
  assert.equal(buildReport([]).overall, "safe");
});

test("json output has a stable schema version and round-trips", () => {
  const report = buildReport([assessment()]);
  const parsed = JSON.parse(renderJson(report));
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(report)));
});

test("text output shows label, call site, excerpt and caveats", () => {
  const text = renderText(
    buildReport([
      assessment({ match: { hits: [hit("high")], majorBoundary: true, hasBreakingSections: true } }),
      assessment({ changelog: { source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] } }),
    ]),
  );
  assert.match(text, /RISKY {2}lib 1\.0\.0 -> 1\.5\.0 \(direct\)/);
  assert.match(text, /src\/a\.js:7/);
  assert.match(text, /changelog 1\.5\.0 \(high\): - `foo` removed/);
  assert.match(text, /SAFE \(PARTIAL\)/);
  assert.match(text, /caveat: no changelog was found/);
  assert.match(text, /overall: risky/);
});

test("sarif: valid 2.1.0 shape, one result per risky call site, nothing for full-confidence safe", () => {
  const sarif = JSON.parse(
    renderSarif(
      buildReport([
        assessment(),
        assessment({ match: { hits: [hit("high"), hit("medium", "bar")], majorBoundary: false, hasBreakingSections: true } }),
        assessment({ test: failed() }),
      ]),
    ),
  );
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].tool.driver.name, "ratchet");
  const results = sarif.runs[0].results;
  assert.deepEqual(results.map((r: { ruleId: string }) => r.ruleId), ["ratchet/risky", "ratchet/risky", "ratchet/broken"]);
  assert.equal(results[0].locations[0].physicalLocation.region.startLine, 7);
  assert.equal(results[0].locations[0].physicalLocation.artifactLocation.uri, "src/a.js");
  assert.equal(results[2].level, "error");
});

test("shared 'not tested on its own' verdicts collapse into one block in text and markdown, not in JSON", async () => {
  const { renderMarkdown } = await import("../src/ci/comment.js");
  const shared = (name: string) =>
    judge(assessment({ change: { name, path: `node_modules/${name}`, kind: "changed", oldVersion: "1.0.0", newVersion: "1.1.0", direct: false }, test: { status: "blamed-elsewhere", culprits: ["a"] } }));
  const report = { schemaVersion: 1 as const, overall: "risky" as const, verdicts: [shared("t1"), shared("t2"), shared("t3")] };
  const text = renderText(report);
  assert.match(text, /3 transitive dependencies \(t1, t2, t3\)/);
  assert.equal((text.match(/RISKY/g) ?? []).length, 1);
  assert.match(renderMarkdown(report), /3 transitive dependencies/);
  assert.equal(JSON.parse(renderJson(report)).verdicts.length, 3);
});

test("headline says 'safe (partial)' when any safe verdict is partial", async () => {
  const { renderMarkdown } = await import("../src/ci/comment.js");
  const partial = buildReport([assessment({ changelog: { source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] } })]);
  assert.match(renderText(partial), /overall: safe \(partial\)/);
  assert.match(renderMarkdown(partial), /## ratchet: ✅ safe \(partial\)/);
  assert.match(renderText(buildReport([assessment()])), /overall: safe$/);
});
