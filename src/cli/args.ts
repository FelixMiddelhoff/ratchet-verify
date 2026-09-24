import { parseArgs } from "node:util";

export type OutputFormat = "text" | "json" | "sarif" | "markdown";

export interface CliArgs {
  projectDir: string;
  /** Git ref whose package-lock.json is the "before" state. */
  base?: string;
  oldLockfile?: string;
  /** package.json matching --old; defaults to the working tree's. */
  oldPackageJson?: string;
  /** Workspace project with --old: `<workspace dir>=<file>` pairs, the workspace package.json files that go with --old. */
  oldWorkspacePackageJsons?: Record<string, string>;
  newLockfile?: string;
  format: OutputFormat;
  failOn?: "broken" | "risky";
  isolation?: "temp-dir" | "container" | "auto";
  network?: "tests-offline" | "open";
  /** Also write report.json, report.md and report.sarif here, whatever the stdout format. */
  reportDir?: string;
  help: boolean;
  version: boolean;
}

export const USAGE = `ratchet: verify a dependency bump before you merge it

Usage: ratchet [project-dir] (--base <git-ref> | --old <lockfile>) [options]

  --base <ref>        compare against the lockfile (package-lock.json or yarn.lock) at this git ref (e.g. origin/main)
  --old <file>        compare against this lockfile instead of a git ref
  --old-package-json <file>  package.json that goes with --old (default: the working tree's)
  --old-workspace-package-json <dir>=<file>  workspace package.json that goes with --old (repeatable; --base reads them from git)
  --new <file>        lockfile with the proposed bump (default: <project-dir>/package-lock.json or yarn.lock)
  --json              machine-readable output
  --sarif             SARIF 2.1.0 output for code scanning
  --markdown          Markdown output, as posted in pull request comments
  --report-dir <dir>  also write report.json, report.md and report.sarif into <dir>
  --isolation <mode>  temp-dir (default), container (docker/podman) or auto
  --network <mode>    container mode: tests-offline (default, tests get no network) or open
  --fail-on <level>  exit 1 when the overall verdict is "broken" (default) or "risky"
  -v, --version       print the version
  -h, --help          show this help

Exit codes: 0 ok, 1 verdict at or above --fail-on, 2 usage or runtime error.
Options can also be set in .ratchetrc (JSON) in the project directory.`;

export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      old: { type: "string" },
      new: { type: "string" },
      "old-package-json": { type: "string" },
      "old-workspace-package-json": { type: "string", multiple: true },
      json: { type: "boolean" },
      sarif: { type: "boolean" },
      markdown: { type: "boolean" },
      "report-dir": { type: "string" },
      "fail-on": { type: "string" },
      isolation: { type: "string" },
      network: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (positionals.length > 1) throw new Error(`expected at most one project directory, got ${positionals.length}`);
  if ([values.json, values.sarif, values.markdown].filter(Boolean).length > 1) {
    throw new Error("--json, --sarif and --markdown are mutually exclusive");
  }
  if (values.base && values.old) throw new Error("--base and --old are mutually exclusive");

  const failOn = values["fail-on"];
  if (failOn !== undefined && failOn !== "broken" && failOn !== "risky") {
    throw new Error(`--fail-on must be "broken" or "risky", got "${failOn}"`);
  }

  const isolation = values.isolation;
  if (isolation !== undefined && isolation !== "temp-dir" && isolation !== "container" && isolation !== "auto") {
    throw new Error(`--isolation must be "temp-dir", "container" or "auto", got "${isolation}"`);
  }

  const network = values.network;
  if (network !== undefined && network !== "tests-offline" && network !== "open") {
    throw new Error(`--network must be "tests-offline" or "open", got "${network}"`);
  }

  const oldWorkspacePackageJsons: Record<string, string> = {};
  for (const pair of values["old-workspace-package-json"] ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`--old-workspace-package-json expects <dir>=<file>, got "${pair}"`);
    oldWorkspacePackageJsons[pair.slice(0, eq).replaceAll("\\", "/").replace(/\/$/, "")] = pair.slice(eq + 1);
  }

  return {
    projectDir: positionals[0] ?? ".",
    ...(Object.keys(oldWorkspacePackageJsons).length > 0 ? { oldWorkspacePackageJsons } : {}),
    base: values.base,
    oldLockfile: values.old,
    oldPackageJson: values["old-package-json"],
    newLockfile: values.new,
    format: values.json ? "json" : values.sarif ? "sarif" : values.markdown ? "markdown" : "text",
    failOn,
    isolation,
    network,
    reportDir: values["report-dir"],
    help: values.help ?? false,
    version: values.version ?? false,
  };
}
