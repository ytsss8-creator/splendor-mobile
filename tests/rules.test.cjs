'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, startGame, loadGame, plain, acquireCard, giveTokens, assertInvariants } = require('./helpers/game-harness.cjs');

test('classic two-player setup has 4/4/4/4/4/5 tokens, 12 market cards and 3 nobles', () => {
  const { api } = startGame();
  const state = api.getState();
  assert.deepEqual(plain(state.bank), { w: 4, u: 4, g: 4, r: 4, k: 4, y: 5 });
  assert.deepEqual([1, 2, 3].map(tier => state.market[tier].length), [4, 4, 4]);
  assert.deepEqual([1, 2, 3].map(tier => state.deck[tier].length), [36, 26, 16]);
  assert.equal(state.nobles.length, 3);
  assert.equal(state.turn, 0);
  assertInvariants(api, { settled: true });
});

for (const [name, pick, accepted] of [
  ['three distinct colors', ['w', 'u', 'g'], true],
  ['same color twice at four in bank', ['w', 'w'], true],
  ['only two distinct while five available', ['w', 'u'], false],
  ['only one while five available', ['w'], false],
  ['mixed duplicate', ['w', 'w', 'u'], false],
  ['gold mixed with colors', ['w', 'u', 'y'], false],
  ['unknown color', ['w', 'u', 'z'], false],
  ['four distinct', ['w', 'u', 'g', 'r'], false],
  ['empty selection', [], false],
]) {
  test(`token legality: ${name}`, () => {
    const { api } = startGame();
    const before = plain(api.getState());
    assert.equal(api.canTake(pick, 0), accepted);
    assert.equal(api.take(pick, 0), accepted);
    if (!accepted) assert.deepEqual(plain(api.getState()), before);
    assertInvariants(api, { settled: true });
  });
}

test('same-color take is rejected when only three remain', () => {
  const { api } = startGame();giveTokens(api, 1, { w: 1 });
  const before = plain(api.getState());
  assert.equal(api.take(['w', 'w'], 0), false);
  assert.deepEqual(plain(api.getState()), before);
  assertInvariants(api, { settled: true });
});

test('when only two colors remain the current game takes one of each', () => {
  const { api } = startGame();
  giveTokens(api, 0, { w: 4, u: 4 });giveTokens(api, 1, { g: 4 });
  assert.equal(api.canTake(['r', 'k'], 1), true);
  api.getState().turn = 1; // Prepare the actual actor; execution now validates turn ownership.
  assert.equal(api.take(['r', 'k'], 1), true);
  assertInvariants(api, { settled: true });
});

test('when only one color remains the current game takes one token', () => {
  const { api } = startGame();
  giveTokens(api, 0, { w: 4, u: 4 });giveTokens(api, 1, { g: 4, r: 4 });
  assert.equal(api.take(['k'], 0), true);
  assertInvariants(api, { settled: true });
});

test('P0 characterization: archived canTake and take incorrectly allow two gold tokens', () => {
  const { api } = startGame({ baseline: true });
  assert.equal(api.canTake(['y', 'y'], 0), true);
  assert.equal(api.take(['y', 'y'], 0), true);
  assert.equal(api.getState().bank.y, 3);
  assert.equal(api.getState().players[0].tokens.y, 2);
  assertInvariants(api, { settled: true });
});

test('direct taking of gold must be rejected without mutation', () => {
  const { api } = startGame();
  const before = plain(api.getState());
  assert.equal(api.canTake(['y', 'y'], 0), false);
  assert.equal(api.take(['y', 'y'], 0), false);
  assert.deepEqual(plain(api.getState()), before);
});

test('insufficient purchase is rejected and leaves resources and piles intact', () => {
  const { api } = startGame(), card = api.getState().market[3][0];
  const before = plain(api.getState());
  assert.equal(api.canBuy(card, api.getState().players[0]), false);
  assert.equal(api.pay(card, 0), false);
  assert.deepEqual(plain(api.getState()), before);
  assertInvariants(api, { settled: true });
});

