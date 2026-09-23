#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderMarkdown } from "../ci/comment.js";
import { loadConfig } from "../config.js";
import { runPipeline, type PipelineDeps } from "../pipeline/index.js";
import { realDeps } from "../pipeline/real.js";
import { renderJson, renderSarif, renderText, type Report } from "../report/index.js";
import { parseCliArgs, USAGE, type OutputFormat } from "./args.js";
import { readFileAtRef } from "./git.js";

const LOCKFILE = "package-lock.json";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
}

export type DepsFactory = (options: { projectDir: string; oldLockfile: string; oldPackageJson?: string }) => PipelineDeps;

/** Returns the process exit code: 0 ok, 1 verdict at/above failOn, 2 usage or runtime error. */
export async function runCli(argv: string[], io: CliIo, makeDeps?: DepsFactory): Promise<number> {
  try {
    const args = parseCliArgs(argv);
    if (args.help) {
      io.out(USAGE);
      return 0;
    }
    if (!args.base && !args.oldLockfile) throw new Error("need --base <git-ref> or --old <lockfile> (see --help)");

    const projectDir = resolve(args.projectDir);
    const config = await loadConfig(projectDir);
    if (args.failOn) config.failOn = args.failOn;

    const oldLockfile = args.oldLockfile ? await readFile(args.oldLockfile, "utf8") : await readFileAtRef(projectDir, args.base!, LOCKFILE);
    const newLockfile = await readFile(args.newLockfile ?? join(projectDir, LOCKFILE), "utf8");
    const manifest = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
    const oldPackageJson = await readOldPackageJson(args, projectDir);

    const deps = (makeDeps ?? defaultDeps(config, io.env))({ projectDir, oldLockfile, oldPackageJson });
    const report = await runPipeline({ oldLockfile, newLockfile, manifest, oldPackageJson, config }, deps);

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

/** The manifest that belongs to the old lockfile; undefined means "same as the working tree's". */
async function readOldPackageJson(args: ReturnType<typeof parseCliArgs>, projectDir: string): Promise<string | undefined> {
  if (args.oldPackageJson) return readFile(args.oldPackageJson, "utf8");
  if (!args.base) return undefined;
  return readFileAtRef(projectDir, args.base, "package.json");
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
