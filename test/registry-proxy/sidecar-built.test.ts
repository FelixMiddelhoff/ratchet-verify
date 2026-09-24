import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { secretForms } from "../../src/sandbox/registry-proxy/secret.js";
import { CRASH_EXIT_CODE } from "../../src/sandbox/registry-proxy/sink.js";
import { READY_PREFIX } from "../../src/sandbox/registry-proxy/sidecar.js";
import { CANARY, get, raw } from "./fixtures.js";
import { TEST_CERT_IP, TEST_KEY_IP } from "./ipcert.js";

/**
 * Runs the BUILT sidecar entrypoint (main.js) as a child process with a scrubbed environment (no *TOKEN* /
 * *AUTH* variables) and scans everything it prints, and everything it answers, for the canary secret.
 * RATCHET_TEST_SIDECAR_MAIN points the same suite at another build (e.g. dist/ after `npm run build`).
 */
const MAIN = process.env.RATCHET_TEST_SIDECAR_MAIN ?? fileURLToPath(new URL("../../src/sandbox/registry-proxy/main.js", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scrubbedEnv(certFile: string | undefined): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "windir"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (certFile) env.NODE_EXTRA_CA_CERTS = certFile;
  for (const k of Object.keys(env)) assert.ok(!/TOKEN|AUTH|SECRET|PASSWORD|KEY|CREDENTIAL/i.test(k), `test env must be scrubbed: ${k}`);
  return env;
}

interface Sidecar {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

function blob(upstreamPort: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    registries: [{ id: "main", upstream: `https://127.0.0.1:${upstreamPort}`, allowPrivateAddresses: true, credential: { type: "bearer", secret: CANARY } }],
    packages: { allow: ["left-pad", "reflect-pkg", "drop-pkg", "redir-pkg"] },
    allowHosts: [],
    dns: ["127.0.0.1"],
    limits: { requestTimeoutMs: 5000 },
    ...extra,
  });
}

