// Runs ratchet against the corpus of historical bumps and compares each verdict with the
// known outcome. Needs network (npm registry, GitHub) and a built CLI: `npm run build` first.
//
//   node corpus/run.mjs [substring-filter]
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.mjs";
import { startRegistry } from "./registry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "dist", "cli", "main.js");
const isWindows = process.platform === "win32";
if (!existsSync(cli)) throw new Error("run `npm run build` first");

const filter = process.argv[2];
const results = [];

const hasContainerEngine = ["docker", "podman"].some((engine) => spawnSync(engine, ["info"], { stdio: "ignore", shell: isWindows }).status === 0);

for (const testCase of cases.filter((c) => !filter || c.name.includes(filter))) {
  if (testCase.isolation === "container" && !hasContainerEngine) {
    console.log(`skip  ${testCase.name} (no container engine)`);
    continue;
  }
  const started = Date.now();
  let failure;
  try {
    failure = await runCase(testCase);
  } catch (error) {
    failure = `runner error: ${error.message}`;
  }
  results.push({ name: testCase.name, failure, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${failure ? "FAIL" : "ok  "}  ${testCase.name} (${results.at(-1).seconds}s)${failure ? `\n      ${failure}` : ""}`);
}

const failed = results.filter((r) => r.failure).length;
console.log(`\n${results.length - failed}/${results.length} corpus cases matched their known outcome`);
process.exitCode = failed ? 1 : 0;

async function runCase(testCase) {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-corpus-"));
  const scratch = mkdtempSync(join(tmpdir(), "ratchet-corpus-scratch-"));
  const exfilPath = join(scratch, "exfil.json");
  let registry;
  try {
    if (testCase.source === "local") {
      const packages = typeof testCase.packages === "function" ? testCase.packages({ exfilPath }) : testCase.packages;
      registry = await startRegistry(packages);
      writeFileSync(join(dir, ".npmrc"), `registry=${registry.url}/\n`);
    }
    for (const [file, content] of Object.entries(testCase.files)) writeFileSync(join(dir, file), content);
    if (testCase.config) writeFileSync(join(dir, ".ratchetrc"), JSON.stringify(testCase.config));

    const { name, old: oldVersion, new: newVersion } = testCase.bump;
    const writeManifest = (version) =>
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "corpus-case", version: "1.0.0", private: true, scripts: { test: "node test.js" }, dependencies: { [name]: version } }));
    // Lockfile-only installs: nothing from the corpus runs on this machine outside ratchet's sandbox.
    const relock = () => npm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], dir);

    writeManifest(oldVersion);
    await relock();
    writeFileSync(join(dir, "old-lock.json"), readFileSync(join(dir, "package-lock.json")));
    writeFileSync(join(dir, "old-package.json"), readFileSync(join(dir, "package.json")));
    writeManifest(newVersion);
    await relock();

    const home = join(scratch, "home");
    mkdirSync(home);
    if (testCase.fakeHomeNpmrc) writeFileSync(join(home, ".npmrc"), testCase.fakeHomeNpmrc);
    const run = await runRatchet(
      [dir, "--old", join(dir, "old-lock.json"), "--old-package-json", join(dir, "old-package.json"), "--json", ...(testCase.isolation ? ["--isolation", testCase.isolation] : [])],
      { ...process.env, ...testCase.env, HOME: home, USERPROFILE: home },
    );
    if (run.status !== 0 && run.status !== 1) return `ratchet exited ${run.status}: ${run.stderr.trim()}`;
    const report = JSON.parse(run.stdout);

    const verdict = report.verdicts.find((v) => v.name === testCase.expect.dependency);
    if (!verdict) return `no verdict for ${testCase.expect.dependency}`;
    const { expect } = testCase;
    if (report.overall !== expect.overall) return `overall ${report.overall}, expected ${expect.overall}`;
    if (verdict.status !== expect.status) return `${verdict.name} is ${verdict.status}, expected ${expect.status}\n      ${verdict.summary}`;
    if (expect.confidence && verdict.confidence !== expect.confidence) return `confidence ${verdict.confidence}, expected ${expect.confidence}`;
    if (expect.summary && !expect.summary.test(verdict.summary)) return `summary "${verdict.summary}" does not match ${expect.summary}`;
    if (expect.isolation && report.isolation?.level !== expect.isolation) return `isolation ${report.isolation?.level}, expected ${expect.isolation}`;
    if (expect.evidenceKind && !verdict.evidence.some((e) => e.kind === expect.evidenceKind)) return `no ${expect.evidenceKind} evidence`;

    const exfil = existsSync(exfilPath) ? JSON.parse(readFileSync(exfilPath, "utf8")) : undefined;
    if (process.env.CORPUS_VERBOSE) console.log(`      ${verdict.status}/${verdict.confidence}: ${verdict.summary}
      exfil: ${JSON.stringify(exfil)}`);
    return testCase.check?.({ exfil, report, verdict });
  } finally {
    await registry?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Async on purpose: the local registry lives in this process, and a blocking child would deadlock it.
function npm(args, cwd) {
  const command = isWindows ? "cmd.exe" : "npm";
  const argv = isWindows ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args;
  return new Promise((resolve, reject) => {
    execFile(command, argv, { cwd }, (error, _stdout, stderr) => (error ? reject(new Error(`npm ${args[0]} failed: ${stderr.trim()}`)) : resolve()));
  });
}

function runRatchet(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
