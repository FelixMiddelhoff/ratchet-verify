import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectYarnFlavor } from "../lockfile/yarn.js";
import { rewriteLockfileUrls, rewriteNpmrc, rewriteYarnrcBerry, rewriteYarnrcClassic, type ClientRegistry, type UrlMapping } from "./proxy-topology/index.js";

/** How the sandbox reaches registries through the proxy topology: the internal network to join and the client config to write. */
export interface SandboxProxy {
  /** Internal network of the run (`ProxyTopology.networkName`); every phase that needs a network joins it. */
  network: string;
  /** `ProxyTopology.proxyUrl`. */
  proxyUrl: string;
  registries: readonly ClientRegistry[];
  /** Registry URL prefixes recorded in lockfiles -> proxy URL prefixes. */
  lockUrlMappings: readonly UrlMapping[];
}

export interface AppliedProxyClient {
  /** Names (never values) of registry/auth/network settings removed from the project's rc files. */
  dropped: string[];
  lockUrlsReplaced: number;
}

const readIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/**
 * Rewrites the sandbox COPY of the project so every package manager talks to the proxy and nothing else: rc files lose all
 * registry, auth and network settings, and the lockfile's tarball URLs point at the proxy. Always writes `.npmrc` (npm, pnpm and
 * yarn classic read it); yarn also gets its own file. Never touches the user's project or the diffed lockfile.
 */
export async function applyProxyClient(dir: string, proxy: SandboxProxy, lockfileName: string | undefined): Promise<AppliedProxyClient> {
  const dropped: string[] = [];
  const npmrc = rewriteNpmrc(await readIfExists(join(dir, ".npmrc")), proxy.proxyUrl, proxy.registries);
  await writeFile(join(dir, ".npmrc"), npmrc.text);
  dropped.push(...npmrc.dropped);

  let lockUrlsReplaced = 0;
  if (lockfileName !== undefined) {
    const lockPath = join(dir, lockfileName);
    const lockText = await readIfExists(lockPath);
    if (lockText !== undefined) {
      if (lockfileName === "yarn.lock") {
        const berry = detectYarnFlavor(lockText) === "berry";
        const file = berry ? ".yarnrc.yml" : ".yarnrc";
        const rewritten = (berry ? rewriteYarnrcBerry : rewriteYarnrcClassic)(await readIfExists(join(dir, file)), proxy.proxyUrl, proxy.registries);
        await writeFile(join(dir, file), rewritten.text);
        dropped.push(...rewritten.dropped);
      }
      // npm rewrites `resolved` hosts itself (replace-registry-host=always); the others fetch the recorded URL as is.
      if (lockfileName !== "package-lock.json") {
        const out = rewriteLockfileUrls(lockText, proxy.lockUrlMappings);
        lockUrlsReplaced = out.replaced;
        await writeFile(lockPath, out.text);
      }
    }
  }
  return { dropped, lockUrlsReplaced };
}
