import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangelogEntry } from "../src/changelog/index.js";
import { matchBreakingChanges } from "../src/match/index.js";
import type { UsageSite } from "../src/usage/index.js";

const entry = (version: string, body: string): ChangelogEntry => ({ version, body, origin: "github-release" });
const site = (symbol: string, line = 1): UsageSite => ({ file: "a.js", line, symbol, kind: "import", snippet: `use ${symbol}` });

const run = (entries: ChangelogEntry[], sites: UsageSite[], oldVersion = "1.0.0", newVersion = "2.0.0") =>
  matchBreakingChanges({ entries, sites, oldVersion, newVersion });

test("symbol in a Breaking Changes section: high confidence with excerpt and call site", () => {
  const result = run([entry("2.0.0", "### Features\n- add `bar`\n### Breaking Changes\n- `foo` no longer accepts strings")], [site("foo", 7)]);
  assert.equal(result.hits.length, 1);
  const [hit] = result.hits;
  assert.equal(hit?.confidence, "high");
  assert.equal(hit?.excerpt, "- `foo` no longer accepts strings");
  assert.equal(hit?.site.line, 7);
  assert.equal(hit?.version, "2.0.0");
});

test("inline BREAKING marker outside a section is explicit", () => {
  const [hit] = run([entry("1.5.0", "- BREAKING: `foo` now returns a Promise")], [site("foo")], "1.0.0", "1.5.0").hits;
  assert.equal(hit?.confidence, "high");
});

test("removal/rename note outside a breaking section: medium", () => {
  const [hit] = run([entry("1.5.0", "- renamed foo to bar")], [site("foo")], "1.0.0", "1.5.0").hits;
  assert.equal(hit?.confidence, "medium");
});

test("incidental mentions are not matches: feature, fix and docs lines", () => {
  const body = "### Features\n- added `foo` option\n### Bug Fixes\n- fixed crash in foo when empty\n- docs for foo";
  assert.deepEqual(run([entry("1.5.0", body)], [site("foo")], "1.0.0", "1.5.0").hits, []);
});

test("symbol not used by this codebase is not reported", () => {
  const result = run([entry("2.0.0", "### Breaking Changes\n- `other` removed")], [site("foo")]);
  assert.deepEqual(result.hits, []);
  assert.equal(result.hasBreakingSections, true);
});

test("substring of another identifier does not match", () => {
  const result = run([entry("2.0.0", "### Breaking Changes\n- `fooBar` and foo_baz and $foo removed")], [site("foo")]);
  assert.deepEqual(result.hits, []);
});

test("very short symbols only match when backtick-quoted", () => {
  const body = "### Breaking Changes\n- we changed a lot of things\n- `_` is gone";
  assert.equal(run([entry("2.0.0", body)], [site("a")]).hits.length, 0);
  assert.equal(run([entry("2.0.0", body)], [site("_")]).hits.length, 1);
});

test("major release entry naming the symbol anywhere: medium", () => {
  const [hit] = run([entry("2.0.0", "- `foo` now uses the new engine")], [site("foo")]).hits;
  assert.equal(hit?.confidence, "medium");
  assert.match(hit!.reason, /major/);
});

test("the same line in a minor release is not flagged", () => {
  assert.deepEqual(run([entry("1.5.0", "- `foo` now uses the new engine")], [site("foo")], "1.0.0", "1.5.0").hits, []);
});

test("whole-module and default use get low-confidence hits when breaking changes exist", () => {
  const body = "## Breaking\n- `foo` removed";
  const hits = run([entry("2.0.0", body)], [site("*", 3), site("default", 4)]).hits;
  assert.deepEqual(hits.map((h) => [h.confidence, h.site.symbol]), [["low", "*"], ["low", "default"]]);
});

test("whole-module use with no breaking sections: no hit, but majorBoundary is surfaced", () => {
  const result = run([entry("2.0.0", "- perf improvements")], [site("*")]);
  assert.deepEqual(result.hits, []);
  assert.equal(result.majorBoundary, true);
  assert.equal(result.hasBreakingSections, false);
});

test("majorBoundary false within the same major", () => {
  assert.equal(run([], [], "1.0.0", "1.9.0").majorBoundary, false);
});

