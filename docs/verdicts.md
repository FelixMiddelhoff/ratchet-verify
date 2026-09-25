# Verdicts

Every changed dependency gets one verdict. The headline rule: **a verdict
never claims more than ratchet actually checked.**

## safe

Tests pass and no breaking change in the changelog names anything your code
uses. Two flavours:

- **safe** — every signal was evaluated: changelog found for every version in
  the range, source files all parsed, not a major-version bump.
- **safe (partial)** — tests pass, but a signal is missing. Each gap is listed
  as a `caveat`:
  - no changelog was found (a tests-only verdict)
  - changelog notes are missing for some versions in the range
  - the bump crosses a major version (breaking changes are allowed even when
    unlisted)
  - a source file could not be parsed, so the usage scan is incomplete
  - your code uses the whole module or its default export, so listed breaking
    changes cannot be ruled out
  - this version newly runs an install script (or a new dependency has one):
    tests cannot show what it does outside the sandbox. npm and pnpm
    lockfiles record this; yarn's do not. A dependency that already ran one
    only gets the note "runs an install script (as the old version did)".

  Treat "partial" as "the tests were the only real evidence". The overall
  headline says `safe (partial)` too, never a bare `safe`.

## risky

- Tests pass, **but** the changelog names something your code uses as breaking.
  Every risky verdict shows the changelog excerpt and the call site
  (`file:line` and the source line).
  - *high*: the symbol appears in a "Breaking"/"Removed" section or next to a
    BREAKING marker.
  - *medium*: it appears in a removed/renamed/deprecated note, or anywhere in
    a semver-major release.
  - Matching is by identifier, so common words (`option`, `parse`) can match
    an unrelated breaking note: false positives cost a minute of review, a
    missed break costs an incident, and ratchet prefers the former.
- With the [registry proxy](private-registries.md) on, the proxy refused
  requests that no normal install makes (a tunnel to an unlisted host, a
  package nobody declared, a write method). The overall verdict is then at
  least risky, and the report says `SUSPICIOUS install activity` with the
  counts. It can only see attempts made through the proxy.
- **unverified** (also reported as risky) — nothing ran against this bump:
  no `scripts.test`, no lockfile, the suite already fails on the old lockfile,
  or a *different* dependency reproduces the failure and this one was not
  tested on its own.

## broken

Tests fail (or hang and are killed at the timeout, or the install fails).
The verdict always carries proof:

- **bisected** — the exact first failing version, the last passing version and
  the failing output. Untestable versions inside that window are listed as
  possible culprits.
- **last known good** — for an exact, confirmed bisection the verdict also
  suggests the last version ratchet tested passing (with an `npm install
  name@x.y.z` pin for direct dependencies). Later versions are untested, not
  claimed broken. Omitted for narrowed, flaky, unconfirmed or unbisected results.
- **bisection bound reached** — the narrowed range
  (`last good < v <= still failing`) and the failing output, when
  `maxInstalls` ran out before one version was isolated.
- **flaky suite** — after the search, ratchet re-runs the reported first bad
  and last good version once each (counted against `maxInstalls`; two installs
  are reserved for it). If either flips, the verdict stays broken but says
  "flaky suite: result not reliable" and names no exact culprit. If the
  re-runs could not be judged or the budget had no room, the exact result is
  marked "not re-run to confirm".
- **not isolated** — the failure could not be pinned to one version (for
  example the registry was unreachable, or no single bump reproduces it); the
  failing output is still shown.

When one dependency in a multi-dependency bump is guilty, the other changed
packages are not blamed and not cleared: they are reported as unverified.
Failures that only appear when several bumps combine make every involved
dependency broken (not isolated), never safe.

## Overall

The overall verdict is the worst of the individual ones. The exit code follows
it: `broken` always exits 1; `risky` exits 1 only with `--fail-on risky`.
