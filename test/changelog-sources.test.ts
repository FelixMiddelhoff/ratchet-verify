import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { fetchChangelog, normalizeRepository, type FetchLike } from "../src/changelog/index.js";
import { extractChangelogFiles } from "../src/changelog/tarball.js";

type Route = { status?: number; json?: unknown; text?: string; bytes?: Uint8Array; length?: string } | Error;

function fakeFetch(routes: Record<string, Route>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url] ?? { status: 404 };
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => route.json,
      text: async () => route.text ?? "",
      arrayBuffer: async () => (route.bytes ?? new Uint8Array()).slice().buffer as ArrayBuffer,
      headers: { get: (n: string) => (n === "content-length" ? (route.length ?? null) : null) },
    };
  };
  return Object.assign(fn, { calls });
}

function tarEntry(name: string, body: string, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(body.length.toString(8).padStart(11, "0"), 124, "ascii");
  header.write(type, 156, "ascii");
  const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  data.write(body);
  return Buffer.concat([header, data]);
}
const tgz = (...entries: Buffer[]) => new Uint8Array(gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));

const NOTES = "## 2.0.0\nBreaking: removed `foo`\n## 1.1.0\nfeat";
const TARBALL = "https://registry.npmjs.org/lib/-/lib-2.0.0.tgz";
const req = { name: "lib", oldVersion: "1.0.0", newVersion: "2.0.0" };
const packument = (repository: unknown) => ({
  json: {
    repository,
    versions: {
      "1.0.0": {},
      "1.1.0": {},
      "2.0.0": { dist: { tarball: TARBALL } },
    },
  },
});
const REGISTRY = "https://registry.npmjs.org/lib";

test("repository: GitLab and Bitbucket spellings", () => {
  assert.deepEqual(normalizeRepository("git+https://gitlab.com/g/p.git"), { host: "gitlab", owner: "g", repo: "p" });
  assert.deepEqual(normalizeRepository("https://gitlab.com/g/sub/p/-/tree/main"), { host: "gitlab", owner: "g/sub", repo: "p" });
  assert.deepEqual(normalizeRepository("git@bitbucket.org:o/r.git"), { host: "bitbucket", owner: "o", repo: "r" });
  assert.deepEqual(normalizeRepository({ url: "https://gitlab.com/g/p", directory: "packages/x" }), { host: "gitlab", owner: "g", repo: "p", directory: "packages/x" });
  assert.equal(normalizeRepository("https://example.com/g/p"), undefined);
  assert.equal(normalizeRepository("https://gitlab.com/onlyone"), undefined);
});

test("gitlab: releases API used first, notes keyed by tag", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument("https://gitlab.com/g/p"),
    "https://gitlab.com/api/v4/projects/g%2Fp/releases?per_page=100": {
      json: [{ tag_name: "v2.0.0", description: "gl release" }, { tag_name: "v1.1.0", description: "  " }, { tag_name: "v0.5.0", description: "old" }],
    },
    "https://gitlab.com/g/p/-/raw/HEAD/CHANGELOG.md": { text: "## 1.1.0\nfrom file" },
  });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "both");
  assert.deepEqual(result.entries.map((e) => [e.version, e.origin, e.body]), [["1.1.0", "changelog-file", "from file"], ["2.0.0", "gitlab-release", "gl release"]]);
});

test("gitlab: no releases, raw CHANGELOG with monorepo directory", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument({ url: "https://gitlab.com/g/p", directory: "pkg" }),
    "https://gitlab.com/g/p/-/raw/HEAD/pkg/CHANGELOG.md": { text: NOTES },
  });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "changelog-file");
  assert.deepEqual(result.missingVersions, []);
});

test("bitbucket: raw file; no releases API is called", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument("https://bitbucket.org/o/r"),
    "https://bitbucket.org/o/r/raw/HEAD/CHANGELOG.md": { text: NOTES },
  });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "changelog-file");
  assert.ok(!http.calls.some((u) => u.includes("api")));
});

