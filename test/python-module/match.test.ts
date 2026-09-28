import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPythonBreakingChanges } from "../../python-module/match.js";
import type { PythonUsageSite } from "../../python-module/usage.js";

const site = (overrides: Partial<PythonUsageSite> = {}): PythonUsageSite => ({
  file: "app.py",
  line: 1,
  symbol: "get_legacy",
  kind: "from-import",
  module: "requests",
  snippet: "from requests import get_legacy",
  ...overrides,
});

const entry = (body: string, version = "2.32.0") => ({ version, body, origin: "github-release" as const });

test("a from-import symbol named in an explicit breaking-change section is a high-confidence hit", () => {
  const result = matchPythonBreakingChanges({
    entries: [entry("## Breaking changes\n\n- Removed `get_legacy` in favor of `get`.")],
    sites: [site()],
    oldVersion: "2.31.0",
    newVersion: "2.32.0",
  });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.confidence, "high");
  assert.equal(result.hasBreakingSections, true);
});

test("no mention of the symbol anywhere -> no hits, even with breaking sections present", () => {
  const result = matchPythonBreakingChanges({
    entries: [entry("## Breaking changes\n\n- Removed `unrelated_thing`.")],
    sites: [site()],
    oldVersion: "2.31.0",
    newVersion: "2.32.0",
  });
  assert.equal(result.hits.filter((h) => h.site.symbol === "get_legacy").length, 0);
});

test("plain 'import pkg' sites are not matched by name, only flagged low-confidence when breaking sections exist", () => {
  const result = matchPythonBreakingChanges({
    entries: [entry("## Breaking changes\n\n- Removed `get_legacy`.")],
    sites: [site({ kind: "import", symbol: "requests", module: "requests", snippet: "import requests" })],
    oldVersion: "2.31.0",
    newVersion: "2.32.0",
  });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.confidence, "low");
});

test("major version boundary is detected across a major bump", () => {
  const result = matchPythonBreakingChanges({ entries: [], sites: [], oldVersion: "1.9.0", newVersion: "2.0.0" });
  assert.equal(result.majorBoundary, true);
  const same = matchPythonBreakingChanges({ entries: [], sites: [], oldVersion: "1.9.0", newVersion: "1.10.0" });
  assert.equal(same.majorBoundary, false);
});

test("a soft removal/rename note (no explicit breaking heading) is medium confidence", () => {
  const result = matchPythonBreakingChanges({
    entries: [entry("`get_legacy` was renamed to `get`.")],
    sites: [site()],
    oldVersion: "2.31.0",
    newVersion: "2.32.0",
  });
  assert.equal(result.hits[0]!.confidence, "medium");
});