test("nested sub-heading stays inside the breaking section; next top heading ends it", () => {
  const body = "## Breaking Changes\n### API\n- `foo` removed\n## Features\n- `bar` shiny";
  const hits = run([entry("1.5.0", body)], [site("foo"), site("bar")], "1.0.0", "1.5.0").hits;
  assert.deepEqual(hits.map((h) => [h.site.symbol, h.confidence]), [["foo", "high"]]);
});

test("bold-label breaking section (no markdown heading)", () => {
  const [hit] = run([entry("2.0.0", "**Breaking changes**\n- `foo` gone\n**Features**\n- `bar`")], [site("foo"), site("bar")]).hits;
  assert.equal(hit?.site.symbol, "foo");
  assert.equal(hit?.confidence, "high");
});

test("hits are sorted by confidence, then newest version first", () => {
  const entries = [entry("1.5.0", "- BREAKING `foo`"), entry("2.0.0", "- BREAKING `foo`"), entry("1.2.0", "- renamed `foo`")];
  const versions = run(entries, [site("foo")]).hits.map((h) => `${h.confidence}:${h.version}`);
  assert.deepEqual(versions, ["high:2.0.0", "high:1.5.0", "medium:1.2.0"]);
});

test("no changelog entries: no hits, no breaking sections", () => {
  const result = run([], [site("foo")]);
  assert.deepEqual(result, { hits: [], majorBoundary: true, hasBreakingSections: false });
});

test("common word in bare prose of a breaking line: capped at medium, not dropped", () => {
  const body = "### Breaking Changes\n- default value specified for boolean option now always used";
  const [hit] = run([entry("2.0.0", body)], [site("option")]).hits;
  assert.equal(hit?.confidence, "medium");
  assert.match(hit!.reason, /common word/);
});

test("common word with code-style evidence stays high: backticks, .call form, call()", () => {
  for (const line of ["- `option` removed", "- program.option is gone", "- option() now throws"]) {
    const [hit] = run([entry("2.0.0", `### Breaking Changes\n- ${line}`)], [site("option")]).hits;
    assert.equal(hit?.confidence, "high", line);
  }
});

test("common word in bare prose of a major release, no breaking wording: not flagged", () => {
  assert.deepEqual(run([entry("2.0.0", "- improved the option help text")], [site("option")]).hits, []);
});

test("common word in a removal note still matches (medium)", () => {
  const [hit] = run([entry("1.5.0", "- removed the parse fallback")], [site("parse")], "1.0.0", "1.5.0").hits;
  assert.equal(hit?.confidence, "medium");
});

test("non-common symbol in bare prose keeps high confidence", () => {
  const [hit] = run([entry("2.0.0", "### Breaking Changes\n- frobnicate no longer accepts strings")], [site("frobnicate")]).hits;
  assert.equal(hit?.confidence, "high");
});

const DEEP = "### Breaking Changes\n- Deep requiring specific algorithms of this library like `require('uuid/v4')` is no longer supported.";
const runPkg = (sites: UsageSite[]) =>
  matchBreakingChanges({ entries: [entry("8.0.0", DEEP)], sites, oldVersion: "7.0.3", newVersion: "8.0.0", packageName: "uuid" });

test("subpath bullet does not match member use on the root import", () => {
  const member: UsageSite = { ...site("v4"), kind: "member-access" };
  assert.equal(runPkg([member]).hits.length, 0);
});

test("subpath bullet still hits a site importing that subpath", () => {
  const deep: UsageSite = { ...site("*"), kind: "require", subpath: "uuid/v4" };
  const [hit] = runPkg([deep]).hits.filter((h) => h.site === deep);
  assert.equal(hit?.confidence, "high");
  const named: UsageSite = { ...site("v4"), kind: "require", subpath: "uuid/v4" };
  assert.equal(runPkg([named]).hits[0]?.confidence, "high");
});

test("root member named in prose elsewhere still matches when subpath token is masked", () => {
  const body = `${DEEP}\n- \`v4\` now returns a string`;
  const [hit] = matchBreakingChanges({ entries: [entry("8.0.0", body)], sites: [site("v4")], oldVersion: "7.0.3", newVersion: "8.0.0", packageName: "uuid" }).hits;
  assert.equal(hit?.confidence, "high");
});