test("gitlab: everything absent -> none, missing versions kept", async () => {
  const result = await fetchChangelog({ ...req, fetch: fakeFetch({ [REGISTRY]: packument("https://gitlab.com/g/p") }) });
  assert.equal(result.source, "none");
  assert.deepEqual(result.missingVersions, ["1.1.0", "2.0.0"]);
});

test("tarball fallback when the repo yields nothing (also with no repository)", async () => {
  const bytes = tgz(tarEntry("package/package.json", "{}"), tarEntry("package/CHANGELOG.md", NOTES));
  const http = fakeFetch({ [REGISTRY]: packument(undefined), [TARBALL]: { bytes } });
  const result = await fetchChangelog({ ...req, fetch: http });
  assert.equal(result.source, "tarball-file");
  assert.deepEqual(result.entries.map((e) => [e.version, e.origin]), [["1.1.0", "tarball-file"], ["2.0.0", "tarball-file"]]);
  assert.deepEqual(result.missingVersions, []);
});

test("tarball is not fetched when GitHub already covered every version", async () => {
  const http = fakeFetch({
    [REGISTRY]: packument("o/r"),
    "https://api.github.com/repos/o/r/releases?per_page=100&page=1": { json: [{ tag_name: "v1.1.0", body: "a" }, { tag_name: "v2.0.0", body: "b" }] },
  });
  await fetchChangelog({ ...req, fetch: http });
  assert.ok(!http.calls.includes(TARBALL));
});

test("tarball with no changelog, or only a pointer file, stays none", async () => {
  const none = fakeFetch({ [REGISTRY]: packument(undefined), [TARBALL]: { bytes: tgz(tarEntry("package/index.js", "x")) } });
  assert.equal((await fetchChangelog({ ...req, fetch: none })).source, "none");
  const pointer = fakeFetch({ [REGISTRY]: packument(undefined), [TARBALL]: { bytes: tgz(tarEntry("package/CHANGELOG.md", "see the website")) } });
  assert.equal((await fetchChangelog({ ...req, fetch: pointer })).source, "none");
});

test("tarball: oversize by content-length or garbage bytes is skipped", async () => {
  const big = fakeFetch({ [REGISTRY]: packument(undefined), [TARBALL]: { bytes: tgz(tarEntry("package/CHANGELOG.md", NOTES)), length: String(50 * 1024 * 1024) } });
  const a = await fetchChangelog({ ...req, fetch: big });
  assert.equal(a.source, "none");
  assert.ok(a.notes.some((n) => n.includes("size cap")));
  const junk = fakeFetch({ [REGISTRY]: packument(undefined), [TARBALL]: { bytes: new Uint8Array([1, 2, 3]) } });
  assert.equal((await fetchChangelog({ ...req, fetch: junk })).source, "none");
});

test("tarball: oversize file, traversal, nested, non-regular entries are ignored", () => {
  const files = extractChangelogFiles(
    tgz(
      tarEntry("package/../CHANGELOG.md", "x"),
      tarEntry("../CHANGELOG.md", "x"),
      tarEntry("/etc/CHANGELOG.md", "x"),
      tarEntry("package/docs/CHANGELOG.md", "x"),
      tarEntry("package\\CHANGELOG.md", "x"),
      tarEntry("package/HISTORY.md", "link", "2"),
      tarEntry("package/CHANGES.md", "x".repeat(1024 * 1024 + 1)),
      tarEntry("package/History.md", "ok"),
    ),
  );
  assert.deepEqual(files, [{ name: "History.md", text: "ok" }]);
});

test("tarball: decompression bomb is refused", () => {
  const bomb = new Uint8Array(gzipSync(Buffer.alloc(101 * 1024 * 1024)));
  assert.equal(extractChangelogFiles(bomb), undefined);
});

test("tarball: http url is never fetched", async () => {
  const insecure = fakeFetch({ [REGISTRY]: { json: { versions: { "1.0.0": {}, "2.0.0": { dist: { tarball: "http://x/y.tgz" } } } } } });
  const r = await fetchChangelog({ ...req, fetch: insecure });
  assert.ok(!insecure.calls.includes("http://x/y.tgz"));
  assert.equal(r.source, "none");
});