test('purchase spends colored tokens first, uses gold for the shortage and returns both', () => {
  const { api } = startGame(), state = api.getState(), card = state.market[1][0];
  const missing = Object.keys(card.cost)[0], counts = { ...card.cost };
  counts[missing]--;giveTokens(api, 0, counts);giveTokens(api, 0, { y: 2 });
  const price = plain(api.price(card, state.players[0]));
  assert.equal(price.short, 1);assert.equal(price.left, 0);
  const bankBefore = plain(state.bank), tokensBefore = plain(state.players[0].tokens);
  assert.equal(api.pay(card, 0), true);
  const spent = state.replay.at(-1).action.spent;
  assert.equal(spent.y, 1);
  for (const color of api.ALL) {
    assert.equal(state.bank[color], bankBefore[color] + spent[color]);
    assert.equal(state.players[0].tokens[color], tokensBefore[color] - spent[color]);
  }
  assert.equal(state.players[0].tokens.y, 1);
  assert.equal(state.players[0].bonuses[card.color], 1);
  assert.equal(state.players[0].score, card.score);
  assertInvariants(api, { settled: true });
});

test('permanent discounts reduce price without becoming spendable tokens', () => {
  const { api } = startGame(), state = api.getState(), card = state.market[1][0];
  const color = Object.keys(card.cost)[0];
  acquireCard(api, 0, api.CARD_POOL.find(candidate => candidate.tier === 1 && candidate.color === color && candidate.score === 0 && candidate.id !== card.id).id);
  const price = api.price(card, state.players[0]);
  assert.equal(price.req[color], Math.max(0, card.cost[color] - 1));
  assert.equal(state.players[0].tokens[color], 0);
  assertInvariants(api, { settled: true });
});

test('sufficient discounts allow a free purchase and do not consume gold', () => {
  const { api } = startGame(), state = api.getState();
  for (const color of api.COLORS) {
    for (const card of api.CARD_POOL.filter(card => card.tier === 1 && card.color === color).slice(0, 5)) acquireCard(api, 0, card.id);
  }
  const card = state.market[1][0];giveTokens(api, 0, { y: 1 });
  const bankBefore = plain(state.bank);
  assert.equal(api.price(card, state.players[0]).left, 0);
  assert.equal(api.pay(card, 0), true);
  assert.deepEqual(plain(state.bank), bankBefore);
  assert.equal(state.players[0].tokens.y, 1);
  assertInvariants(api, { settled: true });
});

test('buying a market card reveals the previous deck top in the same slot', () => {
  const { api } = startGame(), state = api.getState(), card = state.market[1][1];
  giveTokens(api, 0, card.cost);
  const replacement = state.deck[1].at(-1).id, length = state.deck[1].length;
  assert.equal(api.pay(card, 0), true);
  assert.equal(state.market[1][1].id, replacement);
  assert.equal(state.deck[1].length, length - 1);
  assert.equal(state.market[1].length, 4);
  assertInvariants(api, { settled: true });
});

test('reserve locks one public card, replenishes the market and gains one gold', () => {
  const { api } = startGame(), state = api.getState(), card = state.market[2][1];
  const replacement = state.deck[2].at(-1).id;
  assert.equal(api.reserve(card, 0), true);
  assert.equal(state.players[0].reserved[0].id, card.id);
  assert.equal(state.market[2][1].id, replacement);
  assert.equal(state.players[0].tokens.y, 1);
  assert.equal(state.bank.y, 4);
  assertInvariants(api, { settled: true });
});

test('purchase from own reserve removes that reserve and does not replenish the market again', () => {
  const { api } = startGame(), state = api.getState(), card = state.market[1][0];
  api.reserve(card, 0);giveTokens(api, 0, card.cost);
  api.afterAction(0);api.botTurn(); // Reserved cards are bought on a subsequent turn.
  const marketBefore = plain(state.market), decksBefore = plain(state.deck);
  assert.equal(api.pay(card, 0), true);
  assert.equal(state.players[0].reserved.length, 0);
  assert.deepEqual(plain(state.market), marketBefore);
  assert.deepEqual(plain(state.deck), decksBefore);
  assertInvariants(api, { settled: true });
});

test('reserve remains legal without gold in the bank', () => {
  const { api } = startGame(), state = api.getState();giveTokens(api, 1, { y: 5 });
  assert.equal(api.reserve(state.market[1][0], 0), true);
  assert.equal(state.players[0].tokens.y, 0);
  assertInvariants(api, { settled: true });
});

