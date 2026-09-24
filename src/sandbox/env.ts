import { join } from "node:path";

/**
 * Allowlist, not denylist: a denylist always misses the next credential name.
 * Anything not named here (GITHUB_TOKEN, NPM_TOKEN, AWS_*, ...) never reaches a candidate install.
 */
const PASSTHROUGH = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "TZ", "CI"];

export interface SandboxPaths {
  home: string;
  tmp: string;
}

export function sandboxPaths(root: string): SandboxPaths {
  return { home: join(root, ".home"), tmp: join(root, ".tmp") };
}

export function buildSandboxEnv(
  paths: SandboxPaths,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const wanted = new Set(PASSTHROUGH);
  for (const [key, value] of Object.entries(source)) {
    // Windows env names are case-insensitive ("Path" vs "PATH").
    if (value !== undefined && wanted.has(key.toUpperCase())) env[key] = value;
  }
  // Redirect every place a package manager looks for user config or auth so the
  // real ~/.npmrc (and its tokens) is unreachable by default lookup.
  Object.assign(env, {
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: join(paths.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(paths.home, "AppData", "Local"),
    TMPDIR: paths.tmp,
    TEMP: paths.tmp,
    TMP: paths.tmp,
    npm_config_cache: join(paths.home, ".npm"),
    npm_config_userconfig: join(paths.home, ".npmrc"),
    npm_config_globalconfig: join(paths.home, ".npmrc-global"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    ...packageManagerHomes(paths.home, join),
  });
  return env;
}

/**
 * pnpm keeps its content-addressable store, metadata cache, state and (via XDG) config under the user's
 * home or data dirs, and corepack keeps downloaded manager binaries; point every one of them into the
 * sandbox so nothing reads the host's rc files or store and nothing persists past teardown. pnpm reads
 * `npm_config_<setting>` variables like npm does.
 */
export function packageManagerHomes(home: string, join: (...parts: string[]) => string = (...p) => p.join("/")): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    PNPM_HOME: join(home, ".pnpm-home"),
    npm_config_store_dir: join(home, ".pnpm-store"),
    npm_config_cache_dir: join(home, ".pnpm-cache"),
    npm_config_state_dir: join(home, ".pnpm-state"),
    COREPACK_HOME: join(home, ".corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
}
