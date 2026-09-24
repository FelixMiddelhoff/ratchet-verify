import { normalizeRepository, type GitHubRepo } from "./repo.js";
import { parseChangelogSections } from "./sections.js";
import { extractChangelogFiles, MAX_TARBALL_BYTES } from "./tarball.js";
import { compareVersions, describeVersions, versionsInRange } from "./semver.js";

export { describeVersions, normalizeRepository, parseChangelogSections, versionsInRange };
export type { GitHubRepo };

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** Needed only for the npm-tarball fallback; without it that source is skipped. */
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}>;

export interface ChangelogEntry {
  version: string;
  body: string;
  origin: "github-release" | "changelog-file" | "gitlab-release" | "tarball-file";
}

export interface ChangelogResult {
  /** "none" is a valid outcome: the verdict must say it is tests-only. */
  source: "github-releases" | "gitlab-releases" | "changelog-file" | "tarball-file" | "both" | "none";
  entries: ChangelogEntry[];
  /** In-range versions for which no notes were found anywhere. */
  missingVersions: string[];
  /** Every version the registry lists; the Bisector searches within it. */
  availableVersions: string[];
  repo?: GitHubRepo;
  notes: string[];
}

export interface ChangelogRequest {
  name: string;
  oldVersion: string;
  newVersion: string;
  fetch?: FetchLike;
  githubToken?: string;
}

const CHANGELOG_FILES = ["CHANGELOG.md", "HISTORY.md", "CHANGES.md", "changelog.md", "Changelog.md", "History.md", "Changes.md", "CHANGELOG", "CHANGELOG.markdown", "NEWS.md", "RELEASES.md"];
const WIKI_PAGES = ["Changelog.md", "CHANGELOG.md", "Release-Notes.md"];
const RELEASE_PAGES = 3;

export async function fetchChangelog(request: ChangelogRequest): Promise<ChangelogResult> {
  const http = request.fetch ?? (globalThis.fetch as FetchLike);
  const result: ChangelogResult = { source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] };

  const packument = await getJson(http, registryUrl(request.name), {}, result.notes, "npm registry");
  if (!packument) return result;
  const p = packument as { repository?: Parameters<typeof normalizeRepository>[0]; versions?: Record<string, { dist?: { tarball?: unknown } }> };

  result.availableVersions = Object.keys(p.versions ?? {});
  const wanted = versionsInRange(result.availableVersions, request.oldVersion, request.newVersion);
  result.repo = normalizeRepository(p.repository);
  result.missingVersions = wanted;
  const repo = result.repo;
  if (!repo) result.notes.push("No supported repository (GitHub, GitLab, Bitbucket) found in package metadata.");
  const host = repo?.host ?? "github";
  const asEntries = (list: { version: string; body: string }[], origin: ChangelogEntry["origin"]) =>
    addEntries(result, list.filter((s) => wanted.includes(s.version)).map((s) => ({ ...s, origin })));

  // Priority: host releases > repo changelog file > GitHub wiki > file shipped in the npm tarball.
  if (repo && host === "github") {
    const releases = await fetchReleases(http, repo, request.name, wanted, githubHeaders(request.githubToken), result.notes);
    asEntries(releases, "github-release");
  } else if (repo && host === "gitlab") {
    asEntries(await fetchGitLabReleases(http, repo, request.name, result.notes), "gitlab-release");
  }
  if (repo && result.missingVersions.length > 0) asEntries(await fetchChangelogFile(http, repo, result.notes), "changelog-file");
  if (repo && host === "github" && result.missingVersions.length > 0) asEntries(await fetchWikiChangelog(http, repo, result.notes), "changelog-file");
  if (result.missingVersions.length > 0) {
    const tarball = p.versions?.[request.newVersion]?.dist?.tarball;
    if (typeof tarball === "string") asEntries(await fetchTarballChangelog(http, tarball, result.notes), "tarball-file");
  }

  const origins = new Set(result.entries.map((e) => e.origin));
  result.source = origins.size >= 2 ? "both" : origins.has("github-release") ? "github-releases" : origins.has("gitlab-release") ? "gitlab-releases" : origins.has("changelog-file") ? "changelog-file" : origins.has("tarball-file") ? "tarball-file" : "none";
  if (result.missingVersions.length > 0) result.notes.push(`No notes found for ${describeVersions(result.missingVersions)}`);
  return result;
}

function addEntries(result: ChangelogResult, entries: ChangelogEntry[]): void {
  for (const entry of entries) {
    if (!result.missingVersions.includes(entry.version)) continue;
    result.entries.push(entry);
    result.missingVersions = result.missingVersions.filter((v) => v !== entry.version);
  }
  result.entries.sort((a, b) => compareVersions(a.version, b.version));
}

function registryUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
}

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function getJson(
  http: FetchLike,
  url: string,
  headers: Record<string, string>,
  notes: string[],
  label: string,
): Promise<unknown | undefined> {
  try {
    const response = await http(url, { headers });
    if (response.ok) return await response.json();
    notes.push(response.status === 403 || response.status === 429 ? `${label} rate limited (HTTP ${response.status}); set GITHUB_TOKEN to raise the limit.` : `${label} returned HTTP ${response.status}.`);
  } catch (error) {
    notes.push(`${label} unreachable: ${(error as Error).message}`);
  }
  return undefined;
}

