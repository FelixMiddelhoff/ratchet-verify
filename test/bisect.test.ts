import { test } from "node:test";
import assert from "node:assert/strict";
import { bisect, type Probe, type ProbeOutcome } from "../src/bisect/index.js";

const versions = (n: number) => Array.from({ length: n }, (_, i) => `1.${i + 1}.0`); // 1.1.0 ... 1.n.0

/** Synthetic range: everything from `culprit` on fails; `unknown` versions can't be judged. */
function probeWith(culprit: string, all: string[], unknown: string[] = []): Probe & { calls: string[] } {
  const calls: string[] = [];
  const fn: Probe = async (version): Promise<ProbeOutcome> => {
    calls.push(version);
    if (unknown.includes(version)) return "unknown";
    return all.indexOf(version) >= all.indexOf(culprit) ? "fail" : "pass";
  };
  return Object.assign(fn, { calls });
}

const run = (all: string[], probe: Probe, maxInstalls?: number) =>
  bisect({ availableVersions: ["1.0.0", ...all], oldVersion: "1.0.0", newVersion: all.at(-1)!, probe, maxInstalls });

test("finds the injected culprit at every position, within ceil(log2 n) installs", async () => {
  for (let n = 1; n <= 20; n++) {
    const all = versions(n);
    for (const culprit of all) {
      const probe = probeWith(culprit, all);
      const result = await run(all, probe, 100);
      assert.equal(result.status, "exact", `n=${n} culprit=${culprit}`);
      assert.equal(result.firstBad, culprit);
      const expectedLastGood = all[all.indexOf(culprit) - 1] ?? "1.0.0";
      assert.equal(result.lastGood, expectedLastGood);
      assert.ok(result.installs <= Math.ceil(Math.log2(n)), `n=${n} used ${result.installs}`);
    }
  }
});

test("single candidate needs no installs: the new version is the culprit", async () => {
  const probe = probeWith("1.1.0", versions(1));
  const result = await run(versions(1), probe);
  assert.deepEqual([result.status, result.firstBad, result.lastGood, result.installs], ["exact", "1.1.0", "1.0.0", 0]);
});

test("never probes the endpoints it already knows", async () => {
  const all = versions(8);
  const probe = probeWith("1.5.0", all);
  await run(all, probe);
  assert.ok(!probe.calls.includes("1.0.0") && !probe.calls.includes("1.8.0"));
});

test("maxInstalls bound yields a narrowed range instead of an exact version", async () => {
  const all = versions(64);
  const result = await run(all, probeWith("1.40.0", all), 3);
  assert.equal(result.status, "narrowed");
  assert.equal(result.installs, 3);
  assert.ok(all.indexOf(result.lastGood) < all.indexOf("1.40.0"));
  assert.ok(all.indexOf(result.firstBad) >= all.indexOf("1.40.0"));
});

test("log records every probe with its outcome", async () => {
  const all = versions(4);
  const result = await run(all, probeWith("1.3.0", all));
  assert.deepEqual(result.log, [
    { version: "1.2.0", outcome: "pass" },
    { version: "1.3.0", outcome: "fail" },
  ]);
});

test("untestable versions are skipped and flagged as possible culprits", async () => {
  const all = versions(6);
  // 1.3.0 is the midpoint and cannot be judged; the real culprit is 1.4.0.
  const result = await run(all, probeWith("1.4.0", all, ["1.3.0"]));
  assert.equal(result.firstBad, "1.4.0");
  assert.equal(result.lastGood, "1.2.0");
  assert.deepEqual(result.ambiguousWith, ["1.3.0"]);
});

test("skipped version outside the final good/bad window is not reported as ambiguous", async () => {
  const all = versions(8);
  const result = await run(all, probeWith("1.7.0", all, ["1.4.0"]));
  assert.equal(result.firstBad, "1.7.0");
  assert.deepEqual(result.ambiguousWith, []);
});

test("newVersion missing from the registry list is still treated as the known-bad end", async () => {
  const result = await bisect({
    availableVersions: ["1.0.0", "1.1.0"],
    oldVersion: "1.0.0",
    newVersion: "1.2.0",
    probe: async () => "pass",
  });
  assert.equal(result.firstBad, "1.2.0");
  assert.equal(result.lastGood, "1.1.0");
});

test("prereleases between the endpoints are not probed", async () => {
  const calls: string[] = [];
  await bisect({
    availableVersions: ["1.0.0", "1.1.0-beta.1", "1.1.0", "1.2.0"],
    oldVersion: "1.0.0",
    newVersion: "1.2.0",
    probe: async (v) => {
      calls.push(v);
      return "pass";
    },
  });
  assert.deepEqual(calls, ["1.1.0"]);
});
