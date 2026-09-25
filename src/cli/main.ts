#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderMarkdown } from "../ci/comment.js";
import { loadConfig } from "../config.js";
import { runPipeline, type PipelineDeps } from "../pipeline/index.js";
import { realDeps } from "../pipeline/real.js";
import type { SandboxProxy } from "../sandbox/proxy-client.js";
import type { RegistryProxyInfo } from "../report/index.js";
import { withRegistryProxy } from "../pipeline/registry-proxy.js";
import { resolveIsolation, type ResolvedIsolation } from "../sandbox/index.js";
import { renderJson, renderSarif, renderText, type Report } from "../report/index.js";
import { parseCliArgs, USAGE, type OutputFormat } from "./args.js";
import { listFilesAtRef, readFileAtRef } from "./git.js";
import { MANAGERS, managerByName, type ManagerSpec } from "../testrun/managers.js";
import { packageVersion } from "./version.js";
import { discoverWorkspacesDetailed, patternsFromTexts, selectWorkspaceDirs } from "../workspaces/index.js";


export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
}

export interface DepsFactoryOptions {
  projectDir: string;
  oldLockfile: string;
  manager: ManagerSpec["name"];
  oldPackageJson?: string;
  oldFiles?: Record<string, string | null>;
  isolation: ResolvedIsolation;
  /** Set when `registryAuth` is on: the sandboxes talk to registries through this proxy. */
  proxy?: SandboxProxy;
  registryProxyInfo?: () => RegistryProxyInfo;
}

export type DepsFactory = (options: DepsFactoryOptions) => PipelineDeps;

/** Returns the process exit code: 0 ok, 1 verdict at/above failOn, 2 usage or runtime error. */
export async function runCli(argv: string[], io: CliIo, makeDeps?: DepsFactory): Promise<number> {
  try {
    const args = parseCliArgs(argv);
    if (args.help) {
      io.out(USAGE);
      return 0;
    }
    if (args.version) {
      io.out(packageVersion());
      return 0;
    }
    if (!args.base && !args.oldLockfile) throw new Error("need --base <git-ref> or --old <lockfile> (see --help)");

    const projectDir = resolve(args.projectDir);
    const config = await loadConfig(projectDir);
    if (args.failOn) config.failOn = args.failOn;
    if (args.isolation) config.isolation = args.isolation;
    if (args.network) config.containerNetwork = args.network;
    if (args.registryAuth) config.registryAuth = true;
    if (args.registryAllowlistOff) config.registryAllowlist = false;

    const manager = await pickManager(args.newLockfile ?? args.oldLockfile, projectDir);
    const oldLockfile = args.oldLockfile ? await readFile(args.oldLockfile, "utf8") : await readFileAtRef(projectDir, args.base!, manager.lockfile);
    const newLockfile = await readNewLockfile(args.newLockfile ?? join(projectDir, manager.lockfile), projectDir);
    const manifest = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
    const oldPackageJson = await readOldPackageJson(args, projectDir);

    const discovery = await discoverWorkspacesDetailed(projectDir);
    for (const note of discovery.notes) io.err(`ratchet: ${note}`);
    const workspaces = discovery.workspaces;
    const oldFiles = await readOldWorkspaceManifests(args, projectDir, workspaces.map((w) => w.dir), oldPackageJson);

    const isolation = await resolveIsolation({ mode: config.isolation, runtime: config.containerRuntime, image: config.containerImage, network: config.containerNetwork });
    for (const note of isolation.notes) io.err(`ratchet: ${note}`);

    if (workspaces.length > 0) io.err(`ratchet: workspace project (${workspaces.length} packages); tests run via the root scripts.test only`);
    const manifestNames = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((k) => Object.keys((manifest[k] as Record<string, string> | undefined) ?? {}));
    const report = await withRegistryProxy(
      { config, isolation, projectDir, env: io.env, lockfiles: [oldLockfile, newLockfile], manifestNames, log: (line) => io.err(`ratchet: ${line}`) },
      (run) => {
        const deps = (makeDeps ?? defaultDeps(config, io.env))({ projectDir, oldLockfile, manager: manager.name, oldPackageJson, oldFiles, isolation, proxy: run?.proxy, registryProxyInfo: run?.info });
        return runPipeline({ oldLockfile, newLockfile, manifest, workspaces, oldPackageJson, config }, deps);
      },
    );

    io.out(render(report, args.format));
    if (args.reportDir) await writeReports(resolve(args.reportDir), report);
    return exitCode(report, config.failOn);
  } catch (error) {
    io.err(`ratchet: ${(error as Error).message}`);
    return 2;
  }
}

function defaultDeps(config: Awaited<ReturnType<typeof loadConfig>>, env: NodeJS.ProcessEnv): DepsFactory {
  return (options) => realDeps({ ...options, config, githubToken: env.GITHUB_TOKEN });
}

/**
 * Which lockfile format is in play: by an explicit file's name, else its content, else whichever
 * supported lockfile sits in the project (same order the test runner uses).
 */
