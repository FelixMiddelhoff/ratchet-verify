/**
 * Phase 3 of #15: changelog lookup for a PyPI package. Fetches the PyPI JSON API for the
 * release list and metadata, then follows `project_urls` (or the legacy `home_page`) to
 * GitHub for release notes — reusing the npm core's repo-URL normalization, changelog-file
 * section parser and tag-matching helper (src/changelog/), since those are version-control
 * concepts, not npm-specific ones.
 */
import type { FetchLike, GitHubRepo } from "../src/changelog/index.js";
import { normalizeRepository, parseChangelogSections, versionFromTag } from "../src/changelog/index.js";
import { describeVersions, versionsInRange } from "./version.js";

export interface PythonChangelogEntry {
  version: string;
  body: string;
  origin: "github-release" | "changelog-file";
}

export interface PythonChangelogResult {
  source: "github-releases" | "changelog-file" | "both" | "none";
  entries: PythonChangelogEntry[];
  missingVersions: string[];
  availableVersions: string[];
  repo?: GitHubRepo;
  notes: string[];
}

export interface PythonChangelogRequest {
  name: string;
  oldVersion: string;
  newVersion: string;
  fetch?: FetchLike;
  githubToken?: string;
}

const CHANGELOG_FILES = ["CHANGELOG.md", "HISTORY.md", "CHANGES.md", "changelog.md", "CHANGELOG.rst", "HISTORY.rst", "CHANGES.rst"];
const RELEASE_PAGES = 3;

interface PyPiInfo {
  project_urls?: Record<string, string> | null;
  home_page?: string | null;
}
interface PyPiPackage {
  info?: PyPiInfo;
  releases?: Record<string, unknown[]>;
}

export async function fetchPythonChangelog(request: PythonChangelogRequest): Promise<PythonChangelogResult> {
  const http = request.fetch ?? (globalThis.fetch as FetchLike);
  const result: PythonChangelogResult = { source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] };

  const pkg = await getJson(http, `https://pypi.org/pypi/${encodeURIComponent(request.name)}/json`, {}, result.notes, "PyPI");
  if (!pkg) return result;
  const p = pkg as PyPiPackage;

  result.availableVersions = Object.keys(p.releases ?? {});
  const wanted = versionsInRange(result.availableVersions, request.oldVersion, request.newVersion);
  result.missingVersions = wanted;
  result.repo = findRepo(p.info);
  if (!result.repo) result.notes.push("No GitHub repository found in PyPI project_urls or home_page.");

  const repo = result.repo;
  const addEntries = (list: { version: string; body: string }[], origin: PythonChangelogEntry["origin"]): void => {
    for (const entry of list) {
      if (!result.missingVersions.includes(entry.version)) continue;
      result.entries.push({ ...entry, origin });
      result.missingVersions = result.missingVersions.filter((v) => v !== entry.version);
    }
  };

  if (repo) addEntries(await fetchReleases(http, repo, request.name, wanted, githubHeaders(request.githubToken), result.notes), "github-release");
  if (repo && result.missingVersions.length > 0) addEntries(await fetchChangelogFile(http, repo, result.notes), "changelog-file");

  const origins = new Set(result.entries.map((e) => e.origin));
  result.source = origins.size >= 2 ? "both" : origins.has("github-release") ? "github-releases" : origins.has("changelog-file") ? "changelog-file" : "none";
  if (result.missingVersions.length > 0) result.notes.push(`No notes found for ${describeVersions(result.missingVersions)}`);
  return result;
}

/** project_urls is a free-form label->URL map (Homepage, Source, Repository, Changelog, ...); any GitHub URL wins. */
function findRepo(info: PyPiInfo | undefined): GitHubRepo | undefined {
  const candidates = [...Object.values(info?.project_urls ?? {}), info?.home_page ?? undefined].filter((u): u is string => typeof u === "string" && u.includes("github.com"));
  for (const url of candidates) {
    const repo = normalizeRepository(url);
    if (repo) return repo;
  }
  return undefined;
}

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function getJson(http: FetchLike, url: string, headers: Record<string, string>, notes: string[], label: string): Promise<unknown | undefined> {
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
      if (version && wanted.includes(version) && !release.draft && release.body?.trim()) found.push({ version, body: release.body.trim() });
    }
    if (wanted.every((v) => found.some((f) => f.version === v))) break;
  }
  return found;
}

async function fetchChangelogFile(http: FetchLike, repo: GitHubRepo, notes: string[]): Promise<{ version: string; body: string }[]> {
  const directory = repo.directory ? `${repo.directory}/` : "";
  for (const file of CHANGELOG_FILES) {
    const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${directory}${file}`;
    try {
      const response = await http(url);
      if (response.ok) {
        const sections = parseChangelogSections(await response.text());
        if (sections.length > 0) return sections;
      }
    } catch (error) {
      notes.push(`${file} unreachable: ${(error as Error).message}`);
    }
  }
  return [];
}
