# splendor-mobile
Splendor browser game

The game runs directly from the standalone `index.html`, including on GitHub
Pages. Rules and the frozen `legacy-v1` AI are maintained in `js/` and embedded
in the HTML; no backend or external runtime scripts are required.

With Node.js 22 or newer, run `npm test` (no installation required).
See [the frozen legacy-v1 baseline](tests/baseline/README.md) for fixtures,
focused test commands and the historical P0 baseline.

See [P1 architecture and test instructions](docs/P1-implementation.md) for the
shared rules, observation boundary, compatible saves and browser regression.
After changing `js/`, run `npm run sync:inline` before `npm test`.
Only simple difficulty is enabled; normal and hard remain disabled placeholders.
