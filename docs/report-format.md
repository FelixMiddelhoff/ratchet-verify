# Report formats

`ratchet-verify` prints text by default. `--json`, `--sarif` and `--markdown`
switch the format, and `--report-dir <dir>` writes all three files
(`report.json`, `report.sarif`, `report.md`) from a single run, whatever is
printed.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Overall verdict is below `--fail-on` (default: anything but `broken`) |
| `1` | Overall verdict is `broken`, or `risky` with `--fail-on risky` |
| `2` | ratchet could not run (bad arguments, unreadable lockfile, …) |

## JSON (`--json`)

Stable schema, versioned by `schemaVersion` (currently `1`). New fields may be
added within a version; existing ones aren't removed or changed.

```json
{
  "schemaVersion": 1,
  "overall": "risky",
  "verdicts": [
    {
      "name": "commander",
      "oldVersion": "8.3.0",
      "newVersion": "9.0.0",
      "direct": true,
      "status": "risky",
      "confidence": "full",
      "summary": "tests pass, but the changelog names 2 symbol uses in your code as breaking",
      "evidence": [ … ],
      "caveats": [ "major version bump: breaking changes are allowed even if the changelog does not list them" ],
      "notes": []
    }
  ]
}
```

| Field | Values / meaning |
|---|---|
| `overall` | `"safe"`, `"risky"` or `"broken"`: the worst verdict below. `verdicts` is empty (and `overall` is `"safe"`) when no dependency changed. |
| `status` | `"safe"`, `"risky"`, `"broken"` |
| `confidence` | `"full"`, or `"reduced"` when a signal was missing. `status: "safe"` with `confidence: "reduced"` is the "safe (partial)" verdict. Don't treat it as an all-clear. |
| `oldVersion` / `newVersion` | Absent for a dependency that was added / removed. |
| `direct` | `true` when `package.json` lists the package at the top level. |
| `caveats` | Gaps that reduced confidence, in words. |
| `notes` | Informational, e.g. "new dependency" or a rate-limit remark. |

### Evidence

Each entry has a `kind`:

**`call-site`**: a changelog breaking change that names something your code uses.

```json
{
  "kind": "call-site",
  "symbol": "option",
  "file": "cli.js",
  "line": 3,
  "snippet": "program.option(\"-d, --debug\", \"enable debug output\");",
  "changelogVersion": "9.0.0",
  "changelogExcerpt": "- *Breaking:* default value specified for boolean option now always used as default value …",
  "matchConfidence": "high",
  "reason": "named in a breaking-change section"
}
```

`matchConfidence` is `"high"` (breaking-change section or BREAKING marker) or
`"medium"` (removed/renamed/deprecated note, or a semver-major release).

**`bisect`**: the failing tests, narrowed to a version.
`exact` is `true` for a single version, `false` when the install budget ran out
(then `lastGood < v <= firstBad`). `ambiguousWith` lists untestable versions in
that window; `failingOutput` is the last 40 lines of the test output.

**`test-failure`**: tests failed, but the failure isn't pinned to one version.
`outcome` is `"failed"`, `"timed-out"` or `"install-failed"`; `output` is the
last 40 lines; `bisectSkippedReason` may say why there was no bisection.

**`no-tests`**: nothing was run against the bump (`reason` says why).

## SARIF (`--sarif`)

SARIF 2.1.0, the subset GitHub code scanning reads.

| Rule | Level | When |
|---|---|---|
| `ratchet/broken` | error | a `broken` verdict (located at `package.json`, line 1) |
| `ratchet/risky` | warning | one result per risky call site, located at that `file:line`; or one at `package.json` for an unverified bump |
| `ratchet/partial` | note | a "safe (partial)" verdict |

Fully evaluated `safe` verdicts produce no result. Example result:

```json
{
  "ruleId": "ratchet/risky",
  "level": "warning",
  "message": { "text": "commander 8.3.0 -> 9.0.0: option — changelog 9.0.0: - *Breaking:* default value specified for boolean option now always used as default value …" },
  "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "cli.js" }, "region": { "startLine": 3 } } }]
}
```

## Markdown (`--markdown`)

The pull request comment: a summary table, with a collapsible section per
verdict that needs explaining. It begins with the marker
`<!-- ratchet-verdict -->`, which is how the GitHub Action finds its own comment
to update instead of posting a new one. Output is kept below GitHub's comment
size limit. See [tutorial.md](tutorial.md#6-machine-readable-output) for a
full example.

## Reading the report from a script

```
ratchet-verify . --base main --json > report.json
node -e 'const r = require("./report.json"); for (const v of r.verdicts) console.log(v.status, v.name, v.summary)'
```
