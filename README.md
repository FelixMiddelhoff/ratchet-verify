# ratchet

Don't just bump the version — prove it still works.

ratchet verifies a dependency bump: it runs your real test suite, checks the
changelog's breaking changes against how you actually use the package, and
bisects to the exact version that broke things.
