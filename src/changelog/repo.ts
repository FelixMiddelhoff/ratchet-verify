export interface GitHubRepo {
  owner: string;
  repo: string;
  /** Subdirectory of a monorepo that holds this package. */
  directory?: string;
  /** Absent means GitHub. For GitLab `owner` may hold nested groups ("a/b"). */
  host?: "gitlab" | "bitbucket";
}

type RepositoryField = string | { url?: string; directory?: string } | undefined;

const GITHUB_URL = /github\.com[:/]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[/#].*)?$/;
const SHORTHAND = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/;

/** Normalizes the many spellings authors use in package.json's `repository`; non-GitHub hosts yield undefined. */
export function normalizeRepository(field: RepositoryField): GitHubRepo | undefined {
  if (!field) return undefined;
  const url = typeof field === "string" ? field : field.url;
  const directory = typeof field === "string" ? undefined : field.directory;
  if (!url) return undefined;

  const match = GITHUB_URL.exec(url) ?? SHORTHAND.exec(url);
  const other = match ? undefined : otherHost(url);
  if (!match && !other) return undefined;
  const repo: GitHubRepo = other ?? { owner: match![1]!, repo: match![2]! };
  if (directory) repo.directory = directory.replace(/^\/+|\/+$/g, "");
  return repo;
}

const GITLAB_URL = /gitlab\.com[:/](.+?)(?:\.git)?(?:\/-\/.*|\/tree\/.*|[#?].*)?$/;
const BITBUCKET_URL = /bitbucket\.org[:/]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[/#].*)?$/;
const SAFE_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/;

function otherHost(url: string): GitHubRepo | undefined {
  const bitbucket = BITBUCKET_URL.exec(url);
  if (bitbucket) return { host: "bitbucket", owner: bitbucket[1]!, repo: bitbucket[2]! };
  const gitlab = GITLAB_URL.exec(url);
  const path = gitlab?.[1]?.replace(/\/+$/, "");
  if (!path || !SAFE_PATH.test(path)) return undefined;
  const cut = path.lastIndexOf("/");
  return { host: "gitlab", owner: path.slice(0, cut), repo: path.slice(cut + 1) };
}
