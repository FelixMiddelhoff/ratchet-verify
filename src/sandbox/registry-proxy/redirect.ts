export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface RedirectState {
  /** Origin of the configured registry that started this request. */
  registryOrigin: string;
  allowHosts: ReadonlySet<string>;
  maxRedirects: number;
  /** URLs already visited in this chain (including the current one). */
  visited: readonly string[];
  /**
   * Same-origin targets only: is this exactly an allowed package packument/tarball path?
   * When it is not, the hop is treated like a cross-origin one (host allowlist, no credential).
   * Default: everything on the registry origin counts as a package path.
   */
  isPackagePath?: (next: URL) => boolean;
}

export type RedirectDecision =
  | { action: "follow"; url: URL; crossOrigin: boolean; /** true: this and every later hop must go without the credential */ dropCredential: boolean }
  | { action: "deny"; status: number; reason: string };

/** host:port of a URL, default port filled in (https only). */
export function hostPortOf(url: URL): string {
  return `${url.hostname}:${url.port || "443"}`;
}

/**
 * Decides whether the proxy follows a redirect. Pure. `crossOrigin` tells the
 * caller to drop credentials for this and every later hop.
 */
export function decideRedirect(current: URL, location: string | undefined, state: RedirectState): RedirectDecision {
  if (typeof location !== "string" || location.length === 0 || location.length > 2048) return { action: "deny", status: 502, reason: "bad-redirect-location" };
  if (/[\u0000-\u001f\u007f\\]/.test(location)) return { action: "deny", status: 502, reason: "bad-redirect-location" };
  if (state.visited.length > state.maxRedirects) return { action: "deny", status: 502, reason: "redirect-limit" };
  let next: URL;
  try {
    next = new URL(location, current); // relative and protocol-relative resolve against the current hop
  } catch {
    return { action: "deny", status: 502, reason: "bad-redirect-location" };
  }
  if (next.protocol !== "https:") return { action: "deny", status: 403, reason: "redirect-not-https" };
  if (next.username || next.password) return { action: "deny", status: 403, reason: "redirect-userinfo" };
  next.hash = "";
  if (state.visited.includes(next.href)) return { action: "deny", status: 508, reason: "redirect-loop" };
  // Exact origin equality; a shared suffix ("registry.example.com.evil.net") is a different origin.
  const crossOrigin = next.origin !== state.registryOrigin;
  const packagePath = !crossOrigin && (state.isPackagePath?.(next) ?? true);
  if (!packagePath && !state.allowHosts.has(hostPortOf(next))) return { action: "deny", status: 403, reason: "redirect-host-not-allowed" };
  return { action: "follow", url: next, crossOrigin, dropCredential: !packagePath };
}
