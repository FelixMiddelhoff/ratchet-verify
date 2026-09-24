import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLockfileTexts, parseLockfile } from "../src/lockfile/index.js";
import { buildSandboxEnv, sandboxPaths } from "../src/sandbox/env.js";
import { buildContainerEnv } from "../src/sandbox/container.js";
import { managerByName } from "../src/testrun/index.js";

const manifest = { dependencies: { chalk: "^4", cc: "npm:chalk@4.1.2", "react-dom": "18.2.0" }, devDependencies: { "@types/node": "^20" } };
const integrity = "resolution: {integrity: sha512-abc}";

const v9 = (chalk: string, extra = "") => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      cc:
        specifier: npm:chalk@4.1.2
        version: chalk@${chalk}
      chalk:
        specifier: ^4
        version: ${chalk}
      react-dom:
        specifier: 18.2.0
        version: 18.2.0(react@18.2.0)
    devDependencies:
      '@types/node':
        specifier: ^20
        version: 20.1.0

packages:

  '@types/node@20.1.0':
    ${integrity}

  chalk@${chalk}:
    ${integrity}
    engines: {node: '>=10'}

  react-dom@18.2.0:
    ${integrity}
    peerDependencies:
      react: ^18.2.0

  react@18.2.0:
    ${integrity}

  mylib@1.0.0:
    resolution: {tarball: https://codeload.github.com/o/mylib/tar.gz/abc}
    version: 1.0.0

snapshots:

  '@types/node@20.1.0': {}

  chalk@${chalk}: {}

  react-dom@18.2.0(react@18.2.0):
    dependencies:
      react: 18.2.0

  react@18.2.0: {}
${extra}`;

const v6 = (chalk: string) => `lockfileVersion: '6.0'

dependencies:
  cc:
    specifier: npm:chalk@4.1.2
    version: /chalk@${chalk}
  chalk:
    specifier: ^4
    version: ${chalk}
  react-dom:
    specifier: 18.2.0
    version: 18.2.0(react@18.2.0)

devDependencies:
  '@types/node':
    specifier: ^20
    version: 20.1.0

packages:

  /@types/node@20.1.0:
    ${integrity}
    dev: true

  /chalk@${chalk}:
    ${integrity}
    dependencies:
      ansi-styles: 4.3.0
    dev: false

  /react-dom@18.2.0(react@18.2.0):
    ${integrity}
    dependencies:
      react: 18.2.0
    dev: false

  /react@18.2.0:
    ${integrity}
    dev: false

  github.com/o/mylib/abcdef:
    resolution: {tarball: https://codeload.github.com/o/mylib/tar.gz/abcdef}
    name: mylib
    version: 1.0.0
    dev: false

  file:../local:
    resolution: {directory: ../local, type: directory}
    name: local
    version: 1.0.0
`;

const v5 = (chalk: string) => `lockfileVersion: 5.4

specifiers:
  cc: npm:chalk@4.1.2
  chalk: ^4
  react-dom: 18.2.0
  '@types/node': ^20

dependencies:
  cc: /chalk/${chalk}
  chalk: ${chalk}
  react-dom: 18.2.0_react@18.2.0

devDependencies:
  '@types/node': 20.1.0

packages:

  /@types/node/20.1.0:
    ${integrity}
    dev: true

  /chalk/${chalk}:
    ${integrity}
    dev: false

  /react-dom/18.2.0_react@18.2.0:
    ${integrity}
    peerDependencies:
      react: ^18.2.0
    dev: false

  /react-dom/18.2.0_react@17.0.0+typescript@5.0.0:
    ${integrity}
    dev: false

  /react/18.2.0:
    ${integrity}
    dev: false

  file:packages/x.tgz:
    resolution: {integrity: sha512-x, tarball: file:packages/x.tgz}
    name: x
    version: 1.0.0
    dev: false
`;

for (const [label, make] of [["9.x", v9], ["6.x", v6], ["5.x", v5]] as const) {
  test(`pnpm ${label}: parses registry packages, strips peer suffixes, skips git/file/directory entries`, () => {
    const parsed = parseLockfile(make("4.1.2"));
    const names = [...parsed.values()].map((p) => `${p.name}@${p.version}`).sort();
    assert.deepEqual(names, ["@types/node@20.1.0", "chalk@4.1.2", "react-dom@18.2.0", "react@18.2.0"]);
    assert.equal(parsed.get("node_modules/react-dom")?.version, "18.2.0"); // no (react@..) / _react@.. suffix
  });

  test(`pnpm ${label}: bump is one changed entry, direct via manifest name or alias`, () => {
    const changes = diffLockfileTexts(make("4.1.2"), make("4.2.0"), manifest);
    assert.equal(changes.length, 1);
    assert.deepEqual({ ...changes[0]! }, { name: "chalk", path: "node_modules/chalk", kind: "changed", oldVersion: "4.1.2", newVersion: "4.2.0", direct: true });
  });

  test(`pnpm ${label}: transitive when the manifest does not name it`, () => {
    const [change] = diffLockfileTexts(make("4.1.2"), make("4.2.0"), { dependencies: { "react-dom": "18.2.0" } });
    assert.equal(change!.direct, false);
  });
}

test("pnpm: alias is the real package, direct through the alias name", () => {
  const [change] = diffLockfileTexts(v9("4.1.2"), v9("4.2.0"), { dependencies: { cc: "npm:chalk@4.1.2" } });
  assert.equal(change!.name, "chalk");
  assert.equal(change!.direct, true);
  assert.deepEqual(parseLockfile(v9("4.1.2")).get("node_modules/chalk")?.aliases, ["cc"]);
});

test("pnpm 9.x: peer-suffix-only snapshot variants do not change the diff", () => {
  const withVariant = v9("4.1.2", "\n  react-dom@18.2.0(react@18.2.0)(typescript@5.0.0):\n    dependencies:\n      react: 18.2.0\n");
  assert.deepEqual(diffLockfileTexts(v9("4.1.2"), withVariant, manifest), []);
});

test("pnpm 9.x: importers['.'] decides the root's dependencies, other importers do not count", () => {
  const lock = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      a:
        specifier: ^1
        version: 1.0.0

  packages/web:
    dependencies:
      b:
        specifier: ^1
        version: 2.0.0

packages:

  a@1.0.0:
    ${integrity}

  b@2.0.0:
    ${integrity}
`;
  assert.deepEqual([...parseLockfile(lock).keys()].sort(), ["node_modules/a", "node_modules/b"]);
});

