#!/usr/bin/env node
/**
 * v1 CLI (phase 7 of #15) + v2 CLI polish: `--base <ref>` reads the old lockfile from a git
 * ref via `readFileAtRef` (src/cli/git.ts, reused directly — reading a file at a git ref is a
 * git concept, not an npm one), `--format json` adds a JSON renderer alongside the text one.
 * Still not wired: a `package.json` `bin` entry (this module isn't part of `dist`/`files` yet,
 * so publishing it needs its own build step first), a config file, and a GitHub Action.
 */
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileAtRef } from "../src/cli/git.js";
import { detectRuntime, ensureImage, ensurePythonManagerInImage, type PythonContainerSettings } from "./container.js";
import { runPythonPipeline } from "./pipeline.js";
import { realPythonDeps } from "./real.js";
import { renderPythonJson, renderPythonText } from "./render.js";
import type { PythonReport } from "./report.js";

export interface PythonCliIo {
  out(text: string): void;
  err(text: string): void;
}

export const USAGE =
  "usage: ratchet-python --project <dir> (--old-lockfile <path> | --base <git-ref>) [--new-lockfile <path>] [--lockfile-name uv.lock|poetry.lock|requirements.txt] [--container <image>] [--format text|json] [--test <cmd...>]";

export async function runPythonCli(argv: string[], io: PythonCliIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    io.err(USAGE);
    return 2;
  }
  try {
    const newLockfilePath = args.newLockfile ?? join(args.project, args.lockfileName);
    const [oldLockfileText, newLockfileText] = await Promise.all([
      args.base ? readFileAtRef(args.project, args.base, args.lockfileName) : readFile(args.oldLockfile!, "utf8"),
      readFile(newLockfilePath, "utf8"),
    ]);
    const container = await resolveContainer(args.containerImage, args.lockfileName);
    const deps = realPythonDeps({ projectDir: args.project, lockfileName: args.lockfileName, testCommand: args.testCommand, container });
    const report = await runPythonPipeline({ oldLockfileText, newLockfileText }, deps);
    io.out(args.format === "json" ? renderPythonJson(report) : renderPythonText(report));
    return exitCode(report);
  } catch (error) {
    io.err(`ratchet: ${(error as Error).message}`);
    return 2;
  }
}

type LockfileName = "uv.lock" | "poetry.lock" | "requirements.txt";

async function resolveContainer(image: string | undefined, lockfileName: LockfileName): Promise<PythonContainerSettings | undefined> {
  if (!image) return undefined;
  const engine = await detectRuntime("auto");
  if (!engine) throw new Error("--container was given but no docker or podman engine was found");
  const settings: PythonContainerSettings = { runtime: engine.runtime, rootless: engine.rootless, image };
  await ensureImage(settings);
  await ensurePythonManagerInImage(settings, managerFor(lockfileName));
  return settings;
}

function managerFor(lockfileName: LockfileName): "uv" | "poetry" | "pip" {
  if (lockfileName === "poetry.lock") return "poetry";
  if (lockfileName === "requirements.txt") return "pip";
  return "uv";
}

interface ParsedArgs {
  project: string;
  oldLockfile?: string;
  base?: string;
  newLockfile?: string;
  lockfileName: LockfileName;
  testCommand?: string[];
  containerImage?: string;
  format: "text" | "json";
}

function parseArgs(argv: string[]): ParsedArgs | undefined {
  let project: string | undefined;
  let oldLockfile: string | undefined;
  let base: string | undefined;
  let newLockfile: string | undefined;
  let lockfileName: LockfileName | undefined;
  let testCommand: string[] | undefined;
  let containerImage: string | undefined;
  let format: "text" | "json" = "text";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") project = argv[++i];
    else if (arg === "--old-lockfile") oldLockfile = argv[++i];
    else if (arg === "--base") base = argv[++i];
    else if (arg === "--new-lockfile") newLockfile = argv[++i];
    else if (arg === "--container") containerImage = argv[++i];
    else if (arg === "--format") {
      const v = argv[++i];
      if (v !== "text" && v !== "json") return undefined;
      format = v;
    } else if (arg === "--lockfile-name") {
      const v = argv[++i];
      if (v !== "uv.lock" && v !== "poetry.lock" && v !== "requirements.txt") return undefined;
      lockfileName = v;
    } else if (arg === "--test") {
      testCommand = argv.slice(i + 1);
      break;
    } else return undefined;
  }
  if (!project) return undefined;
  if ((oldLockfile === undefined) === (base === undefined)) return undefined; // exactly one of the two
  const resolvedLockfileName = lockfileName ?? guessLockfileName(newLockfile ?? oldLockfile ?? "");
  return { project, oldLockfile, base, newLockfile, lockfileName: resolvedLockfileName, testCommand, containerImage, format };
}

function guessLockfileName(path: string): LockfileName {
  if (path.endsWith("poetry.lock")) return "poetry.lock";
  if (path.endsWith("requirements.txt")) return "requirements.txt";
  return "uv.lock";
}

function exitCode(report: PythonReport): number {
  return report.overall === "broken" ? 1 : 0;
}

// Symlinked bins (npm installs them that way) need the resolved path compared.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const code = await runPythonCli(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) });
  process.exitCode = code;
}
