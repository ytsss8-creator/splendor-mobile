# P0 frozen legacy-v1 baseline

`legacy-v1.html` is the exact original `index.html` from commit `34468c5`.
`manifest.json` records its SHA-256, the strategy ID `legacy-v1`, all fixture
digests, the decision-case count, and known defects. Do not update the archive or
golden expected results to make a production change pass.

The production page remains unchanged in P0. This archive is the executable
reference for the later simple-difficulty adapter, including the original
candidate ordering, LCG random consumption, duplicate-color demand calculation,
auto-discard preference and first-listed noble selection. It is not a new AI.

## Running tests

Use Node.js 22 or newer. No package installation or network is required.

```sh
npm test
npm run test:legacy
npm run test:rules
npm run test:compat
```

The commands register native `node:test` cases in a single process to expose
individual TAP counts without subprocess IPC. Each game runs in a fresh VM.
The test adapter substitutes rendering, animation capture, in-memory browser
storage, downloads, clocks and timers; it runs the original rule, save/load,
logging and AI functions. Timers run only when a test explicitly invokes them.
It does not provide a production debug API or write a real browser's save.

## Frozen fixtures

`tests/fixtures/classic-data-v1.json` freezes all original rows, generated card
IDs/costs, and noble identities/requirements. It is a compatibility snapshot,
not a claim of a completed external audit of all card costs.

`board-seed-v1.json` fixes a full 40/30/20 order, nobles 1/6/10, the independent
AI seed and board fingerprint `1C327E6D`. `board-export-v1.json` captures the old
download format. Arrays retain their original orientation: drawing uses `pop()`.

The save fixtures cover initial, pending AI, AI midgame, pre-replay migration,
PvP midgame with a blind reserve, pending individual discard, pending noble
choice, final response and completed game. They intentionally have no AI
difficulty field. They are deterministic test games, not user saves.

`replay-review-v2.json` freezes the exported review format and events for the
AI midgame fixture. Export time is fixed only in the VM.

`legacy-decisions-v1.json` stores 155 fixed decisions: 144 decisions from 12
seeded game sequences and 11 focused boundary cases. Card/noble references in
inputs expand from the frozen data; irrelevant prior history is omitted.
Expected results are captured once from the archived original, including
primary actions, return/noble events, next RNG, resources, own holdings and
turn/terminal fields. Tests compare both archived and production code against
these independent expected results. All 150 non-synthetic cases also check
resource, card, score, bonus and noble invariants before and after the decision.

Five cases prefixed `synthetic-` intentionally exercise otherwise inaccessible
fallbacks using impossible pile/resource arrangements. They test frozen policy
branches, not legal gameplay, and are excluded from invariant checks. Separate
metamorphic tests perturb actual unseen deck order, setup fingerprint, private
opponent reserve and replay secrets while checking the primary action and RNG.

## Known defects and limits

- Gold take: archived `canTake(['y','y'])` succeeds. One characterization test
  preserves this observation; one executable TODO asserts the required P1
  rejection. P0 must therefore report a TODO, not claim all rules are fixed.
  Remove that TODO when P1 fixes production; the archive stays unchanged.
- Human blind-reserve replay events contain the private card in AI mode.
  Public snapshots hide it. Future AI observation must never accept full replay.
- The duplicate-color demand calculation and original settlement preferences
  remain frozen to preserve simple AI behavior; P0 does not tune them.
- Tests cover JavaScript behavior through the isolated adapter. They do not
  emulate actual DOM rendering, flight animations, Safari timing or layout.

P1 will introduce the rule engine, observation boundary and disabled difficulty
placeholders. The harness must then load production through its new structure;
the archived original and golden fixtures must remain untouched.