test("pnpm: several versions of one name; root's stays plain, others keyed by major so a minor bump lines up", () => {
  const lock = (nested: string) => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      ms:
        specifier: ^2
        version: 2.1.3

packages:

  ms@2.1.3:
    ${integrity}

  ms@${nested}:
    ${integrity}
`;
  const parsed = parseLockfile(lock("0.7.1"));
  assert.deepEqual([...parsed.keys()].sort(), ["node_modules/ms", "node_modules/ms@0"]);
  const [change] = diffLockfileTexts(lock("0.7.1"), lock("0.7.2"), { dependencies: { ms: "^2" } });
  assert.equal(change!.kind, "changed");
  assert.equal(change!.direct, true); // shared diff rule over-flags: any per-version copy of a root-named package counts as direct
});

test("pnpm: non-matches and bad input", () => {
  assert.deepEqual([...parseLockfile("lockfileVersion: '9.0'\n").keys()], []);
  assert.throws(() => parseLockfile("lockfileVersion: '12.0'\npackages:\n"), /newer than ratchet knows/);
  // No lockfileVersion: not a pnpm lockfile, falls to the yarn reader (which finds no entries).
  assert.deepEqual([...parseLockfile("packages:\n  a@1.0.0:\n    resolution: {}\n").keys()], []);
  // Registry-looking key without a semver version (a tag or URL) is skipped rather than guessed at.
  const odd = "lockfileVersion: '9.0'\npackages:\n  x@https://example.com/x.tgz:\n    resolution: {tarball: https://example.com/x.tgz}\n  y@latest:\n    resolution: {integrity: a}\n";
  assert.deepEqual([...parseLockfile(odd).keys()], []);
});

test("pnpm manager: frozen install and lockfile-only probe", () => {
  const pnpm = managerByName("pnpm");
  assert.equal(pnpm.supported, true);
  assert.deepEqual(pnpm.frozenInstall(""), ["install", "--frozen-lockfile"]);
  assert.deepEqual(pnpm.pinDependency("chalk", "5.0.0", ""), ["add", "chalk@5.0.0", "--lockfile-only", "--ignore-scripts"]);
});

test("sandbox env (temp-dir and container): pnpm store, cache, config and corepack live in the sandbox home", () => {
  const paths = sandboxPaths("/tmp/root");
  const host = buildSandboxEnv(paths, { PATH: "/bin", XDG_CONFIG_HOME: "/home/real/.config", NPM_TOKEN: "t", PNPM_HOME: "/home/real/pnpm", npm_config_store_dir: "/real/store" });
  const container = buildContainerEnv();
  for (const [env, home] of [[host, paths.home], [container, "/sandbox/.home"]] as const) {
    for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "PNPM_HOME", "npm_config_store_dir", "npm_config_cache_dir", "npm_config_state_dir", "COREPACK_HOME"]) {
      const value = env[key]!.replace(/\\/g, "/");
      assert.ok(value.startsWith(home.replace(/\\/g, "/")), `${key}=${value} must be under ${home}`);
    }
  }
  assert.equal(host.NPM_TOKEN, undefined);
  assert.ok(!Object.values(host).some((v) => v.includes("/home/real") || v.includes("/real/store")));
});