test('fourth public or blind reservation is rejected without mutation', () => {
  const { api } = startGame(), state = api.getState();
  for (let i = 0; i < 3; i++) {
    assert.equal(api.reserve(state.market[1][0], 0), true);
    api.afterAction(0);api.botTurn();
  }
  const before = plain(state);
  assert.equal(api.reserve(state.market[2][0], 0), false);
  assert.equal(api.blindReserve(3, 0), false);
  assert.deepEqual(plain(state), before);
  assertInvariants(api, { settled: true });
});

test('blind reservation takes the actual deck top, marks it private and does not alter the market', () => {
  const { api } = startGame(), state = api.getState(), top = state.deck[3].at(-1).id;
  const marketBefore = plain(state.market);
  assert.equal(api.blindReserve(3, 0), true);
  assert.equal(state.players[0].reserved[0].id, top);
  assert.equal(state.players[0].reserved[0].blindReserved, true);
  assert.deepEqual(plain(state.market), marketBefore);
  assertInvariants(api, { settled: true });
});

test('AI auto-discard keeps at most 10 tokens, preserves gold preference and logs each return', () => {
  const { api } = startGame(), state = api.getState();
  giveTokens(api, 1, { w: 3, u: 3, g: 2, r: 2, k: 1, y: 1 });
  state.turn = 1;
  state.rulePhase = 'settle'; // A prepared post-action overflow, not a fresh turn.
  const before = state.replay.length;api.autoDiscard(1);
  assert.equal(api.ALL.reduce((sum, color) => sum + state.players[1].tokens[color], 0), 10);
  assert.equal(state.players[1].tokens.y, 1);
  assert.equal(state.replay.length - before, 2);
  assert.ok(state.replay.slice(before).every(event => event.action.type === 'discard'));
  assertInvariants(api, { settled: true });
});

for (const mode of ['ai', 'pvp']) {
  test(`${mode}: human token overflow waits for individual returns and then changes turn`, () => {
    const { api } = startGame({ mode }), state = api.getState();
    giveTokens(api, 0, { w: 4, u: 4, g: 2 });
    api.selectGem('r');api.selectGem('k');api.selectGem('g');api.playerTake();
    assert.equal(state.modal.type, 'discard');assert.equal(state.modal.need, 3);
    assert.equal(state.turn, 0);
    for (const color of ['r', 'k', 'g']) api.discardOne(color);
    assert.equal(state.turn, 1);assert.equal(state.modal, null);
    assertInvariants(api, { settled: true });
  });
}

test('noble requirements use permanent bonuses, never held tokens or gold', () => {
  const { api } = startGame();giveTokens(api, 0, { g: 4, r: 4, y: 2 });
  assert.deepEqual(plain(api.eligible(0)), []);
  assert.equal(api.gainNoble(0, 1), false);
  assertInvariants(api, { settled: true });
});

test('one eligible noble is granted automatically after an action', () => {
  const { api } = startGame({ mode: 'pvp' }), state = api.getState();
  for (const color of ['g', 'r']) for (const card of api.CARD_POOL.filter(card => card.tier === 1 && card.color === color).slice(0, 4)) acquireCard(api, 0, card.id);
  api.take(['w', 'u', 'g'], 0);api.afterAction(0);
  assert.deepEqual(plain(state.players[0].nobles.map(noble => noble.id)), [1]);
  assert.equal(state.players[0].score, 3);
  assert.equal(state.turn, 1);
  assertInvariants(api, { settled: true });
});

test('human multi-noble choice grants exactly the selected one this turn', () => {
  const { api } = loadGame({ saved: fixture('save-pvp-noble.json') }), state = api.getState();
  assert.deepEqual(plain(state.modal.options), [6, 10]);
  api.endModalChoice(10);
  assert.deepEqual(plain(state.players[0].nobles.map(noble => noble.id)), [10]);
  assert.equal(state.players[0].score, 3);
  assert.ok(state.nobles.some(noble => noble.id === 6));
  assertInvariants(api, { settled: true });
});

test('AI multi-noble behavior retains the original first-listed choice', () => {
  const { api } = loadGame({ saved: fixture('save-pvp-noble.json') }), state = api.getState();
  state.matchMode = 'ai';state.modal = null;state.turn = 1;
  [state.players[0], state.players[1]] = [state.players[1], state.players[0]];
  api.afterAction(1);
  assert.deepEqual(plain(state.players[1].nobles.map(noble => noble.id)), [6]);
  assertInvariants(api, { settled: true });
});

