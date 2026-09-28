#!/usr/bin/env node
/**
 * Phase 7 of #15: minimal v1 CLI. Takes explicit paths to the old and new lockfile files
 * (no `--base` git-ref reading yet, unlike the npm core's CLI) — documented follow-up in
 * python-module/README.md, not v1. Config file, JSON/SARIF output and a GitHub Action are
 * likewise follow-ups; the npm core grew those over several PRs after its own CLI first
 * landed (#11/#12/#13), not all at once.
 */
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { detectRuntime, ensureImage, ensurePythonManagerInImage, type PythonContainerSettings } from "./container.js";
import { runPythonPipeline } from "./pipeline.js";
import { realPythonDeps } from "./real.js";
import { renderPythonText } from "./render.js";
import type { PythonReport } from "./report.js";

export interface PythonCliIo {
  out(text: string): void;
  err(text: string): void;
}

export const USAGE =
  "usage: ratchet-python --project <dir> --old-lockfile <path> --new-lockfile <path> [--lockfile-name uv.lock|poetry.lock] [--container <image>] [--test <cmd...>]";

export async function runPythonCli(argv: string[], io: PythonCliIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    io.err(USAGE);
    return 2;
  }
  try {
    const [oldLockfileText, newLockfileText] = await Promise.all([readFile(args.oldLockfile, "utf8"), readFile(args.newLockfile, "utf8")]);
    const container = await resolveContainer(args.containerImage, args.lockfileName);
    const deps = realPythonDeps({ projectDir: args.project, lockfileName: args.lockfileName, testCommand: args.testCommand, container });
    const report = await runPythonPipeline({ oldLockfileText, newLockfileText }, deps);
    io.out(renderPythonText(report));
    return exitCode(report);
  } catch (error) {
    io.err(`ratchet: ${(error as Error).message}`);
    return 2;
  }
}

async function resolveContainer(image: string | undefined, lockfileName: "uv.lock" | "poetry.lock"): Promise<PythonContainerSettings | undefined> {
  if (!image) return undefined;
  const engine = await detectRuntime("auto");
  if (!engine) throw new Error("--container was given but no docker or podman engine was found");
  const settings: PythonContainerSettings = { runtime: engine.runtime, rootless: engine.rootless, image };
  await ensureImage(settings);
  await ensurePythonManagerInImage(settings, lockfileName === "poetry.lock" ? "poetry" : "uv");
  return settings;
}

interface ParsedArgs {
  project: string;
  oldLockfile: string;
  newLockfile: string;
  lockfileName: "uv.lock" | "poetry.lock";
  testCommand?: string[];
  containerImage?: string;
}

function parseArgs(argv: string[]): ParsedArgs | undefined {
  let project: string | undefined;
  let oldLockfile: string | undefined;
  let newLockfile: string | undefined;
  let lockfileName: "uv.lock" | "poetry.lock" | undefined;
  let testCommand: string[] | undefined;
  let containerImage: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") project = argv[++i];
    else if (arg === "--old-lockfile") oldLockfile = argv[++i];
    else if (arg === "--new-lockfile") newLockfile = argv[++i];
    else if (arg === "--container") containerImage = argv[++i];
    else if (arg === "--lockfile-name") {
      const v = argv[++i];
      if (v !== "uv.lock" && v !== "poetry.lock") return undefined;
      lockfileName = v;
    } else if (arg === "--test") {
      testCommand = argv.slice(i + 1);
      break;
    } else return undefined;
  }
  if (!project || !oldLockfile || !newLockfile) return undefined;
  return { project, oldLockfile, newLockfile, lockfileName: lockfileName ?? guessLockfileName(newLockfile), testCommand, containerImage };
}

function guessLockfileName(path: string): "uv.lock" | "poetry.lock" {
  return path.endsWith("poetry.lock") ? "poetry.lock" : "uv.lock";
}

function exitCode(report: PythonReport): number {
  return report.overall === "broken" ? 1 : 0;
}

// Symlinked bins (npm installs them that way) need the resolved path compared.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const code = await runPythonCli(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) });
  process.exitCode = code;
}
