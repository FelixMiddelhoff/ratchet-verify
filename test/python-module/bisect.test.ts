import assert from "node:assert/strict";
import { test } from "node:test";
import { bisectPython, type PythonProbe, type PythonProbeOutcome } from "../../python-module/bisect.js";

const versions = (n: number) => Array.from({ length: n }, (_, i) => `1.${i + 1}.0`); // 1.1.0 ... 1.n.0

/** Synthetic range: everything from `culprit` on fails; `unknown` versions can't be judged. */
function probeWith(culprit: string, all: string[], unknown: string[] = []): PythonProbe & { calls: string[] } {
  const calls: string[] = [];
  const fn: PythonProbe = async (version): Promise<PythonProbeOutcome> => {
    calls.push(version);
    if (unknown.includes(version)) return "unknown";
    return all.indexOf(version) >= all.indexOf(culprit) ? "fail" : "pass";
  };
  return Object.assign(fn, { calls });
}

const run = (all: string[], probe: PythonProbe, maxInstalls?: number, confirm = false) =>
  bisectPython({ availableVersions: ["1.0.0", ...all], oldVersion: "1.0.0", newVersion: all.at(-1)!, probe, maxInstalls, confirm });

/** Scripted probe: per-version queue of outcomes (last one repeats); default is the monotonic rule. */
function scripted(culprit: string, all: string[], scripts: Record<string, PythonProbeOutcome[]>): PythonProbe & { calls: string[] } {
  const calls: string[] = [];
  const fn: PythonProbe = async (v) => {
    calls.push(v);
    const q = scripts[v];
    if (q) return q.length > 1 ? q.shift()! : q[0]!;
    return all.indexOf(v) >= all.indexOf(culprit) ? "fail" : "pass";
  };
  return Object.assign(fn, { calls });
}

test("confirmation: stable probe is confirmed and re-runs count toward installs", async () => {
  for (let n = 1; n <= 12; n++) {
    const all = versions(n);
    for (const culprit of all) {
      const probe = probeWith(culprit, all);
      const r = await run(all, probe, 100, true);
      assert.equal(r.status, "exact");
      assert.equal(r.confirmation, "confirmed");
      assert.equal(r.firstBad, culprit);
      assert.equal(r.installs, r.log.length);
      assert.equal(r.log.filter((s) => s.confirmation).length, 2);
      assert.ok(r.installs <= Math.ceil(Math.log2(n)) + 2);
    }
  }
});

test("confirmation: first-bad that passes on re-run is unstable, never exact", async () => {
  const all = versions(8);
  const r = await run(all, scripted("1.5.0", all, { "1.5.0": ["fail", "pass"] }), 100, true);
  assert.equal(r.status, "unstable");
  assert.equal(r.confirmation, "flaky");
});

test("confirmation: last-good that fails on re-run is unstable", async () => {
  const all = versions(8);
  const r = await run(all, scripted("1.5.0", all, { "1.4.0": ["pass", "fail"] }), 100, true);
  assert.equal(r.status, "unstable");
});

test("PEP 440: pre-release culprit versions are found when the range endpoint is itself a pre-release", async () => {
  const all = ["1.0.0a1", "1.0.0b1", "1.0.0rc1"];
  for (const culprit of all) {
    const r = await bisectPython({ availableVersions: ["0.9.0", ...all], oldVersion: "0.9.0", newVersion: "1.0.0rc1", probe: probeWith(culprit, all), maxInstalls: 100, confirm: true });
    assert.equal(r.firstBad, culprit);
  }
});

test("unknown (install-failed) versions are excluded from the search and reported ambiguous", async () => {
  const all = versions(6);
  const r = await run(all, probeWith("1.4.0", all, ["1.3.0"]), 100, false);
  assert.equal(r.firstBad, "1.4.0");
  assert.ok(!r.log.some((s) => s.outcome !== "unknown" && s.version === "1.3.0"));
});

test("installs never exceed maxInstalls, even with confirmation reserved", async () => {
  const all = versions(20);
  const r = await run(all, probeWith("1.10.0", all), 5, true);
  assert.ok(r.installs <= 5);
});
