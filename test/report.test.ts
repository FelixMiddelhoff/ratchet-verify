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
  assert.ok(v.caveats.some((c) => c.includes("1.2.0")), "few versions are listed by name");
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
      bisect: { status: "exact", confirmation: "confirmed", lastGood: "1.2.0", firstBad: "1.3.0", ambiguousWith: [], log: [], installs: 3 },
    }),
  );
  assert.equal(v.status, "broken");
  assert.match(v.summary, /1\.3\.0/);
  const [e] = v.evidence;
  assert.ok(e?.kind === "bisect" && e.exact && e.failingOutput.includes("foo is not a function"));
});

test("broken with flaky boundary: stays broken, says flaky, claims no exact version", () => {
  const v = judge(
    assessment({
      test: failed(),
      bisect: { status: "unstable", confirmation: "flaky", lastGood: "1.2.0", firstBad: "1.3.0", ambiguousWith: [], log: [], installs: 4 },
    }),
  );
  assert.equal(v.status, "broken");
  assert.match(v.summary, /flaky suite: result not reliable/);
  assert.ok(v.evidence[0]?.kind === "bisect" && !v.evidence[0].exact && v.evidence[0].unstable);
});

test("broken with bisection bound reached: narrowed range, not an exact claim", () => {
  const v = judge(
    assessment({
      test: failed(),
      bisect: { status: "narrowed", confirmation: "confirmed", lastGood: "1.2.0", firstBad: "1.9.0", ambiguousWith: [], log: [], installs: 10 },
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

test("a long group of transitive names is shortened in text output", () => {
  const shared = (name: string) =>
    judge(assessment({ change: { name, path: `node_modules/${name}`, kind: "changed", oldVersion: "1.0.0", newVersion: "1.1.0", direct: false }, test: { status: "blamed-elsewhere", culprits: ["a"] } }));
  const names = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const text = renderText({ schemaVersion: 1, overall: "risky", verdicts: names.map(shared) });
  assert.match(text, /20 transitive dependencies \(t0, t1, t2, t3, t4, t5 and 14 more\)/);
});

const bis = (o: Partial<import("../src/bisect/index.js").BisectResult>) =>
  ({ status: "exact", confirmation: "confirmed", lastGood: "1.2.0", firstBad: "1.3.0", ambiguousWith: [], log: [], installs: 3, ...o }) as import("../src/bisect/index.js").BisectResult;

test("last-good suggestion: exact direct bisection gets version and npm pin command in every renderer", async () => {
  const { renderMarkdown } = await import("../src/ci/comment.js");
  const report = buildReport([assessment({ test: failed(), bisect: bis({}) })]);
  const v = report.verdicts[0]!;
  assert.deepEqual(v.suggestion, { version: "1.2.0", command: "npm install lib@1.2.0" });
  assert.equal(JSON.parse(renderJson(report)).verdicts[0].suggestion.command, "npm install lib@1.2.0");
  assert.equal(report.schemaVersion, 1);
  const text = renderText(report);
  assert.match(text, /last known good: 1\.2\.0 \(tested passing in this run\); pin with: npm install lib@1\.2\.0/);
  assert.match(text, /not claimed broken/);
  assert.match(renderMarkdown(report), /last known good:\*\* `1\.2\.0`.*`npm install lib@1\.2\.0`/);
  assert.match(renderSarif(report), /last known good: 1\.2\.0/);
});

test("last-good suggestion: transitive dependency gets the version but no pin command", () => {
  const a = assessment({ test: failed(), bisect: bis({}) });
  a.change = { ...a.change, direct: false };
  assert.deepEqual(judge(a).suggestion, { version: "1.2.0" });
});

test("last-good suggestion: absent when narrowed, flaky, unconfirmed, not bisected", async () => {
  const { renderMarkdown } = await import("../src/ci/comment.js");
  const cases = [
    bis({ status: "narrowed" }),
    bis({ status: "unstable", confirmation: "flaky" }),
    bis({ confirmation: "unconfirmed" }),
    undefined,
  ];
  for (const b of cases) {
    const report = buildReport([assessment({ test: failed(), ...(b ? { bisect: b } : {}) })]);
    assert.equal(report.verdicts[0]!.suggestion, undefined);
    assert.ok(!("suggestion" in JSON.parse(renderJson(report)).verdicts[0]));
    for (const out of [renderText(report), renderMarkdown(report), renderSarif(report)]) assert.doesNotMatch(out, /last known good/);
  }
});

import { describeRegistryProxy } from "../src/report/index.js";
import { renderMarkdown } from "../src/ci/comment.js";

test("registry proxy disclosure: text footer, markdown footer, JSON field; no credential value", () => {
  const info = {
    registries: [{ id: "main", host: "npm.corp.example", credential: "bearer" as const }, { id: "r1", host: "npm.pkg.github.com", credential: "none" as const, scopes: ["@acme"] }],
    allowlist: "on" as const,
    allowHosts: ["cdn.example.com:443"],
    allowedPackages: 12,
    discoveredPackages: ["gamma"],
    requestsAllowed: 40,
    requestsDenied: 2,
    suspicious: [],
    auditTruncated: false,
  };
  const report = buildReport([], { level: "container", runtime: "podman", image: "node:24" }, info);
  assert.deepEqual(report.registryProxy, info);
  const text = renderText(report);
  assert.match(text, /registry proxy: via proxy, credentials never entered the sandbox: npm\.corp\.example \(bearer credential held by the proxy\), npm\.pkg\.github\.com \(no credential, @acme\)/);
  assert.match(text, /package allowlist on \(12 names\).*extra hosts: cdn\.example\.com:443.*discovered dependencies: gamma.*40 requests allowed, 2 denied/);
  assert.match(renderMarkdown(report), /<sub>registry proxy: via proxy/);
  assert.match(describeRegistryProxy({ ...info, allowlist: "off", auditTruncated: true }), /package allowlist OFF.*audit truncated/);
  assert.equal(buildReport([], { level: "temp-dir" }).registryProxy, undefined);
  assert.ok(!("registryProxy" in buildReport([], { level: "temp-dir" })));
});

test("install script: newly added downgrades safe to partial with a caveat; an existing one is only a note; removed says nothing", () => {
  const withScript = (old: boolean, next: boolean, kind: "changed" | "added" | "removed" = "changed") =>
    judge(assessment({ change: { name: "lib", path: "node_modules/lib", kind, oldVersion: kind === "added" ? undefined : "1.0.0", newVersion: kind === "removed" ? undefined : "1.5.0", direct: true, installScript: { old, new: next } } }));
  const fresh = withScript(false, true);
  assert.equal(fresh.status, "safe");
  assert.equal(fresh.confidence, "reduced");
  assert.ok(fresh.caveats.some((c) => /newly runs an install script/.test(c)));
  assert.ok(fresh.notes.includes("runs an install script"));
  const same = withScript(true, true);
  assert.equal(same.confidence, "full");
  assert.deepEqual(same.notes.filter((n) => /install script/.test(n)), ["runs an install script (as the old version did)"]);
  assert.ok(withScript(false, true, "added").caveats.some((c) => /new dependency that runs an install script/.test(c)));
  assert.deepEqual(withScript(true, false).notes.filter((n) => /install script/.test(n)), []);
  assert.deepEqual(withScript(true, true, "removed").notes.filter((n) => /install script/.test(n)), []);
});

import { describeSuspicious } from "../src/report/index.js";
import { suspiciousDenials } from "../src/pipeline/registry-proxy.js";
import type { AuditEntry } from "../src/sandbox/registry-proxy/index.js";

test("suspicious refusals escalate a plainly safe run to risky and are shown with their counts", () => {
  const entry = (cls: string, reason: string, name: string | null = null, decision = "deny") => ({ decision, class: cls, reason, name }) as unknown as AuditEntry;
  const audit = [
    entry("connect", "host-not-allowed"), entry("connect", "host-not-allowed"), entry("denied", "package-not-allowlisted", "evil-lib"),
    entry("denied", "npm-api-path"), entry("packument", "ok", "a", "allow"), entry("tarball", "ok", "a", "allow"),
  ];
  const suspicious = suspiciousDenials(audit);
  assert.deepEqual(suspicious, [
    { class: "connect", reason: "host-not-allowed", count: 2 },
    { class: "denied", reason: "package-not-allowlisted", name: "evil-lib", count: 1 },
  ]);
  const info = { registries: [], allowlist: "on" as const, allowHosts: [], allowedPackages: 1, discoveredPackages: [], requestsAllowed: 2, requestsDenied: 4, suspicious, auditTruncated: false };
  const safe = () => assessment();
  const report = buildReport([safe()], { level: "container" }, info);
  assert.equal(report.overall, "risky");
  assert.equal(report.verdicts[0]!.status, "safe");
  assert.match(renderText(report), /SUSPICIOUS install activity.*2x connect: host-not-allowed.*1x denied: package-not-allowlisted \(evil-lib\)/);
  assert.match(renderMarkdown(report), /> ⚠️ SUSPICIOUS install activity/);
  assert.equal(buildReport([safe()], { level: "container" }, { ...info, suspicious: [] }).overall, "safe");
  assert.equal(describeSuspicious({ ...info, suspicious: [] }), undefined);
  assert.equal(suspiciousDenials([entry("denied", "npm-api-path")]).length, 0, "npm's own /-/ probes are benign");
});
