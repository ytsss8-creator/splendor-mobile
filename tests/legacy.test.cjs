'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, expandDecisionInput, loadGame, startGame, plain, assertInvariants } = require('./helpers/game-harness.cjs');

const corpus = fixture('legacy-decisions-v1.json');

function runDecision(baseline, input) {
  const { api } = loadGame({ baseline });
  api.setState(expandDecisionInput(input));
  const before = api.getState().replay.length;
  api.botTurn();
  const state = api.getState();
  return plain({
    rng: state.botRng,
    events: state.replay.slice(before).map(event => ({ actor: event.actor, action: event.action })),
    bank: state.bank, player: state.players[1], turn: state.turn, round: state.round,
    endTrigger: state.endTrigger, over: state.over,
  });
}

for (const sample of corpus.cases) {
  test(`legacy-v1 decision: ${sample.name}`, () => {
    // Golden results were generated once from the archived original. Running
    // both copies also detects accidental changes to the test adapter.
    assert.deepEqual(runDecision(true, sample.input), sample.expected, 'Frozen original must match golden result');
    assert.deepEqual(runDecision(false, sample.input), sample.expected, 'Production simple AI must match legacy-v1');
    if (!sample.name.startsWith('synthetic')) {
      const { api } = loadGame();api.setState(expandDecisionInput(sample.input));
      assertInvariants(api, { settled: true });
      api.botTurn();assertInvariants(api, { settled: true });
    }
  });
}

test('same state and RNG produce the same action, settlement and next RNG', () => {
  for (const sample of corpus.cases.slice(0, 20)) {
    assert.deepEqual(runDecision(false, sample.input), runDecision(false, sample.input));
  }
});

test('primary decision ignores actual future deck order and full setup order', () => {
  for (const sample of corpus.cases.filter(sample => !sample.name.startsWith('synthetic')).slice(0, 40)) {
    const changed = plain(sample.input);
    for (const tier of [1, 2, 3]) {
      changed.deck[tier].reverse();
      changed.setup.tiers[tier].reverse();
    }
    changed.setup.boardId = 'HIDDEN-ORDER-MUST-NOT-SEED-AI';
    changed.replay = [{ action: { type: 'secret', card: { id: '3-20' } } }];
    const first = runDecision(false, sample.input);
    const second = runDecision(false, changed);
    // Revealed replacements and post-reservation discard choices can legally
    // change after execution. Compare only the decision made before revelation.
    const primary = result => result.events.find(event => ['buy', 'take', 'reserve', 'blind_reserve'].includes(event.action.type));
    assert.deepEqual(primary(first), primary(second), sample.name);
    assert.equal(first.rng, second.rng, sample.name);
  }
});

test('primary decision cannot distinguish an opponent blind reserve from another hidden card', () => {
  const input = fixture('save-pvp-midgame.json');
  input.matchMode = 'ai';input.turn = 1;
  const changed = plain(input), hidden = changed.players[0].reserved[0];
  assert.equal(hidden.blindReserved, true);
  const replacement = changed.deck[hidden.tier].pop();
  replacement.blindReserved = true;
  changed.players[0].reserved[0] = replacement;
  delete hidden.blindReserved;
  changed.deck[hidden.tier].push(hidden);
  changed.replay = [{ action: { type: 'blind_reserve', card: replacement } }];
  const primary = result => result.events.find(event => ['buy', 'take', 'reserve'].includes(event.action.type));
  const first = runDecision(false, input), second = runDecision(false, changed);
  assert.deepEqual(primary(first), primary(second));
  assert.equal(first.rng, second.rng);
});

for (const [name, patch] of [
  ['human turn', { turn: 0 }],
  ['PvP mode', { matchMode: 'pvp' }],
  ['finished game', { over: true }],
  ['pending modal', { modal: { type: 'setup' } }],
]) {
  test(`legacy-v1 does not act during ${name}`, () => {
    const { api } = startGame();
    api.getState().turn = 1;
    Object.assign(api.getState(), patch);
    const before = plain(api.getState());
    api.botTurn();
    assert.deepEqual(plain(api.getState()), before);
  });
}
