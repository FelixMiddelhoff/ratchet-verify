export interface GitHubRepo {
  owner: string;
  repo: string;
  /** Subdirectory of a monorepo that holds this package. */
  directory?: string;
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
  if (!match) return undefined;
  const repo: GitHubRepo = { owner: match[1]!, repo: match[2]! };
  if (directory) repo.directory = directory.replace(/^\/+|\/+$/g, "");
  return repo;
}
