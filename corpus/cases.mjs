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
];
