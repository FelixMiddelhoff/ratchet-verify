import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchLike } from "../../src/changelog/index.js";
import { fetchPythonChangelog } from "../../python-module/changelog.js";
import { compareVersions, describeVersions, isPrerelease, versionsInRange } from "../../python-module/version.js";

type Route = { status?: number; json?: unknown; text?: string } | Error;

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

const PYPI = "https://pypi.org/pypi/lib/json";
const RELEASES = "https://api.github.com/repos/o/r/releases?per_page=100&page=1";
const pypiPackage = (project_urls: Record<string, string> | undefined, versions = ["1.0.0", "1.1.0", "2.0.0", "2.1.0rc1"]) => ({
  json: { info: { project_urls }, releases: Object.fromEntries(versions.map((v) => [v, []])) },
});
const req = { name: "lib", oldVersion: "1.0.0", newVersion: "2.0.0" };

test("PEP 440: ordering, prereleases, and range selection", () => {
  assert.ok(compareVersions("1.0.0a1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0.dev1", "1.0.0a1") < 0);
  assert.ok(compareVersions("1.0.0", "1.0.0.post1") < 0);
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
  assert.equal(isPrerelease("2.0.0rc1"), true);
  assert.equal(isPrerelease("2.0.0"), false);
  assert.deepEqual(versionsInRange(["1.0.0", "1.1.0", "2.0.0", "2.1.0rc1", "3.0.0"], "1.0.0", "2.0.0"), ["1.1.0", "2.0.0"]);
});

test("describeVersions: short list joined, long list summarized", () => {
  assert.equal(describeVersions(["1.0.0", "1.1.0"]), "1.0.0, 1.1.0");
  assert.equal(describeVersions(["1", "2", "3", "4", "5", "6", "7"]), "7 versions (1 to 7)");
});

test("fetchPythonChangelog: finds GitHub repo via project_urls and fetches releases", async () => {
  const fetch = fakeFetch({
    [PYPI]: pypiPackage({ Homepage: "https://example.com", Source: "https://github.com/o/r" }),
    [RELEASES]: { json: [{ tag_name: "v1.1.0", body: "fixed things" }, { tag_name: "v2.0.0", body: "breaking change" }] },
  });
  const result = await fetchPythonChangelog({ ...req, fetch });
  assert.equal(result.source, "github-releases");
  assert.deepEqual(result.repo, { owner: "o", repo: "r" });
  assert.deepEqual(result.missingVersions, []);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1]!.body, "breaking change");
});

test("fetchPythonChangelog: no repo in metadata -> none, with a note", async () => {
  const fetch = fakeFetch({ [PYPI]: pypiPackage(undefined) });
  const result = await fetchPythonChangelog({ ...req, fetch });
  assert.equal(result.source, "none");
  assert.equal(result.repo, undefined);
  assert.ok(result.notes.some((n) => n.includes("No GitHub repository")));
});

test("fetchPythonChangelog: package not found on PyPI -> none, with a note", async () => {
  const fetch = fakeFetch({ [PYPI]: { status: 404 } });
  const result = await fetchPythonChangelog({ ...req, fetch });
  assert.equal(result.source, "none");
  assert.equal(result.availableVersions.length, 0);
  assert.ok(result.notes.some((n) => n.includes("HTTP 404")));
});
