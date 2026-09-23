import { normalizeRepository, type GitHubRepo } from "./repo.js";
import { parseChangelogSections } from "./sections.js";
import { compareVersions, versionsInRange } from "./semver.js";

export { normalizeRepository, parseChangelogSections, versionsInRange };
export type { GitHubRepo };

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ChangelogEntry {
  version: string;
  body: string;
  origin: "github-release" | "changelog-file";
}

export interface ChangelogResult {
  /** "none" is a valid outcome: the verdict must say it is tests-only. */
  source: "github-releases" | "changelog-file" | "both" | "none";
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

const CHANGELOG_FILES = ["CHANGELOG.md", "HISTORY.md", "CHANGES.md", "changelog.md"];
const RELEASE_PAGES = 3;

export async function fetchChangelog(request: ChangelogRequest): Promise<ChangelogResult> {
  const http = request.fetch ?? (globalThis.fetch as FetchLike);
  const result: ChangelogResult = { source: "none", entries: [], missingVersions: [], availableVersions: [], notes: [] };

  const packument = await getJson(http, registryUrl(request.name), {}, result.notes, "npm registry");
  if (!packument) return result;
  const p = packument as { repository?: Parameters<typeof normalizeRepository>[0]; versions?: Record<string, unknown> };

  result.availableVersions = Object.keys(p.versions ?? {});
  const wanted = versionsInRange(result.availableVersions, request.oldVersion, request.newVersion);
  result.repo = normalizeRepository(p.repository);
  result.missingVersions = wanted;
  if (!result.repo) {
    result.notes.push("No GitHub repository found in package metadata; no changelog can be fetched.");
    return result;
  }

  const github = githubHeaders(request.githubToken);
  const releases = await fetchReleases(http, result.repo, request.name, wanted, github, result.notes);
  addEntries(result, releases.map((r) => ({ ...r, origin: "github-release" as const })));

  if (result.missingVersions.length > 0) {
    const sections = await fetchChangelogFile(http, result.repo, result.notes);
    addEntries(result, sections.filter((s) => wanted.includes(s.version)).map((s) => ({ ...s, origin: "changelog-file" as const })));
  }

  const origins = new Set(result.entries.map((e) => e.origin));
  result.source = origins.size === 2 ? "both" : origins.has("github-release") ? "github-releases" : origins.has("changelog-file") ? "changelog-file" : "none";
  if (result.missingVersions.length > 0) result.notes.push(`No notes found for: ${result.missingVersions.join(", ")}`);
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
    notes.push(response.status === 403 || response.status === 429 ? `${label} rate limited (HTTP ${response.status}).` : `${label} returned HTTP ${response.status}.`);
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
    const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${directory}${file}`;
    try {
      const response = await http(url);
      if (response.ok) return parseChangelogSections(await response.text());
    } catch (error) {
      notes.push(`${file} unreachable: ${(error as Error).message}`);
    }
  }
  return [];
}