interface GitHubRelease {
  tag_name: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

async function fetchReleases(
  http: FetchLike,
  repo: GitHubRepo,
  packageName: string,
  wanted: string[],
  headers: Record<string, string>,
  notes: string[],
): Promise<{ version: string; body: string }[]> {
  const found: { version: string; body: string }[] = [];
  for (let page = 1; page <= RELEASE_PAGES; page++) {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100&page=${page}`;
    const releases = (await getJson(http, url, headers, notes, "GitHub releases")) as GitHubRelease[] | undefined;
    if (!releases || releases.length === 0) break;
    for (const release of releases) {
      const version = versionFromTag(release.tag_name, packageName);
      if (version && wanted.includes(version) && !release.draft && release.body?.trim()) {
        found.push({ version, body: release.body.trim() });
      }
    }
    if (wanted.every((v) => found.some((f) => f.version === v))) break;
  }
  return found;
}

/**
 * Accepts "v1.2.3", "1.2.3", "pkg-v1.2.3" and monorepo "pkg@1.2.3"; a tag naming a
 * different package ("other@1.2.3") is rejected so sibling packages don't leak in.
 */
export function versionFromTag(tag: string, packageName: string): string | undefined {
  const match = /^(.*?)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!match) return undefined;
  const prefix = match[1]!.replace(/[-@/]$/, "");
  if (prefix === "") return match[2];
  const bare = packageName.replace(/^@[^/]+\//, "");
  return prefix === packageName || prefix === bare ? match[2] : undefined;
}

async function fetchChangelogFile(
  http: FetchLike,
  repo: GitHubRepo,
  notes: string[],
): Promise<{ version: string; body: string }[]> {
  const directory = repo.directory ? `${repo.directory}/` : "";
  for (const file of CHANGELOG_FILES) {
    const url = rawUrl(repo, directory, file);
    try {
      const response = await http(url);
      if (response.ok) {
        const sections = parseChangelogSections(await response.text());
        if (sections.length > 0) return sections; // a pointer file ("see the wiki") has no version sections: keep looking
      }
    } catch (error) {
      notes.push(`${file} unreachable: ${(error as Error).message}`);
    }
  }
  return [];
}

/** Some projects (lodash) keep their changelog in the GitHub wiki, served raw under /wiki/. */
async function fetchWikiChangelog(
  http: FetchLike,
  repo: GitHubRepo,
  notes: string[],
): Promise<{ version: string; body: string }[]> {
  for (const page of WIKI_PAGES) {
    const url = `https://raw.githubusercontent.com/wiki/${repo.owner}/${repo.repo}/${page}`;
    try {
      const response = await http(url);
      if (response.ok) {
        const sections = parseChangelogSections(await response.text());
        if (sections.length > 0) return sections;
      }
    } catch (error) {
      notes.push(`wiki ${page} unreachable: ${(error as Error).message}`);
    }
  }
  return [];
}

function rawUrl(repo: GitHubRepo, directory: string, file: string): string {
  if (repo.host === "gitlab") return `https://gitlab.com/${repo.owner}/${repo.repo}/-/raw/HEAD/${directory}${file}`;
  if (repo.host === "bitbucket") return `https://bitbucket.org/${repo.owner}/${repo.repo}/raw/HEAD/${directory}${file}`;
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${directory}${file}`;
}

async function fetchGitLabReleases(
  http: FetchLike,
  repo: GitHubRepo,
  packageName: string,
  notes: string[],
): Promise<{ version: string; body: string }[]> {
  const project = encodeURIComponent(`${repo.owner}/${repo.repo}`);
  const releases = (await getJson(http, `https://gitlab.com/api/v4/projects/${project}/releases?per_page=100`, {}, notes, "GitLab releases")) as
    | { tag_name?: string; description?: string | null }[]
    | undefined;
  const found: { version: string; body: string }[] = [];
  if (!Array.isArray(releases)) return found;
  for (const release of releases) {
    const version = release.tag_name ? versionFromTag(release.tag_name, packageName) : undefined;
    if (version && release.description?.trim()) found.push({ version, body: release.description.trim() });
  }
  return found;
}

/** The tarball is untrusted input: size-capped, parsed in memory, never unpacked to disk or run. */
async function fetchTarballChangelog(
  http: FetchLike,
  url: string,
  notes: string[],
): Promise<{ version: string; body: string }[]> {
  if (!url.startsWith("https://")) return [];
  try {
    const response = await http(url);
    if (!response.ok || !response.arrayBuffer) return [];
    const length = Number(response.headers?.get("content-length") ?? 0);
    if (length > MAX_TARBALL_BYTES) {
      notes.push("npm tarball skipped: larger than the size cap.");
      return [];
    }
    const files = extractChangelogFiles(new Uint8Array(await response.arrayBuffer()));
    if (!files) {
      notes.push("npm tarball skipped: unreadable or over the size cap.");
      return [];
    }
    for (const file of files) {
      const sections = parseChangelogSections(file.text);
      if (sections.length > 0) return sections;
    }
  } catch (error) {
    notes.push(`npm tarball unreachable: ${(error as Error).message}`);
  }
  return [];
}
