'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadGame, startGame, plain, assertInvariants } = require('./helpers/game-harness.cjs');
const legacyFields = state => {
  const result = plain(state);
  for (const key of ['rulePhase', 'aiDifficulty', 'aiVersion']) delete result[key];
  return result;
};

const saveNames = ['save-ai-initial.json', 'save-ai-pending.json', 'save-ai-midgame.json',
  'save-pvp-discard.json', 'save-pvp-noble.json', 'save-pvp-midgame.json',
  'save-pvp-final-response.json', 'save-pvp-ended.json'];

for (const name of saveNames) {
  test(`existing save loads without losing state: ${name}`, () => {
    const saved = fixture(name);
    assert.equal('aiDifficulty' in saved, false, 'Fixture must predate difficulty fields');
    const { api, effects } = loadGame({ saved });
    assert.deepEqual(legacyFields(api.getState()), saved);
    assert.equal(effects.landings, 0, 'Must not start a new game');
    assertInvariants(api, { settled: saved.modal?.type !== 'discard' });
  });
}

test('pre-replay save migration keeps rules state and initializes only absent metadata', () => {
  const saved = fixture('save-ai-pre-replay.json');
  const { api } = loadGame({ saved });
  const current = plain(api.getState());
  for (const key of ['setup', 'deck', 'market', 'bank', 'players', 'turn', 'round', 'history', 'botRng', 'endTrigger', 'over']) {
    assert.deepEqual(current[key], saved[key], key);
  }
  assert.equal(current.matchMode, 'ai');
  assert.deepEqual(current.playerNames, ['你', 'AI']);
  assert.equal(current.turnNote, '');
  assert.equal(current.replay.length, 1);
  assert.equal(current.replay[0].action.type, 'migrated');
  assertInvariants(api, { settled: true });
});

test('pending AI save schedules, then executes the same next legacy decision', () => {
  const saved = fixture('save-ai-pending.json');
  const { api, effects } = loadGame({ saved });
  const timers = [...effects.timers.values()];
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 540);
  timers[0].callback();
  assert.deepEqual(legacyFields(api.getState()), fixture('save-ai-midgame.json'));
});

test('PvP pending save never schedules an AI action', () => {
  const { effects } = loadGame({ saved: fixture('save-pvp-midgame.json') });
  assert.equal(effects.timers.size, 0);
});

test('restored discard dialog returns one token at a time and continues the same game', () => {
  const { api } = loadGame({ saved: fixture('save-pvp-discard.json') });
  const state = api.getState();
  assert.equal(state.modal.type, 'discard');
  const need = state.modal.need;
  for (let i = 0; i < need; i++) {
    api.discardOne(api.ALL.find(color => state.players[0].tokens[color] > 0));
    if (i < need - 1) assert.equal(state.modal.need, need - i - 1);
    assertInvariants(api);
  }
  assert.equal(state.modal, null);
  assert.equal(state.turn, 1);
  assertInvariants(api, { settled: true });
});

test('restored multi-noble dialog preserves the player choice and claims only one', () => {
  const { api } = loadGame({ saved: fixture('save-pvp-noble.json') });
  const state = api.getState(), choice = state.modal.options.at(-1);
  api.endModalChoice(choice);
  assert.equal(state.players[0].nobles.length, 1);
  assert.equal(state.players[0].nobles[0].id, choice);
  assert.equal(state.turn, 1);
  assert.equal(state.modal, null);
  assertInvariants(api, { settled: true });
});

test('full setup restore uses the same market slots, remaining decks, nobles and bot seed', () => {
  const { api } = startGame();
  const state = api.getState(), initial = fixture('save-ai-initial.json');
  for (const key of ['setup', 'deck', 'market', 'nobles', 'botRng']) assert.deepEqual(plain(state[key]), initial[key], key);
  api.take(['w', 'u', 'g'], 0);api.afterAction(0);api.botTurn();
  api.newGame('replay');
  for (const key of ['setup', 'deck', 'market', 'nobles', 'botRng']) assert.deepEqual(plain(api.getState()[key]), initial[key], key);
});

test('old board-seed and board-export formats validate without changing the fingerprint', () => {
  const { api } = loadGame();
  const seed = fixture('board-seed-v1.json');
  assert.deepEqual(plain(api.validateBoardSetup(seed)), seed.setup);
  assert.deepEqual(plain(api.validateBoardSetup(fixture('board-export-v1.json'))), seed.setup);
});

for (const [name, mutate] of [
  ['duplicate development card', setup => { setup.tiers[1][0] = setup.tiers[1][1]; }],
  ['wrong noble count', setup => { setup.nobleIds.pop(); }],
  ['wrong fingerprint', setup => { setup.boardId = '00000000'; }],
  ['missing bot seed', setup => { delete setup.botSeed; }],
]) {
  test(`invalid board is rejected: ${name}`, () => {
    const { api } = loadGame(), setup = fixture('board-seed-v1.json').setup;
    mutate(setup);
    assert.throws(() => api.validateBoardSetup(setup));
  });
}

test('board download still exports the complete original board-seed-v1 format', async () => {
  const { api, effects } = startGame();api.downloadBoardSetup();
  assert.deepEqual(JSON.parse(await effects.downloads.at(-1).text()), fixture('board-export-v1.json'));
});

test('JSON review export matches the fixed review-v2 sample without exporting future piles', async () => {
  const { api, effects } = loadGame({ saved: fixture('save-ai-midgame.json') });api.exportReplay();
  const review = JSON.parse(await effects.downloads.at(-1).text());
  assert.deepEqual(review, fixture('replay-review-v2.json'));
  assert.equal(review.format, 'splendor-coach-review-v2');
  for (const key of ['deck', 'setup', 'botRng']) assert.equal(key in review, false, key);
  assert.equal('deck' in review.currentPublicBoard, false);
  assert.equal('tiers' in review.currentPublicBoard, false);
});

test('original save key and board-history key remain unchanged', () => {
  const { api, storage } = startGame();api.save();
  assert.deepEqual(JSON.parse(storage.get('splendor_classic_v4')), plain(api.getState()));
  const history = JSON.parse(storage.get('splendor_plus_board_history_v1'));
  assert.equal(history[0].setup.boardId, fixture('board-seed-v1.json').setup.boardId);
  assert.deepEqual([...storage.keys()].sort(), ['splendor_classic_v4', 'splendor_plus_animation', 'splendor_plus_board_history_v1']);
});

test('P0 characterization: human blind-reserve event contains a private card, snapshot hides it', () => {
  const { api } = startGame();api.blindReserve(1, 0);
  const event = api.getState().replay.at(-1);
  assert.ok(event.action.card.id, 'Known legacy privacy boundary: do not expose replay to AI');
  assert.deepEqual(plain(event.publicBoardAfter.players[0].reservedCards), [{ tier: 1, faceDown: true }]);
});
