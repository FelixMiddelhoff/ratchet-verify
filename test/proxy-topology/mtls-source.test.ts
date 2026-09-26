import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CredentialSourceError, sourceRegistries, yarnrcToNpmrc, type ClientCertFiles } from "../../src/sandbox/proxy-topology/index.js";
import { describeRegistryProxy } from "../../src/report/isolation.js";
import { CLIENT_CERT, CLIENT_KEY, CLIENT_KEY_ENCRYPTED } from "../registry-proxy/mtls-fixtures.js";

const files = (map: Record<string, string>): ClientCertFiles => ({ home: "/home/ci", read: (p) => map[p] });
const FILES = { "/etc/ssl/client.pem": CLIENT_CERT, "/etc/ssl/client.key": CLIENT_KEY, "/home/ci/certs/c.pem": CLIENT_CERT, "/home/ci/certs/c.key": CLIENT_KEY, "/etc/ssl/enc.key": CLIENT_KEY_ENCRYPTED };

describe("client certificate sourcing (mutual TLS)", () => {
  test("per-registry certfile/keyfile: only the matching registry gets the certificate; notes never carry a path or PEM", () => {
    const rc = ["registry=https://npm.corp.example/", "@acme:registry=https://mtls.example/npm/", "//mtls.example/npm/:certfile=/etc/ssl/client.pem", "//mtls.example/npm/:keyfile=/etc/ssl/client.key"].join("\n");
    const r = sourceRegistries([rc], {}, [], files(FILES));
    assert.deepEqual(r.registries.map((x) => [x.id, x.clientCertificate !== undefined]), [["main", false], ["r1", true]]);
    const text = JSON.stringify(r.notes);
    assert.match(text, /client certificate/);
    assert.ok(!text.includes("/etc/ssl") && !text.includes("BEGIN"));
  });

  test("global certfile/keyfile apply to every configured registry; ~/ is the home directory", () => {
    const rc = ["registry=https://a.example/", "@b:registry=https://b.example/", "certfile=~/certs/c.pem", "keyfile=~/certs/c.key"].join("\n");
    const r = sourceRegistries([rc], {}, [], files(FILES));
    assert.deepEqual(r.registries.map((x) => x.clientCertificate !== undefined), [true, true]);
  });

  test("inline cert/key with escaped newlines work without any file access", () => {
    const inline = (pem: string): string => pem.trim().split("\n").join("\\n");
    const rc = [`cert=${inline(CLIENT_CERT)}`, `key=${inline(CLIENT_KEY)}`].join("\n");
    const r = sourceRegistries([rc], {});
    assert.ok(r.registries[0]!.clientCertificate);
  });

  test("relative paths, unreadable files, a lone half and an encrypted key are refused; messages name the setting, never a path or key", () => {
    const attempts: Array<[string, RegExp]> = [
      [["certfile=client.pem", "keyfile=client.key"].join("\n"), /absolute path/],
      [["certfile=/etc/ssl/missing.pem", "keyfile=/etc/ssl/client.key"].join("\n"), /cannot be read/],
      ["certfile=/etc/ssl/client.pem", /needs both/],
      [["certfile=/etc/ssl/client.pem", "keyfile=/etc/ssl/enc.key"].join("\n"), /passphrase-protected keys are not supported/],
    ];
    for (const [rc, expected] of attempts) {
      assert.throws(
        () => sourceRegistries([rc], {}, [], files(FILES)),
        (e: unknown) => e instanceof CredentialSourceError && expected.test(e.message) && !e.message.includes("/etc/ssl") && !e.message.includes("PRIVATE KEY") && !e.message.includes("MIIE"),
      );
    }
    assert.throws(() => sourceRegistries(["certfile=/etc/ssl/client.pem", "keyfile=/etc/ssl/client.key"], {}), CredentialSourceError, "no reader = an error, never a silent skip");
  });

  test("${VAR} in a path is expanded; an unset one is an error naming the variable", () => {
    const rc = ["certfile=${CERT_DIR}/client.pem", "keyfile=${CERT_DIR}/client.key"].join("\n");
    const r = sourceRegistries([rc], { CERT_DIR: "/etc/ssl" }, [], files(FILES));
    assert.ok(r.registries[0]!.clientCertificate);
    assert.throws(() => sourceRegistries([rc], {}, [], files(FILES)), /CERT_DIR/);
  });

  test("yarn berry httpsCertFilePath/httpsKeyFilePath (global and per registry) become certfile/keyfile", () => {
    const yml = ["httpsCertFilePath: /etc/ssl/client.pem", "httpsKeyFilePath: /etc/ssl/client.key", "npmRegistries:", "  //mtls.example/npm:", "    httpsCertFilePath: /home/ci/certs/c.pem", "    httpsKeyFilePath: /home/ci/certs/c.key", ""].join("\n");
    const rc = yarnrcToNpmrc(yml);
    assert.match(rc, /^certfile=\/etc\/ssl\/client\.pem$/m);
    assert.match(rc, /^\/\/mtls\.example\/npm\/:keyfile=\/home\/ci\/certs\/c\.key$/m);
    const r = sourceRegistries([rc + "\nregistry=https://mtls.example/npm/\n"], {}, [], files(FILES));
    assert.ok(r.registries[0]!.clientCertificate);
  });

  test("the report says a client certificate is held by the proxy, and shows neither path nor content", () => {
    const line = describeRegistryProxy({
      registries: [{ id: "main", host: "mtls.example/npm", credential: "bearer", clientCertificate: true }, { id: "r1", host: "b.example", credential: "none", clientCertificate: true }],
      allowlist: "on", allowHosts: [], allowedPackages: 3, discoveredPackages: [], requestsAllowed: 1, requestsDenied: 0, suspicious: [], auditTruncated: false,
    });
    assert.match(line, /mtls\.example\/npm \(bearer credential \+ client certificate held by the proxy\)/);
    assert.match(line, /b\.example \(client certificate held by the proxy\)/);
  });
});
