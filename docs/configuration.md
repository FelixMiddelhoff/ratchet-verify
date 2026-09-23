# Configuration

Options live in `.ratchetrc` (JSON) in the project directory. Unknown keys are
an error, so a typo can't silently weaken a check.

```json
{
  "ignore": ["some-dev-tool"],
  "maxInstalls": 10,
  "testTimeoutMs": 600000,
  "failOn": "broken"
}
```

| Option | Default | Meaning |
|---|---|---|
| `ignore` | `[]` | Package names left out of the verdict entirely. |
| `maxInstalls` | `10` | Installs allowed per bisection. When it runs out, the result is a narrowed range instead of one version. |
| `testTimeoutMs` | `600000` | A test run (or install) longer than this is killed and counts as a failure. |
| `failOn` | `"broken"` | `"broken"` or `"risky"`: the overall verdict that makes the exit code 1. `--fail-on` overrides it. |

Environment: `GITHUB_TOKEN`, if set, is used for GitHub API calls that fetch
release notes (raises the rate limit). It is never passed to the sandbox that
installs and tests candidate versions.

Outputs: `--json` is a stable machine-readable report (`schemaVersion: 1`),
`--sarif` is SARIF 2.1.0 (broken → error, risky → warning per call site,
partial safe → note), `--markdown` is the pull-request comment.
