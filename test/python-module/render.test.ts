import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPythonJson, renderPythonSarif, renderPythonText } from "../../python-module/render.js";
import type { PythonReport } from "../../python-module/report.js";

test("empty report renders a plain 'no changes' line", () => {
  assert.equal(renderPythonText({ schemaVersion: 1, overall: "safe", verdicts: [] }), "ratchet: no dependency changes between the two lockfiles.");
});

test("renders status, summary, caveats and notes for each verdict", () => {
  const report: PythonReport = {
    schemaVersion: 1,
    overall: "safe",
    verdicts: [
      { name: "requests", oldVersion: "2.31.0", newVersion: "2.32.3", status: "safe", confidence: "reduced", summary: "tests pass; verdict is partial: no changelog was found; this is a tests-only verdict", evidence: [], caveats: ["no changelog was found; this is a tests-only verdict"], notes: ["some note"] },
    ],
  };
  const text = renderPythonText(report);
  assert.match(text, /ratchet: overall safe/);
  assert.match(text, /requests \(2\.31\.0 -> 2\.32\.3\): SAFE/);
  assert.match(text, /caveat: no changelog was found/);
  assert.match(text, /note: some note/);
});

test("renderPythonJson round-trips the report exactly", () => {
  const report: PythonReport = { schemaVersion: 1, overall: "broken", verdicts: [] };
  assert.deepEqual(JSON.parse(renderPythonJson(report)), report);
});

test("renderPythonSarif: one error-level result per broken verdict, valid SARIF 2.1.0 shape", () => {
  const report: PythonReport = {
    schemaVersion: 1,
    overall: "broken",
    verdicts: [{ name: "requests", oldVersion: "2.31.0", newVersion: "2.32.0", status: "broken", confidence: "full", summary: "broken by 2.32.0", evidence: [], caveats: [], notes: [] }],
  };
  const sarif = JSON.parse(renderPythonSarif(report));
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].ruleId, "ratchet/broken");
  assert.equal(sarif.runs[0].results[0].level, "error");
});

test("renderPythonSarif: a call-site hit produces a result at its own file:line, not pyproject.toml", () => {
  const report: PythonReport = {
    schemaVersion: 1,
    overall: "risky",
    verdicts: [
      {
        name: "requests",
        oldVersion: "2.31.0",
        newVersion: "2.32.0",
        status: "risky",
        confidence: "full",
        summary: "tests pass, but the changelog names 1 symbol use in your code as breaking",
        evidence: [{ kind: "call-site", symbol: "get_legacy", file: "app.py", line: 3, snippet: "", changelogVersion: "2.32.0", changelogExcerpt: "removed", matchConfidence: "high", reason: "named in a breaking-change section" }],
        caveats: [],
        notes: [],
      },
    ],
  };
  const sarif = JSON.parse(renderPythonSarif(report));
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "app.py");
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 3);
});
