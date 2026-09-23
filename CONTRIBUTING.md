# Contributing

Thanks for helping. The short version:

1. Look at the [`help wanted`](https://github.com/FelixMiddelhoff/ratchet-verify/labels/help%20wanted)
   and [`good first issue`](https://github.com/FelixMiddelhoff/ratchet-verify/labels/good%20first%20issue)
   issues, or the list in the README's [Help wanted](README.md#help-wanted) section.
   Comment on the issue you pick up.
2. `npm ci`, then `npm run lint && npm test` (fast, offline). `npm run build && npm run corpus`
   runs the real-install corpus and needs network.
3. Add tests: a positive case, a "nothing to report" case and the edge case you care about.
   Detection changes also need a *non-match* test.
4. Keep the code readable (small functions, intention-revealing names, comments that say why) and
   update the docs in `docs/` in the same pull request. Only show output you actually ran.
5. Open a pull request describing the change and how you verified it.

The one non-negotiable rule: **a "safe" verdict must never be wrong.** A change that reports fewer
risks to reduce noise must show it does not turn a real break into an all-clear.

Bugs and false verdicts: please use the issue templates. A false "safe" is the most valuable report
you can send.