test('first player triggering 15 waits for the second player to complete the round', () => {
  const { api } = loadGame({ saved: fixture('save-pvp-final-response.json') }), state = api.getState();
  assert.equal(state.endTrigger, true);assert.equal(state.over, false);assert.equal(state.turn, 1);
  api.take(['r', 'k', 'u'], 1);api.afterAction(1);
  assert.equal(state.over, true);assert.equal(state.modal.winnerSide, 0);
  assertInvariants(api, { settled: true });
});

test('the final responder can overtake the player who triggered the end', () => {
  const { api } = startGame({ mode: 'pvp' }), state = api.getState();
  for (const id of ['3-02', '3-06', '3-10', '3-14']) acquireCard(api, 0, id);
  for (const id of ['3-04', '3-08', '3-12', '3-16']) acquireCard(api, 1, id);
  api.take(['w', 'u', 'g'], 0);api.afterAction(0);assert.equal(state.over, false);
  api.take(['r', 'k', 'u'], 1);api.afterAction(1);assert.equal(state.modal.winnerSide, 1);
  assert.equal(state.players[1].score, 20);
  assertInvariants(api, { settled: true });
});

test('second-player trigger ends the already completed round immediately', () => {
  const { api } = startGame({ mode: 'pvp' }), state = api.getState();
  for (const id of ['3-02', '3-06', '3-10', '3-14']) acquireCard(api, 1, id);
  state.turn = 1;api.take(['w', 'u', 'g'], 1);api.afterAction(1);
  assert.equal(state.over, true);assert.equal(state.modal.winnerSide, 1);
  assert.equal(state.round, 2);
  assertInvariants(api, { settled: true });
});

for (const extraCard of [false, true]) {
  test(`equal scores use ${extraCard ? 'fewer purchased cards' : 'a draw when card counts also match'}`, () => {
    const { api } = startGame({ mode: 'pvp' }), state = api.getState();
    for (const id of ['3-02', '3-06', '3-10', '3-14']) acquireCard(api, 0, id);
    for (const id of ['3-03', '3-07', '3-11', '3-15']) acquireCard(api, 1, id);
    if (extraCard) acquireCard(api, 0, '1-01');
    api.take(['w', 'u', 'g'], 0);api.afterAction(0);
    api.take(['r', 'k', 'u'], 1);api.afterAction(1);
    assert.equal(state.modal.winnerSide, extraCard ? 1 : -1);
    assertInvariants(api, { settled: true });
  });
}

test('a noble bringing score from 12 to 15 triggers the final-response round', () => {
  const { api } = startGame({ mode: 'pvp' }), state = api.getState();
  for (const id of ['3-02', '3-06', '3-10']) acquireCard(api, 0, id);
  for (const color of ['g', 'r']) for (const card of api.CARD_POOL.filter(card => card.tier === 1 && card.color === color).slice(0, 4)) acquireCard(api, 0, card.id);
  assert.equal(state.players[0].score, 12);
  api.take(['w', 'u', 'g'], 0);api.afterAction(0);
  assert.equal(state.players[0].score, 15);assert.equal(state.endTrigger, true);
  assert.equal(state.turn, 1);assert.equal(state.over, false);
  assertInvariants(api, { settled: true });
});

for (const mode of ['ai', 'pvp']) {
  test(`${mode}: player-facing reserve, blind reserve and purchase preserve turn and resources`, () => {
    const { api } = startGame({ mode }), state = api.getState();
    const card = state.market[1][0];api.selectCard(card.id);api.playerReserve();
    assert.equal(state.turn, 1);assert.equal(state.players[0].reserved[0].id, card.id);
    if (mode === 'ai') api.botTurn();else api.playerBlind(2);
    assert.equal(state.turn, 0);
    giveTokens(api, 0, card.cost);api.selectCard(card.id);api.playerBuy();
    assert.equal(state.players[0].reserved.length, 0);
    assert.ok(state.players[0].cards.some(candidate => candidate.id === card.id));
    assert.equal(state.turn, 1);
    assertInvariants(api, { settled: true });
  });
}
