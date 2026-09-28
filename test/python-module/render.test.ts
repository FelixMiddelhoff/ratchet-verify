import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPythonText } from "../../python-module/render.js";
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
