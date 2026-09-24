// Corpus of historical dependency bumps with known outcomes (see the quality policy: verdicts
// must match before any 1.0 consideration). Real-registry cases fetch real packages; local
// cases serve fixture packages from corpus/registry.mjs for incidents whose packages have
// been unpublished from npm.

const testScript = (code) => code.trim() + "\n";

/** @typedef {{ name: string, old: string, new: string }} Bump */

export const cases = [
  {
    name: "lodash 4.17.20 -> 4.17.21 (known-good baseline)",
    source: "real",
    bump: { name: "lodash", old: "4.17.20", new: "4.17.21" },
    files: {
      "test.js": testScript(`
        const _ = require("lodash");
        if (_.chunk([1, 2, 3, 4], 2).length !== 2) throw new Error("chunk broke");
      `),
    },
    expect: { overall: "safe", dependency: "lodash", status: "safe" },
  },
  {
    name: "chalk 4.1.2 -> 5.3.0 (ESM-only release breaks require)",
    source: "real",
    bump: { name: "chalk", old: "4.1.2", new: "5.3.0" },
    files: {
      "test.js": testScript(`
        const chalk = require("chalk");
        if (typeof chalk.red("x") !== "string") throw new Error("chalk broke");
      `),
    },
    expect: { overall: "broken", dependency: "chalk", status: "broken", summary: /broken by 5\.0\.0/ },
  },
  {
    name: "chalk 4.1.2 -> 5.3.0 via yarn classic (yarn.lock, yarn add bisect probes)",
    source: "real",
    manager: "yarn",
    bump: { name: "chalk", old: "4.1.2", new: "5.3.0" },
    files: {
      "test.js": testScript(`
        const chalk = require("chalk");
        if (typeof chalk.red("x") !== "string") throw new Error("chalk broke");
      `),
    },
    expect: { overall: "broken", dependency: "chalk", status: "broken", summary: /broken by 5\.0\.0/ },
  },
  {
    name: "chalk 4.1.2 -> 5.3.0 via pnpm (pnpm-lock.yaml, pnpm add --lockfile-only bisect probes)",
    source: "real",
    manager: "pnpm",
    bump: { name: "chalk", old: "4.1.2", new: "5.3.0" },
    files: {
      "test.js": testScript(`
        const chalk = require("chalk");
        if (typeof chalk.red("x") !== "string") throw new Error("chalk broke");
      `),
    },
    expect: { overall: "broken", dependency: "chalk", status: "broken", summary: /broken by 5\.0\.0/ },
  },
  {
    name: "faker 5.5.3 -> 6.6.6 (2022 maintainer sabotage, still on npm)",
    source: "real",
    bump: { name: "faker", old: "5.5.3", new: "6.6.6" },
    files: {
      "test.js": testScript(`
        const faker = require("faker");
        if (typeof faker.name.firstName() !== "string") throw new Error("faker broke");
      `),
    },
    expect: { overall: "broken", dependency: "faker", status: "broken" },
  },
  {
    name: "chalk 4.1.2 -> 5.3.0 inside a container (full pipeline incl. bisection)",
    source: "real",
    isolation: "container",
    bump: { name: "chalk", old: "4.1.2", new: "5.3.0" },
    files: {
      "test.js": testScript(`
        const chalk = require("chalk");
        if (typeof chalk.red("x") !== "string") throw new Error("chalk broke");
      `),
    },
    expect: { overall: "broken", dependency: "chalk", status: "broken", summary: /broken by 5\.0\.0/, isolation: "container" },
  },
  {
    name: "commander 8.3.0 -> 9.0.0 (green tests, breaking notes hit the code)",
    source: "real",
    bump: { name: "commander", old: "8.3.0", new: "9.0.0" },
    files: {
      "cli.js": testScript(`
        const { program } = require("commander");
        program.option("-d, --debug", "enable debug output");
        program.parse(["node", "cli", "-d"]);
        module.exports = program.opts();
      `),
      "test.js": testScript(`
        if (require("./cli").debug !== true) throw new Error("debug flag not parsed");
      `),
    },
    expect: { overall: "risky", dependency: "commander", status: "risky", evidenceKind: "call-site" },
  },

  {
    name: "colors.js 1.4.0 -> 1.4.44-liberty-2 style infinite loop (fixture; original unpublished)",
    source: "local",
    bump: { name: "rc-corpus-hang", old: "1.4.0", new: "1.4.44" },
    packages: {
      "rc-corpus-hang": {
        "1.4.0": { files: { "index.js": "module.exports = { red: (s) => s };" } },
        "1.4.44": { files: { "index.js": "while (true) {}" } },
      },
    },
    config: { testTimeoutMs: 5000 },
    files: { "test.js": testScript(`require("rc-corpus-hang");`) },
    // The hang must become a "broken" verdict via the timeout, not a hung ratchet.
    expect: { overall: "broken", dependency: "rc-corpus-hang", status: "broken", summary: /hung/ },
  },
  {
    name: "SAP CAP 'mini Shai-Hulud' style credential-stealing preinstall (fixture)",
    source: "local",
    bump: { name: "rc-corpus-steal", old: "1.0.0", new: "1.0.1" },
    packages: (ctx) => ({
      "rc-corpus-steal": {
        "1.0.0": { files: { "index.js": "module.exports = 1;" } },
        "1.0.1": {
          scripts: { preinstall: "node steal.js" },
          files: {
            "index.js": "module.exports = 1;",
            // Reads what a real stealer would: env tokens and ~/.npmrc, then "exfiltrates" to a host file.
            "steal.js": `
              const fs = require("fs"), os = require("os"), path = require("path");
              const npmrc = path.join(os.homedir(), ".npmrc");
              fs.writeFileSync(${JSON.stringify(ctx.exfilPath)}, JSON.stringify({
                secret: process.env.CORPUS_SECRET ?? null,
                npmToken: process.env.NPM_TOKEN ?? null,
                home: os.homedir(),
                npmrc: fs.existsSync(npmrc) ? fs.readFileSync(npmrc, "utf8") : null,
              }));
            `,
          },
        },
      },
    }),
    files: { "test.js": testScript(`require("rc-corpus-steal");`) },
    env: { CORPUS_SECRET: "hunter2-corpus-secret", NPM_TOKEN: "npm_corpus_token" },
    fakeHomeNpmrc: "//registry.npmjs.org/:_authToken=npm_REAL_LOOKING_TOKEN\n",
    expect: { overall: "safe", dependency: "rc-corpus-steal", status: "safe" },
    // Credentials must not reach the install script, even though it did run.
    check: ({ exfil }) => {
      if (!exfil) return "the malicious preinstall never ran, so isolation was not exercised";
      const seen = JSON.stringify(exfil);
      for (const secret of ["hunter2-corpus-secret", "npm_corpus_token", "npm_REAL_LOOKING_TOKEN"]) {
        if (seen.includes(secret)) return `credential leaked to the install script: ${secret}`;
      }
      return undefined;
    },
  },
  {
    name: "event-stream 3.3.5 -> 3.3.6 / ua-parser-js style silent malice (fixture)",
    source: "local",
    bump: { name: "rc-corpus-stealth", old: "1.0.0", new: "1.0.1" },
    packages: (ctx) => ({
      "rc-corpus-stealth": {
        "1.0.0": { files: { "index.js": "module.exports = () => 42;" } },
        "1.0.1": {
          files: {
            "index.js": `
              try { require("fs").writeFileSync(${JSON.stringify(ctx.exfilPath)}, JSON.stringify({ secret: process.env.CORPUS_SECRET ?? null })); } catch {}
              module.exports = () => 42;
            `,
          },
        },
      },
    }),
    files: { "test.js": testScript(`if (require("rc-corpus-stealth")() !== 42) throw new Error("broke");`) },
    env: { CORPUS_SECRET: "hunter2-corpus-secret" },
    // Honest limitation: behaviour-preserving malice is invisible to a tests-based verdict.
    // ratchet must at least not hand it the credentials, and must not call this a full-confidence safe.
    expect: { overall: "safe", dependency: "rc-corpus-stealth", status: "safe", confidence: "reduced" },
    check: ({ exfil }) => (exfil && JSON.stringify(exfil).includes("hunter2-corpus-secret") ? "credential visible to the test run" : undefined),
  },

  // Truth for the four cases below was established independently of ratchet (2026-09-24): install old and
  // new by hand in scratch dirs, run the same test.js on each, and read the upstream changelog.
  {
    // TRUTH: safe. Manual run: test passes on 4.1.1 and 4.3.4. Semver minor; debug's 4.x releases are fixes
    // (no breaking entries). ratchet: safe/reduced "no changelog was found" (tests-only) - agrees, with a gap
    // noted per policy rule 1.
    name: "debug 4.1.1 -> 4.3.4 (minor release with fixes, safe)",
    source: "real",
    bump: { name: "debug", old: "4.1.1", new: "4.3.4" },
    files: {
      "test.js": testScript(`
        const debug = require("debug");
        const log = debug("test");
        if (typeof log !== "function") throw new Error("debug() broke");
      `),
    },
    expect: { overall: "safe", dependency: "debug", status: "safe", confidence: "reduced" },
  },

  {
    // TRUTH: safe. The original case was circular/wrong: its test asserted isNumber("42") === false, but
    // is-number returns true for numeric strings in BOTH 6.0.0 and 7.0.0, so the test failed on the OLD
    // version and ratchet said "risky: baseline failing" (an artifact of the bad test, not of the bump).
    // Fixed test passes on both. Differential run of 21 inputs (numbers, NaN, Infinity, numeric/blank/hex
    // strings, bool, null, arrays, objects, boxed Number) found zero behavior differences between 6.0.0
    // and 7.0.0. The package ships no changelog or GitHub releases. Expected: safe with reduced confidence
    // (major bump, no changelog: "safe (partial)" per policy rule 1).
    name: "is-number 6.0.0 -> 7.0.0 (major bump, no behavior change for used API)",
    source: "real",
    bump: { name: "is-number", old: "6.0.0", new: "7.0.0" },
    files: {
      "test.js": testScript(`
        const isNumber = require("is-number");
        if (isNumber(42) !== true) throw new Error("is-number(42) broke");
        if (isNumber("42") !== true) throw new Error("is-number('42') broke");
        if (isNumber("abc") !== false) throw new Error("is-number('abc') broke");
      `),
    },
    expect: { overall: "safe", dependency: "is-number", status: "safe", confidence: "reduced" },
  },

  {
    // TRUTH: safe for this usage. Manual run: test passes on 15.4.1 and 16.0.0. Upstream 16.0.0 changelog
    // breaking entries: ESM/Deno API tweaks (default export, hideBin), find-up->escalade + export map
    // (limits deep imports on Node >= 12), yargs-parser 19, single-char aliases first in help, rebase helper
    // removed from instance, Node 8 dropped. None touches yargs("yargs/yargs") + .option + .argv.
    // ratchet: safe/reduced "major version bump" - agrees and matches policy (major => safe (partial)).
    name: "yargs 15.4.1 -> 16.0.0 (major version, test passes with new API)",
    source: "real",
    bump: { name: "yargs", old: "15.4.1", new: "16.0.0" },
    files: {
      "test.js": testScript(`
        const yargs = require("yargs/yargs");
        const result = yargs(["--foo", "bar"]).option("foo", { type: "string" }).argv;
        if (result.foo !== "bar") throw new Error("yargs parsing broke");
      `),
    },
    expect: { overall: "safe", dependency: "yargs", status: "safe", confidence: "reduced" },
  },

  {
    // TRUTH: safe for this usage. Manual run: require("uuid").v4() passes on 7.0.3 and 8.0.0. Upstream 8.0.0
    // breaking entries: (1) ESM default export removed, (2) deep requires like require("uuid/v4") removed.
    // This test uses neither (CJS main entry, named v4), so it is unaffected.
    // ratchet: safe/reduced (major bump). It used to over-flag risky/full because the deep-require bullet's
    // "uuid/v4" matched the root member "v4"; the matcher now masks subpath tokens (PR #25). The true-broken
    // variant is the next case.
    name: "uuid 7.0.3 -> 8.0.0 (main-entry v4, truth safe)",
    source: "real",
    bump: { name: "uuid", old: "7.0.3", new: "8.0.0" },
    files: {
      "test.js": testScript(`
        const uuid = require("uuid");
        const v4 = uuid.v4();
        if (!v4 || typeof v4 !== "string") throw new Error("uuid.v4() broke");
      `),
    },
    expect: { overall: "safe", dependency: "uuid", status: "safe", confidence: "reduced" },
  },

  {
    // TRUTH: broken by 8.0.0 (still-published packages). Manual run: require("uuid/v4")() returns a UUID on
    // 7.0.3 and throws ERR_PACKAGE_PATH_NOT_EXPORTED on 8.0.0. Upstream 8.0.0 changelog, BREAKING: "Deep
    // requiring specific algorithms ... like require('uuid/v4') ... is no longer supported."
    name: "uuid 7.0.3 -> 8.0.0 (deep require uuid/v4 removed, known broken)",
    source: "real",
    bump: { name: "uuid", old: "7.0.3", new: "8.0.0" },
    files: {
      "test.js": testScript(`
        const v4 = require("uuid/v4");
        if (typeof v4() !== "string") throw new Error("uuid/v4 broke");
      `),
    },
    expect: { overall: "broken", dependency: "uuid", status: "broken", summary: /broken by 8\.0\.0/ },
  },
];
