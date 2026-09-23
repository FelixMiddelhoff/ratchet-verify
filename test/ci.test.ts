import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMENT_MARKER, renderMarkdown } from "../src/ci/comment.js";
import { USAGE } from "../src/cli/args.js";
import { runCli, type DepsFactory } from "../src/cli/main.js";
import { buildReport, type DependencyVerdict, type Report } from "../src/report/index.js";
import { pkg, withTempProject } from "./helpers.js";

const verdict = (overrides: Partial<DependencyVerdict> = {}): DependencyVerdict => ({
  name: "lib",
  oldVersion: "1.0.0",
  newVersion: "2.0.0",
  direct: true,
  status: "safe",
  confidence: "full",
  summary: "tests pass, no breaking change touches your code",
  evidence: [],
  caveats: [],
  notes: [],
  ...overrides,
});
const report = (...verdicts: DependencyVerdict[]): Report => ({ schemaVersion: 1, overall: "safe", verdicts, ...{} });

test("markdown always starts with the marker used to find the comment again", () => {
  assert.ok(renderMarkdown(buildReport([])).startsWith(COMMENT_MARKER));
});

test("markdown: no changes", () => {
  assert.match(renderMarkdown(buildReport([])), /No dependency changes to verify/);
});

test("markdown: clean safe row is in the table but not expanded", () => {
  const md = renderMarkdown(report(verdict()));
  assert.match(md, /\| ✅ \| `lib` \| `1\.0\.0` → `2\.0\.0` \| safe \|/);
  assert.doesNotMatch(md, /<details>/);
});

test("markdown: partial safe is expanded with its caveats", () => {
  const md = renderMarkdown(report(verdict({ confidence: "reduced", caveats: ["no changelog was found; this is a tests-only verdict"] })));
  assert.match(md, /safe \(partial\)/);
  assert.match(md, /\*\*caveat:\*\* no changelog was found/);
});

test("markdown: risky shows call site and changelog excerpt", () => {
  const md = renderMarkdown(
    report(
      verdict({
        status: "risky",
        evidence: [
          { kind: "call-site", symbol: "foo", file: "src/a.js", line: 7, snippet: "import { foo } from `lib`", changelogVersion: "2.0.0", changelogExcerpt: "- <foo> removed", matchConfidence: "high", reason: "r" },
        ],
      }),
    ),
  );
  assert.match(md, /`src\/a\.js:7`/);
  assert.match(md, /changelog 2\.0\.0 \(high confidence\): - &lt;foo&gt; removed/);
  assert.doesNotMatch(md, /import \{ foo \} from `lib`/, "backticks in snippets are neutralized");
});

test("markdown: broken shows bisect result and fenced failing output that cannot break out", () => {
  const md = renderMarkdown(
    report(
      verdict({
        status: "broken",
        summary: "broken by 1.3.0 (1.2.0 still passed)",
        evidence: [{ kind: "bisect", exact: true, lastGood: "1.2.0", firstBad: "1.3.0", ambiguousWith: [], installs: 3, failingOutput: "oops ``` still inside" }],
      }),
    ),
  );
  assert.match(md, /last good `1\.2\.0`, first bad `1\.3\.0`/);
  assert.match(md, /````\noops ``` still inside\n````/);
});

test("markdown: transitive marker, pipe escaping, and the header reflects the overall verdict", () => {
  const md = renderMarkdown({ ...report(verdict({ direct: false, summary: "a | b", status: "risky" })), overall: "risky" });
  assert.match(md, /^## ratchet: ⚠️ risky/m);
  assert.match(md, /\(transitive\)/);
  assert.match(md, /risky \|$/m);
});

test("markdown: oversized reports are truncated under GitHub's limit", () => {
  const big = verdict({ status: "broken", evidence: [{ kind: "test-failure", outcome: "failed", output: "x".repeat(200_000) }] });
  const md = renderMarkdown(report(big));
  assert.ok(md.length < 65_000);
  assert.match(md, /comment truncated/);
});

test("--markdown and --report-dir write all three report files from one run", async () => {
  const lock = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lib": { version: v } } });
  const ok = { exitCode: 0, timedOut: false, output: "", truncated: false };
  const deps: DepsFactory = () => ({
    testLockfile: async () => ({ status: "passed", result: ok }),
    testDependencyAt: async () => ({ status: "passed", result: ok }),
    fetchChangelog: async () => ({ source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] }),
    scanUsage: async () => ({ sites: [], unparsed: [] }),
  });
  await withTempProject(
    { "package.json": pkg({ dependencies: { lib: "^1" } }), "package-lock.json": lock("1.1.0"), "old.json": lock("1.0.0") },
    async (dir) => {
      const out: string[] = [];
      const code = await runCli([dir, "--old", join(dir, "old.json"), "--markdown", "--report-dir", join(dir, "rep")], { out: (t) => out.push(t), err: () => {}, env: {} }, deps);
      assert.equal(code, 0);
      assert.ok(out[0]!.startsWith(COMMENT_MARKER));
      for (const file of ["report.json", "report.md", "report.sarif"]) assert.ok(existsSync(join(dir, "rep", file)), file);
      assert.equal(JSON.parse(readFileSync(join(dir, "rep", "report.json"), "utf8")).schemaVersion, 1);
      assert.equal(JSON.parse(readFileSync(join(dir, "rep", "report.sarif"), "utf8")).version, "2.1.0");
    },
  );
});

test("action.yml only uses CLI flags that exist, and the comment marker matches", () => {
  const action = readFileSync(join(".github", "actions", "ratchet", "action.yml"), "utf8");
  const used = [...action.matchAll(/^\s+(?:npx[^\n]*|--base[^\n]*)$/gm)].flatMap((m) => m[0].match(/--[a-z-]+/g) ?? []);
  assert.ok(used.length >= 3, "found the invocation");
  for (const flag of new Set(used.filter((f) => f !== "--yes"))) assert.ok(USAGE.includes(flag), `${flag} missing from CLI usage`);
  assert.ok(action.includes(COMMENT_MARKER));
  assert.match(action, /using: composite/);
});
