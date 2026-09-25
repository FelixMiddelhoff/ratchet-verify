// A token-checking https "private registry" that runs inside a container (started with `node -e`). It serves real tarballs
// with real integrity values:
//   left-pad 1.0.0 (works) and 1.1.0 (breaks callers: exports an object instead of a function);
//   trap 1.0.0 only when the container env has TRAP_B64: a package whose preinstall script is the base64 JS in TRAP_B64
//   (`__FIX_IP__` inside it is replaced by the fixture's own address).
export const FIXTURE_JS = String.raw`
const os = require("os"), cp = require("child_process"), fs = require("fs"), https = require("https"), crypto = require("crypto");
const ip = Object.values(os.networkInterfaces()).flat().find((a) => a.family === "IPv4" && !a.internal).address;
cp.execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/k.pem", "-out", "/tmp/c.pem", "-days", "1", "-subj", "/CN=fixture", "-addext", "subjectAltName=IP:" + ip], { stdio: "ignore" });
const defs = [
  { name: "left-pad", version: "1.0.0", files: { "index.js": "module.exports = (s, n) => String(s).padStart(n);" } },
  { name: "left-pad", version: "1.1.0", files: { "index.js": "module.exports = { padStart: 1 };" } },
];
if (process.env.TRAP_B64) {
  defs.push({ name: "trap", version: "1.0.0", scripts: { preinstall: "node trap.js" }, files: { "index.js": "module.exports = 1;", "trap.js": Buffer.from(process.env.TRAP_B64, "base64").toString().split("__FIX_IP__").join(ip) } });
}
const packuments = {}, tarballs = {};
for (const d of defs) {
  const dir = "/tmp/pkg-" + d.name + "-" + d.version;
  fs.mkdirSync(dir + "/package", { recursive: true });
  fs.writeFileSync(dir + "/package/package.json", JSON.stringify({ name: d.name, version: d.version, main: "index.js", scripts: d.scripts }));
  for (const [f, body] of Object.entries(d.files)) fs.writeFileSync(dir + "/package/" + f, body);
  const file = "/tmp/" + d.name + "-" + d.version + ".tgz";
  cp.execFileSync("tar", ["czf", file, "-C", dir, "package"]);
  const tgz = fs.readFileSync(file);
  tarballs["/" + d.name + "/-/" + d.name + "-" + d.version + ".tgz"] = tgz;
  packuments[d.name] = packuments[d.name] || { name: d.name, "dist-tags": {}, versions: {} };
  packuments[d.name]["dist-tags"].latest = d.version;
  packuments[d.name].versions[d.version] = { name: d.name, version: d.version, scripts: d.scripts, dist: { tarball: "https://" + ip + ":8443/" + d.name + "/-/" + d.name + "-" + d.version + ".tgz", integrity: "sha512-" + crypto.createHash("sha512").update(tgz).digest("base64"), shasum: crypto.createHash("sha1").update(tgz).digest("hex") } };
}
const auth = (h) => (h ? crypto.createHash("sha256").update(h).digest("hex") : "none");
https.createServer({ key: fs.readFileSync("/tmp/k.pem"), cert: fs.readFileSync("/tmp/c.pem") }, (req, res) => {
  console.log("REQ " + req.method + " " + req.url + " auth=" + auth(req.headers.authorization));
  if (!req.headers.authorization) { res.writeHead(401); return res.end("no"); }
  const name = req.url.slice(1);
  if (packuments[name]) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(packuments[name])); }
  if (tarballs[req.url]) { res.setHeader("content-type", "application/octet-stream"); return res.end(tarballs[req.url]); }
  res.writeHead(404); res.end("nf");
}).listen(8443, "0.0.0.0", () => {
  console.log("FIXTURE_IP " + ip);
  console.log("FIXTURE_CERT_B64 " + fs.readFileSync("/tmp/c.pem").toString("base64"));
  console.log("FIXTURE_READY");
});
`;

/** The install script of the `trap` package: everything a credential stealer would try, reported to /sandbox/trap-report.json. */
export const TRAP_JS = String.raw`
const fs = require("fs"), net = require("net"), dns = require("dns"), cp = require("child_process");
const tcp = (host, port) => new Promise((res) => {
  const s = net.connect({ host, port });
  const done = (v) => { try { s.destroy(); } catch (e) {} res(v); };
  s.setTimeout(2500, () => done("timeout"));
  s.on("connect", () => done("connected"));
  s.on("error", (e) => done(e.code || "error"));
});
const sh = (c) => { try { return cp.execSync(c, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { return "ERR " + (e.stdout || ""); } };
(async () => {
  const report = {
    env: process.env,
    proc: sh("cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline | tr '\\0' '\\n'"),
    files: sh("find /sandbox -type f -not -path '*/node_modules/*' -not -name trap-report.json -size -2000k -exec cat {} +"),
    npmrcs: sh("cat /sandbox/project/.npmrc /sandbox/.home/.npmrc /sandbox/project/.yarnrc /sandbox/project/.yarnrc.yml 2>/dev/null"),
    resolv: sh("cat /etc/resolv.conf /etc/hosts"),
    directUpstream: await tcp("__FIX_IP__", 8443),
    directInternet: await tcp("1.1.1.1", 443),
    dnsExternal: await new Promise((res) => dns.lookup("example.com", (err, addr) => res(err ? err.code : "resolved " + addr))),
  };
  fs.writeFileSync("/sandbox/trap-report.json", JSON.stringify(report));
})();
`;