async function pickManager(explicit: string | undefined, projectDir: string): Promise<ManagerSpec> {
  if (explicit) {
    const byName = MANAGERS.find((m) => basename(explicit) === m.lockfile);
    if (byName) return supportedOrThrow(byName);
    const head = (await readFile(explicit, "utf8").catch(() => "")).trimStart();
    if (head === "" || head.startsWith("{")) return managerByName("npm");
    return managerByName(/^lockfileVersion:/m.test(head) ? "pnpm" : "yarn");
  }
  const present = MANAGERS.find((m) => existsSync(join(projectDir, m.lockfile)));
  if (present) return supportedOrThrow(present);
  return managerByName("npm");
}

function supportedOrThrow(manager: ManagerSpec): ManagerSpec {
  if (!manager.supported) throw new Error(`found ${manager.lockfile}, but ${manager.name} lockfiles are not supported yet`);
  return manager;
}

/** A missing lockfile is the most likely first-run error, so say what ratchet supports instead of ENOENT. */
async function readNewLockfile(path: string, projectDir: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const hint = "run `npm install` (or `yarn install` / `pnpm install`) to create one";
    throw new Error(`no lockfile at ${path}: ${hint}`);
  }
}

/** The manifest that belongs to the old lockfile; undefined means "same as the working tree's". */
async function readOldPackageJson(args: ReturnType<typeof parseCliArgs>, projectDir: string): Promise<string | undefined> {
  if (args.oldPackageJson) return readFile(args.oldPackageJson, "utf8");
  if (!args.base) return undefined;
  return readFileAtRef(projectDir, args.base, "package.json");
}

/** What the old-state lookup needs from git; injectable so tests can simulate failures. */
export interface GitReader {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
}

/**
 * Workspace projects: the old lockfile only installs against the workspace manifests of its own time.
 * --base: the workspaces are enumerated from the base ref itself (root `workspaces` in the old package.json and
 * the old pnpm-workspace.yaml, matched against the base tree), so a workspace removed since is restored, one added
 * since is deleted (`null`), and an old pnpm-workspace.yaml comes back too. A path is "absent" only when the base
 * tree does not list it; every other git failure is an error, never an empty baseline.
 * --old: the manifests come from `--old-workspace-package-json <dir>=<file>`; the file content is whatever the user
 * chose (it is copied into the sandbox as that workspace's package.json), and <dir> must be a discovered workspace.
 */
export async function readOldWorkspaceManifests(
  args: ReturnType<typeof parseCliArgs>,
  projectDir: string,
  dirs: string[],
  oldPackageJson?: string,
  reader: GitReader = { list: () => listFilesAtRef(projectDir, args.base!), read: (p) => readFileAtRef(projectDir, args.base!, p) },
): Promise<Record<string, string | null> | undefined> {
  const files: Record<string, string | null> = {};
  if (args.base) {
    const tree = await reader.list();
    const inTree = new Set(tree);
    const readTracked = async (path: string): Promise<string> => {
      try {
        return await reader.read(path);
      } catch (error) {
        throw new Error(`cannot read ${path} at ${args.base}: ${(error as Error).message}`);
      }
    };
    const yaml = inTree.has("pnpm-workspace.yaml") ? await readTracked("pnpm-workspace.yaml") : undefined;
    const { patterns } = patternsFromTexts(oldPackageJson, yaml);
    const candidates = tree.filter((f) => f.endsWith("/package.json")).map((f) => f.slice(0, -"/package.json".length));
    const baseDirs = selectWorkspaceDirs(patterns, candidates).dirs;
    for (const dir of baseDirs) files[`${dir}/package.json`] = await readTracked(`${dir}/package.json`);
    for (const dir of dirs) if (!baseDirs.includes(dir)) files[`${dir}/package.json`] = null;
    if (yaml !== undefined) files["pnpm-workspace.yaml"] = yaml;
    else if (existsSync(join(projectDir, "pnpm-workspace.yaml"))) files["pnpm-workspace.yaml"] = null;
  } else if (args.oldWorkspacePackageJsons) {
    for (const [dir, file] of Object.entries(args.oldWorkspacePackageJsons)) {
      if (!dirs.includes(dir)) throw new Error(`--old-workspace-package-json ${dir}: not a discovered workspace directory (found: ${dirs.join(", ") || "none"})`);
      try {
        files[`${dir}/package.json`] = await readFile(file, "utf8");
      } catch (error) {
        throw new Error(`cannot read ${file} (for --old-workspace-package-json ${dir}): ${(error as Error).message}`);
      }
    }
  }
  return Object.keys(files).length > 0 ? files : undefined;
}

function render(report: Report, format: OutputFormat): string {
  return { text: renderText, json: renderJson, sarif: renderSarif, markdown: renderMarkdown }[format](report);
}

/** One pipeline run feeds the CI comment, the SARIF upload and the action's outputs. */
async function writeReports(dir: string, report: Report): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), renderJson(report));
  await writeFile(join(dir, "report.md"), renderMarkdown(report));
  await writeFile(join(dir, "report.sarif"), renderSarif(report));
}

function exitCode(report: Report, failOn: "broken" | "risky"): number {
  if (report.overall === "broken") return 1;
  return report.overall === "risky" && failOn === "risky" ? 1 : 0;
}

// npm installs bins as symlinks, so compare resolved paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const code = await runCli(process.argv.slice(2), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
    env: process.env,
  });
  process.exitCode = code;
}
