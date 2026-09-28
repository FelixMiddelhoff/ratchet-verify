# Python quickstart

`ratchet-python` verifies a Python dependency bump the same way the npm core
verifies a JavaScript one. This is the two-minute version: bump a dependency
in a tiny project, run `ratchet-python`, see the verdict. Every command and
output below was actually run. For the full CLI reference, config file and
GitHub Action, see [python-module.md](python-module.md).

You need Node.js 24+, Python 3, git, and pip (or `uv`/`poetry`, if your
project uses one of those instead — see [Requirements](python-module.md#requirements)).

## Two-minute demo

Build a tiny project pinned to `six` 1.16.0, with a test that imports it:

```
mkdir demo && cd demo
git init -b main
```

`app.py`:

```python
import six

def to_text(x):
    return six.text_type(x)
```

`test_app.py`:

```python
from app import to_text

if to_text(5) != "5":
    raise SystemExit("to_text(5) did not return '5'")
print("ok")
```

`requirements.txt` — hash-pinned, the format `ratchet-python` supports (see
[Known limitations](python-module.md#known-limitations); a plain unpinned
`requirements.txt` has no single dependency graph to diff). Get the hash with
`pip download <pkg>==<version> --no-deps -d dl && python3 -c "import
hashlib;print(hashlib.sha256(open('dl/<file>','rb').read()).hexdigest())"`:

```
six==1.16.0 --hash=sha256:8abb2f1d86890a2dfb989f9a77cfcfd3e47c2a354b01111771326f8aa26e0254
```

Commit the "before" state, then apply the bump (regenerate the hash for
1.17.0 the same way and edit `requirements.txt` in place):

```
git add .
git commit -m "before the bump"
```

```
six==1.17.0 --hash=sha256:4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274
```

```
git add .
git commit -m "bump six to 1.17.0"
```

Now ask `ratchet-python` (built from a checkout here; via npm it's
`npx --package ratchet-verify@latest ratchet-python ...`, see
[Installing it](python-module.md#installing-it)):

```
node dist-python/python-module/cli.js --project ./demo --base HEAD~1 \
  --lockfile-name requirements.txt --test python3 test_app.py
```

Real output:

```
ratchet: overall safe

six (1.16.0 -> 1.17.0): SAFE — tests pass; verdict is partial: no changelog was found; this is a tests-only verdict
  caveat: no changelog was found; this is a tests-only verdict
  note: No notes found for 1.17.0
```

`--test` takes over the rest of the command line (it must come last), so
`--format json` has to come before it if you want machine-readable output:

```
node dist-python/python-module/cli.js --project ./demo --base HEAD~1 \
  --lockfile-name requirements.txt --format json --test python3 test_app.py
```

```json
{
  "schemaVersion": 1,
  "overall": "safe",
  "verdicts": [
    {
      "name": "six",
      "oldVersion": "1.16.0",
      "newVersion": "1.17.0",
      "caveats": [
        "no changelog was found; this is a tests-only verdict"
      ],
      "notes": [
        "No notes found for 1.17.0"
      ],
      "status": "safe",
      "confidence": "reduced",
      "summary": "tests pass; verdict is partial: no changelog was found; this is a tests-only verdict",
      "evidence": []
    }
  ]
}
```

This particular bump has no PyPI/GitHub release notes for `six` 1.17.0, so
the verdict is "safe (partial)" — tests-only, not a full breaking-change
check. A project using `uv.lock` or `poetry.lock` against a package that does
publish notes gets the same `RISKY`/`BROKEN` shape (with changelog excerpts
and `file:line` hits, or a bisected version) shown for the npm core in
[tutorial.md](tutorial.md) — the verdict model is identical, only the
lockfile format and package index differ.

## Where next

- [python-module.md](python-module.md): full CLI reference, config file
  (`.ratchetrc.python`), GitHub Action, output format, known limitations
- [../README.md](../README.md): the npm core and the shared verdict model
- [verdicts.md](verdicts.md): what each verdict and caveat means (npm core
  docs; the Python module reuses the same three verdicts)
