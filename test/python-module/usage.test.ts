import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { scanPythonUsage } from "../../python-module/usage.js";

// Real python3 subprocess, no mocking (the driver is inline Python, not TS logic to fake around).
// Skipped where python3 is unavailable, same pattern as the container-engine and yarn/pnpm tests.
function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const pythonTest = (name: string, fn: () => Promise<void>) => test(name, { skip: hasPython3() ? false : "python3 not installed" }, fn);

pythonTest("scanPythonUsage: plain import, from-import, aliasing, submodule", async () => {
  const files = [
    {
      path: "app.py",
      text: [
        "import requests",
        "import requests.exceptions as rex",
        "from requests import Session, get as fetch",
        "from requests.auth import HTTPBasicAuth",
        "import os",
        "from . import local_module",
      ].join("\n"),
    },
  ];
  const scan = await scanPythonUsage("requests", files);
  assert.equal(scan.unparsed.length, 0);
  assert.deepEqual(
    scan.sites.map((s) => ({ line: s.line, symbol: s.symbol, kind: s.kind, module: s.module })),
    [
      { line: 1, symbol: "requests", kind: "import", module: "requests" },
      { line: 2, symbol: "rex", kind: "import", module: "requests.exceptions" },
      { line: 3, symbol: "Session", kind: "from-import", module: "requests" },
      { line: 3, symbol: "fetch", kind: "from-import", module: "requests" },
      { line: 4, symbol: "HTTPBasicAuth", kind: "from-import", module: "requests.auth" },
    ],
  );
  assert.equal(scan.sites[0]!.snippet, "import requests");
});

pythonTest("scanPythonUsage: a file with a syntax error is reported as unparsed, others still scanned", async () => {
  const files = [
    { path: "broken.py", text: "def f(:\n    pass" },
    { path: "ok.py", text: "import requests" },
  ];
  const scan = await scanPythonUsage("requests", files);
  assert.deepEqual(scan.unparsed, [{ file: "broken.py" }]);
  assert.equal(scan.sites.length, 1);
  assert.equal(scan.sites[0]!.file, "ok.py");
});

pythonTest("scanPythonUsage: unrelated packages are not reported", async () => {
  const files = [{ path: "app.py", text: "import numpy\nfrom flask import Flask" }];
  const scan = await scanPythonUsage("requests", files);
  assert.equal(scan.sites.length, 0);
});
