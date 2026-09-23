// A minimal npm registry for corpus cases whose real-world packages were unpublished
// (event-stream, ua-parser-js, colors 1.4.44-liberty-2) or are too dangerous to fetch for real.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * packages: { name: { version: { files: { "index.js": "..." }, scripts?: {...} } } }
 * Returns { url, close }.
 */
export async function startRegistry(packages) {
  const work = mkdtempSync(join(tmpdir(), "ratchet-corpus-registry-"));
  const tarballs = new Map(); // "/name/-/name-1.0.0.tgz" -> Buffer
  const packuments = new Map(); // name -> packument (tarball urls filled in once the port is known)

  for (const [name, versions] of Object.entries(packages)) {
    const meta = { name, "dist-tags": {}, versions: {} };
    for (const [version, spec] of Object.entries(versions)) {
      const dir = join(work, `${name}-${version}`);
      mkdirSync(dir, { recursive: true });
      const manifest = { name, version, main: "index.js", scripts: spec.scripts ?? {} };
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
      for (const [file, content] of Object.entries(spec.files)) writeFileSync(join(dir, file), content);
      // --ignore-scripts: packing must never run the fixture's own lifecycle scripts on the host.
      const packed = execSync(`npm pack --ignore-scripts --pack-destination "${work}" --silent`, { cwd: dir }).toString().trim().split(/\r?\n/).pop();
      const bytes = readFileSync(join(work, packed));
      tarballs.set(`/${name}/-/${name}-${version}.tgz`, bytes);
      meta.versions[version] = {
        ...manifest,
        dist: {
          shasum: createHash("sha1").update(bytes).digest("hex"),
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          tarball: `/${name}/-/${name}-${version}.tgz`,
        },
      };
      meta["dist-tags"].latest = version;
    }
    packuments.set(name, meta);
  }

  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0]);
    if (tarballs.has(path)) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(tarballs.get(path));
    }
    const meta = packuments.get(path.slice(1));
    if (!meta) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(meta));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  // Tarball URLs must be absolute for npm to resolve them against this server.
  for (const meta of packuments.values()) {
    for (const v of Object.values(meta.versions)) v.dist.tarball = `${url}${v.dist.tarball}`;
  }

  return {
    url,
    close: () =>
      new Promise((resolve) => {
        rmSync(work, { recursive: true, force: true });
        server.close(resolve);
      }),
  };
}
