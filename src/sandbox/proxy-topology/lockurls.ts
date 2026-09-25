export interface UrlMapping {
  /** Registry URL prefix as recorded in lockfiles, e.g. `https://registry.corp.example/api/npm/repo/` (trailing slash). */
  from: string;
  /** Proxy URL prefix that replaces it, e.g. `http://ratchet-proxy-1a2b3c4d:3128/_r/corp/` (trailing slash). */
  to: string;
}

const slash = (u: string): string => (u.endsWith("/") ? u : `${u}/`);

/**
 * Points the tarball URLs recorded in a lockfile at the proxy, for the sandbox's copy only (the diffed lockfile is never
 * touched). Needed for yarn classic (`resolved`), pnpm (`tarball:`) and yarn berry (`__archiveUrl=`, percent-encoded): they
 * fetch the recorded URL as is and only npm can be told to replace the host. Integrity hashes are not URLs and never change,
 * so a tampered tarball still fails verification. Longest prefix wins.
 */
export function rewriteLockfileUrls(text: string, mappings: readonly UrlMapping[]): { text: string; replaced: number } {
  let replaced = 0;
  let out = text;
  for (const m of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
    const from = slash(m.from);
    const to = slash(m.to);
    for (const [f, t] of [[from, to], [encodeURIComponent(from), encodeURIComponent(to)]] as const) {
      const parts = out.split(f);
      replaced += parts.length - 1;
      out = parts.join(t);
    }
  }
  return { text: out, replaced };
}

/** npm's public registry is recorded under either host depending on the manager that wrote the lockfile. */
export const PUBLIC_REGISTRY_ALIASES: readonly string[] = ["https://registry.npmjs.org/", "https://registry.yarnpkg.com/"];
