import { parseArgs } from "node:util";

export type OutputFormat = "text" | "json" | "sarif" | "markdown";

export interface CliArgs {
  projectDir: string;
  /** Git ref whose package-lock.json is the "before" state. */
  base?: string;
  oldLockfile?: string;
  /** package.json matching --old; defaults to the working tree's. */
  oldPackageJson?: string;
  newLockfile?: string;
  format: OutputFormat;
  failOn?: "broken" | "risky";
  /** Also write report.json, report.md and report.sarif here, whatever the stdout format. */
  reportDir?: string;
  help: boolean;
  version: boolean;
}

export const USAGE = `ratchet: verify a dependency bump before you merge it

Usage: ratchet [project-dir] (--base <git-ref> | --old <lockfile>) [options]

  --base <ref>        compare against package-lock.json at this git ref (e.g. origin/main)
  --old <file>        compare against this lockfile instead of a git ref
  --old-package-json <file>  package.json that goes with --old (default: the working tree's)
  --new <file>        lockfile with the proposed bump (default: <project-dir>/package-lock.json)
  --json              machine-readable output
  --sarif             SARIF 2.1.0 output for code scanning
  --markdown          Markdown output, as posted in pull request comments
  --report-dir <dir>  also write report.json, report.md and report.sarif into <dir>
  --fail-on <level>   exit 1 when the overall verdict is "broken" (default) or "risky"
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
      json: { type: "boolean" },
      sarif: { type: "boolean" },
      markdown: { type: "boolean" },
      "report-dir": { type: "string" },
      "fail-on": { type: "string" },
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

  return {
    projectDir: positionals[0] ?? ".",
    base: values.base,
    oldLockfile: values.old,
    oldPackageJson: values["old-package-json"],
    newLockfile: values.new,
    format: values.json ? "json" : values.sarif ? "sarif" : values.markdown ? "markdown" : "text",
    failOn,
    reportDir: values["report-dir"],
    help: values.help ?? false,
    version: values.version ?? false,
  };
}
