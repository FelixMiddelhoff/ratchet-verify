import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchChangelog, normalizeRepository, parseChangelogSections, type FetchLike } from "../src/changelog/index.js";
import { compareVersions, versionsInRange } from "../src/changelog/semver.js";
import { versionFromTag } from "../src/changelog/index.js";

type Route = { status?: number; json?: unknown; text?: string } | Error;

/** Recorded-response fake: no live network in the fast suite. */
function fakeFetch(routes: Record<string, Route>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url] ?? routes[url.replace(/\?.*$/, "")] ?? { status: 404 };
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return { ok: status < 400, status, json: async () => route.json, text: async () => route.text ?? "" };
  };
  return Object.assign(fn, { calls });
}

const REGISTRY = "https://registry.npmjs.org/lib";
const RELEASES = "https://api.github.com/repos/o/r/releases?per_page=100&page=1";
const RAW = (file: string, dir = "") => `https://raw.githubusercontent.com/o/r/HEAD/${dir}${file}`;
const packument = (repository: unknown, versions = ["1.0.0", "1.1.0", "2.0.0", "2.1.0-beta.1"]) => ({
  json: { repository, versions: Object.fromEntries(versions.map((v) => [v, {}])) },
});
const req = { name: "lib", oldVersion: "1.0.0", newVersion: "2.0.0" };

test("semver: ordering, prereleases, and range selection", () => {
  assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.11") < 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
  assert.deepEqual(versionsInRange(["1.0.0", "1.1.0", "2.0.0", "2.1.0-beta.1", "3.0.0"], "1.0.0", "2.0.0"), ["1.1.0", "2.0.0"]);
});

test("repository field: every common spelling normalizes", () => {
  const expected = { owner: "o", repo: "r" };
  for (const url of [
    "o/r",
    "github:o/r",
    "git+https://github.com/o/r.git",
    "git://github.com/o/r.git",
    "https://github.com/o/r",
    "https://github.com/o/r/tree/main/packages/x",
    "git@github.com:o/r.git",
    "ssh://git@github.com/o/r.git",
  ]) {
    assert.deepEqual(normalizeRepository(url), expected, url);
    assert.deepEqual(normalizeRepository({ url }), expected, url);
  }
});

test("repository field: monorepo directory kept, non-GitHub and empty rejected", () => {
  assert.deepEqual(normalizeRepository({ url: "https://github.com/o/r", directory: "packages/lib/" }), {
    owner: "o",
    repo: "r",
    directory: "packages/lib",
  });
  assert.equal(normalizeRepository("https://gitlab.com/o/r"), undefined);
  assert.equal(normalizeRepository(undefined), undefined);
  assert.equal(normalizeRepository({}), undefined);
});

test("tags: plain, prefixed, monorepo and foreign packages", () => {
  assert.equal(versionFromTag("v1.2.3", "lib"), "1.2.3");
  assert.equal(versionFromTag("1.2.3", "lib"), "1.2.3");
  assert.equal(versionFromTag("lib@1.2.3", "lib"), "1.2.3");
  assert.equal(versionFromTag("@s/lib@1.2.3", "@s/lib"), "1.2.3");
  assert.equal(versionFromTag("lib-v1.2.3", "lib"), "1.2.3");
  assert.equal(versionFromTag("other@1.2.3", "lib"), undefined);
  assert.equal(versionFromTag("nightly", "lib"), undefined);
});

test("changelog sections: split by version heading, sub-headings stay inside", () => {
  const md = "# Changelog\n\n## [2.0.0] - 2024-01-01\n### Breaking\n- removed `foo`\n\n## v1.1.0\n- added bar\n\n## Unreleased\nnope\n";
  assert.deepEqual(parseChangelogSections(md), [
    { version: "2.0.0", body: "### Breaking\n- removed `foo`" },
    { version: "1.1.0", body: "- added bar\n\n## Unreleased\nnope" },
  ]);
});

test("GitHub releases present: entries in range only, ascending, drafts skipped", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument("o/r"),
    [RELEASES]: {
      json: [
        { tag_name: "v2.0.0", body: "BREAKING: removed foo" },
        { tag_name: "v1.1.0", body: "added bar" },
        { tag_name: "v1.0.0", body: "old, out of range" },
        { tag_name: "v2.1.0-beta.1", body: "prerelease" },
      ],
    },
  });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "github-releases");
  assert.deepEqual(result.entries.map((e) => e.version), ["1.1.0", "2.0.0"]);
  assert.deepEqual(result.missingVersions, []);
  assert.ok(!http.calls.some((u) => u.includes("raw.githubusercontent")), "no fallback needed");
});

test("only CHANGELOG.md present: fallback is used", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument("o/r"),
    [RELEASES]: { json: [] },
    [RAW("CHANGELOG.md")]: { text: "## 2.0.0\nbreaking\n## 1.1.0\nfeat\n## 1.0.0\nold" },
  });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "changelog-file");
  assert.deepEqual(result.entries.map((e) => [e.version, e.body]), [["1.1.0", "feat"], ["2.0.0", "breaking"]]);
});

test("releases cover some versions, CHANGELOG.md fills the rest", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument("o/r"),
    [RELEASES]: { json: [{ tag_name: "v2.0.0", body: "from release" }] },
    [RAW("CHANGELOG.md")]: { text: "## 1.1.0\nfrom file" },
  });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "both");
  assert.deepEqual(result.entries.map((e) => e.origin), ["changelog-file", "github-release"]);
});

test("neither present: valid 'none' outcome listing missing versions", async () => {
  const http = fakeFetch({ [REGISTRY]: packument("o/r"), [RELEASES]: { json: [] } });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "none");
  assert.deepEqual(result.missingVersions, ["1.1.0", "2.0.0"]);
  assert.ok(result.notes.some((n) => n.includes("No notes found")));
});

test("monorepo: directory-scoped CHANGELOG and package-scoped tags", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument({ url: "https://github.com/o/r", directory: "packages/lib" }),
    [RELEASES]: { json: [{ tag_name: "other@2.0.0", body: "wrong package" }] },
    [RAW("CHANGELOG.md", "packages/lib/")]: { text: "## 2.0.0\nright\n## 1.1.0\nright too" },
  });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.deepEqual(result.entries.map((e) => e.body), ["right too", "right"]);
});

test("scoped package name is URL-encoded for the registry", async () => {
  const http = fakeFetch({});
  await fetchChangelog({ name: "@s/lib", oldVersion: "1.0.0", newVersion: "2.0.0", fetch: http });
  assert.equal(http.calls[0], "https://registry.npmjs.org/@s%2Flib");
});

test("no repository metadata: reported, not thrown", async () => {
  const http = fakeFetch({ [REGISTRY]: packument(undefined) });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "none");
  assert.ok(result.notes.some((n) => n.includes("No GitHub repository")));
});

test("registry failure and network error are notes, not exceptions", async () => {
  const missing = await fetchChangelog({ ...req, fetch: fakeFetch({}) });
  assert.ok(missing.notes[0]?.includes("HTTP 404"));
  const down = await fetchChangelog({ ...req, fetch: fakeFetch({ [REGISTRY]: new Error("ECONNRESET") }) });
  assert.ok(down.notes[0]?.includes("ECONNRESET"));
});

test("GitHub rate limit is called out and falls back to CHANGELOG.md", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument("o/r"),
    [RELEASES]: { status: 403 },
    [RAW("CHANGELOG.md")]: { text: "## 2.0.0\nx\n## 1.1.0\ny" },
  });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.ok(result.notes.some((n) => n.includes("rate limited")));
  assert.equal(result.source, "changelog-file");
});