async function startSidecar(opts: { stdin: string; env: NodeJS.ProcessEnv; nodeArgs?: string[]; args?: string[] }): Promise<Sidecar> {
  const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), MAIN, ...(opts.args ?? [])], { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  child.stdin?.on("error", () => undefined); // the child may refuse and exit before reading everything
  child.stdin?.end(opts.stdin);
  let port = 0;
  for (let i = 0; i < 100 && port === 0; i++) {
    const m = new RegExp(`${READY_PREFIX} port=(\\d+)`).exec(out);
    if (m) port = Number(m[1]);
    else if (child.exitCode !== null) break;
    else await sleep(50);
  }
  return {
    child,
    port,
    stdout: () => out,
    stderr: () => err,
    exited,
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

function assertNoCanary(text: string, where: string): void {
  for (const form of secretForms(CANARY)) assert.ok(!text.includes(form), `secret form leaked in ${where}`);
}

describe("built sidecar (main.js) with a scrubbed environment", () => {
  test("normal operation and error paths: the canary appears nowhere (stdout, stderr, HTTP replies)", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-sidecar-"));
    const certFile = join(dir, "ca.pem");
    writeFileSync(certFile, TEST_CERT_IP);
    let upPort = 0;
    const upstream = https.createServer({ key: TEST_KEY_IP, cert: TEST_CERT_IP }, (req, res) => {
      const auth = req.headers.authorization;
      const url = req.url ?? "";
      if (url === "/left-pad") {
        const body = JSON.stringify({ name: "left-pad", versions: { "1.0.0": { dist: { tarball: `https://127.0.0.1:${upPort}/left-pad/-/left-pad-1.0.0.tgz`, integrity: "sha512-x" } } } });
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(body);
      }
      if (url === "/left-pad/-/left-pad-1.0.0.tgz") {
        res.writeHead(auth === `Bearer ${CANARY}` ? 200 : 401, { "content-type": "application/octet-stream" });
        return void res.end("TARBALL");
      }
      if (url.startsWith("/reflect-pkg")) {
        res.writeHead(401, { "www-authenticate": `Bearer ${auth}`, "x-echo": String(auth) });
        return void res.end(`you sent ${auth}`);
      }
      if (url.startsWith("/drop-pkg")) return void req.socket.destroy();
      if (url.startsWith("/redir-pkg")) {
        res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data" });
        return void res.end();
      }
      res.writeHead(404);
      res.end("nope");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upPort = (upstream.address() as net.AddressInfo).port;
    const sc = await startSidecar({ stdin: blob(upPort), env: scrubbedEnv(certFile) });
    try {
      assert.ok(sc.port > 0, `sidecar did not start: ${sc.stderr()}`);
      const replies: string[] = [];
      const record = async (p: string, headers: Record<string, string> = {}, method = "GET"): Promise<number> => {
        const r = await get(sc.port, p, headers, method);
        replies.push(JSON.stringify(r));
        return r.status;
      };
      assert.equal(await record("/left-pad", { authorization: "Bearer attacker" }), 200);
      const pack = replies[0] as string;
      assert.ok(pack.includes(`127.0.0.1:${sc.port}/left-pad/-/left-pad-1.0.0.tgz`) || pack.includes(`127.0.0.1:${sc.port}`), "tarball url rewritten to the sidecar");
      assert.equal(await record("/left-pad/-/left-pad-1.0.0.tgz"), 200, "the credential reached the upstream (it answered 200, not 401)");
      assert.equal(await record("/reflect-pkg"), 401, "a reflecting upstream: status only");
      assert.ok(!replies.at(-1)?.includes("you sent"));
      assert.equal(await record("/drop-pkg"), 502);
      assert.equal(await record("/redir-pkg/-/redir-pkg-1.0.0.tgz"), 403, "redirect to metadata address refused");
      assert.equal(await record("/not-allowlisted"), 403);
      assert.equal(await record("/left-pad", {}, "POST"), 405);
      assert.equal(await record("/-/npm/v1/tokens"), 403);
      for (const rawReq of ["GET /left-pad?x=1 HTTP/1.1\r\nHost: a\r\n\r\n", "CONNECT evil.example:443 HTTP/1.1\r\nHost: x\r\n\r\n", "GARBAGE\r\n\r\n", `GET /${"a".repeat(2000)} HTTP/1.1\r\nHost: a\r\n\r\n`]) {
        replies.push(await raw(sc.port, rawReq, 400));
      }
      await sleep(200);
      assert.equal(sc.stdout().trim().split("\n").length, 1, "stdout carries only the ready line");
      const errLines = sc.stderr().trim().split("\n");
      assert.ok(errLines.length >= 10);
      for (const l of errLines) JSON.parse(l); // every stderr line is one audit JSON object
      const audit = errLines.map((l) => JSON.parse(l) as { decision: string; reason: string; upstreamStatus: number | null });
      assert.ok(audit.some((e) => e.reason === "upstream-401" && e.decision === "upstream-error"));
      assert.ok(audit.some((e) => e.reason === "redirect-host-not-allowed"));
      assertNoCanary(sc.stdout(), "stdout");
      assertNoCanary(sc.stderr(), "stderr");
      assertNoCanary(replies.join("\n"), "http replies");
    } finally {
      await sc.stop();
      assertNoCanary(sc.stdout() + sc.stderr(), "output after exit");
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("startup refusals never echo the canary: bad JSON, unknown keys, canary in env or argv", { timeout: 30_000 }, async () => {
    const cases: { stdin: string; env?: NodeJS.ProcessEnv; args?: string[]; code: number }[] = [
      { stdin: `{"registries": [ ${CANARY}`, code: 2 },
      { stdin: JSON.stringify({ registries: [{ id: "main", upstream: "https://r.example.com", credential: { type: "bearer", secret: CANARY }, [CANARY]: 1 }], dns: ["127.0.0.1"] }), code: 2 },
      { stdin: JSON.stringify({ registries: [{ id: "main", upstream: "https://r.example.com", credential: { type: "bearer", secret: CANARY } }], dns: ["not-an-ip"] }), code: 2 },
      { stdin: JSON.stringify({ registries: [{ id: "main", upstream: "https://r.example.com", credential: { type: "basic", secret: CANARY } }], dns: ["127.0.0.1"] }), code: 2 },
      { stdin: blob(1), args: [`--registry-token=Bearer ${CANARY}`], code: 2 },
      { stdin: blob(1), env: { NPM_TOKEN: CANARY }, code: 2 },
      { stdin: blob(1), env: { SOME_VAR: `x ${CANARY} y` }, code: 2 },
      { stdin: "x".repeat(5 * 1024 * 1024), code: 2 },
    ];
    for (const [i, c] of cases.entries()) {
      const sc = await startSidecar({ stdin: c.stdin, env: { ...scrubbedEnvNoAssert(), ...c.env }, args: c.args });
      const code = await sc.exited;
      assert.equal(code, c.code, `case ${i}: ${sc.stderr()}`);
      assert.equal(sc.stdout(), "", `case ${i}: nothing on stdout`);
      assertNoCanary(sc.stdout() + sc.stderr(), `case ${i}`);
      assert.ok(sc.stderr().length > 0);
    }
  });

  for (const [label, body, delay] of [
    ["uncaughtException after startup (redactor active: message shown, secret scrubbed)", `throw new Error("boom " + ${JSON.stringify(CANARY)} + "\\nsecond line");`, 1500],
    ["unhandledRejection after startup", `Promise.reject(new Error("rejected " + ${JSON.stringify(CANARY)}));`, 1500],
    ["uncaughtException before the config is read (message withheld entirely)", `throw new Error("early " + ${JSON.stringify(CANARY)});`, 0],
    ["throwing a non-Error", `throw { toString() { return ${JSON.stringify(CANARY)}; }, code: ${JSON.stringify(CANARY)} };`, 1500],
  ] as const) {
    test(`forced crash: ${label} -> one redacted line, no stack, exit ${CRASH_EXIT_CODE}`, { timeout: 30_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "ratchet-crash-"));
      const hook = join(dir, "crash-hook.mjs");
      writeFileSync(hook, `setTimeout(() => { ${body} }, ${delay});\n`);
      const sc = await startSidecar({ stdin: blob(1), env: scrubbedEnvNoAssert(), nodeArgs: ["--import", pathToFileURL(hook).href] });
      try {
        const code = await Promise.race([sc.exited, sleep(15_000).then(() => "timeout" as const)]);
        assert.equal(code, CRASH_EXIT_CODE, `stderr: ${sc.stderr()}`);
        const err = sc.stderr().trim();
        const fatal = err.split("\n").filter((l) => l.startsWith("fatal:"));
        assert.equal(fatal.length, 1, err);
        assert.ok(!err.includes("    at "), "no stack trace");
        assert.ok(!err.includes("crash-hook.mjs"), "no throw-site source location");
        assertNoCanary(sc.stdout() + sc.stderr(), "crash output");
        if (delay === 0) assert.equal(fatal[0], "fatal: uncaughtException Error", "before config: no message at all");
      } finally {
        await sc.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("SIGTERM / kill leaves nothing listening", { timeout: 30_000 }, async () => {
    const sc = await startSidecar({ stdin: blob(1), env: scrubbedEnvNoAssert() });
    assert.ok(sc.port > 0);
    await sc.stop();
    await assert.rejects(new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: sc.port, path: "/left-pad", agent: false }, resolve).on("error", reject)));
  });
});

/** Environment for cases that add their own (deliberately bad) variables. */
function scrubbedEnvNoAssert(): NodeJS.ProcessEnv {
  return scrubbedEnv(undefined);
}
