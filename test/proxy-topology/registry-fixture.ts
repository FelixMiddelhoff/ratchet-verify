// Serves one real package (left-pad 1.0.0 and 1.1.0 with real tarballs and integrity) and rejects requests without a token.
// 1.1.0 breaks callers: it exports an object instead of a function.
export const FIXTURE_JS = String.raw`
const os = require("os"), cp = require("child_process"), fs = require("fs"), https = require("https"), crypto = require("crypto");
const ip = Object.values(os.networkInterfaces()).flat().find((a) => a.family === "IPv4" && !a.internal).address;
cp.execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/k.pem", "-out", "/tmp/c.pem", "-days", "1", "-subj", "/CN=fixture", "-addext", "subjectAltName=IP:" + ip], { stdio: "ignore" });
const versions = {}, tarballs = {};
for (const [v, body] of [["1.0.0", "module.exports = (s, n) => String(s).padStart(n);"], ["1.1.0", "module.exports = { padStart: 1 };"]]) {
  fs.mkdirSync("/tmp/pkg-" + v + "/package", { recursive: true });
  fs.writeFileSync("/tmp/pkg-" + v + "/package/package.json", JSON.stringify({ name: "left-pad", version: v, main: "index.js" }));
  fs.writeFileSync("/tmp/pkg-" + v + "/package/index.js", body);
  cp.execFileSync("tar", ["czf", "/tmp/left-pad-" + v + ".tgz", "-C", "/tmp/pkg-" + v, "package"]);
  const tgz = fs.readFileSync("/tmp/left-pad-" + v + ".tgz");
  tarballs["/left-pad/-/left-pad-" + v + ".tgz"] = tgz;
  versions[v] = { name: "left-pad", version: v, dist: { tarball: "https://" + ip + ":8443/left-pad/-/left-pad-" + v + ".tgz", integrity: "sha512-" + crypto.createHash("sha512").update(tgz).digest("base64"), shasum: crypto.createHash("sha1").update(tgz).digest("hex") } };
}
const auth = (h) => (h ? crypto.createHash("sha256").update(h).digest("hex") : "none");
https.createServer({ key: fs.readFileSync("/tmp/k.pem"), cert: fs.readFileSync("/tmp/c.pem") }, (req, res) => {
  console.log("REQ " + req.method + " " + req.url + " auth=" + auth(req.headers.authorization));
  if (!req.headers.authorization) { res.writeHead(401); return res.end("no"); }
  if (req.url === "/left-pad") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ name: "left-pad", "dist-tags": { latest: "1.1.0" }, versions }));
  }
  if (tarballs[req.url]) { res.setHeader("content-type", "application/octet-stream"); return res.end(tarballs[req.url]); }
  res.writeHead(404); res.end("nf");
}).listen(8443, "0.0.0.0", () => {
  console.log("FIXTURE_IP " + ip);
  console.log("FIXTURE_CERT_B64 " + fs.readFileSync("/tmp/c.pem").toString("base64"));
  console.log("FIXTURE_READY");
});
`;
