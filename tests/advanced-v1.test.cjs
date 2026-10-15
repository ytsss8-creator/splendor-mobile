'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Advanced, makeState, policy, ALL, COLORS, cardById } = require('./helpers/ai-v1-harness.cjs');

function choose(options) { return policy(makeState(options)); }

test('V1 takes an immediately scoring card over an available zero-point investment', () => {
  const { decision } = choose({ market: { 1: ['1-07', '1-08'] }, tokens: [{ u: 4, g: 3 }, {}] });
  assert.deepEqual(decision.action, { type: 'buy', cardId: '1-08' });
});

test('V1 invests in a zero-point card when its permanent discount improves a visible scoring target', () => {
  const state = makeState({ market: { 1: ['1-07', '1-32'] }, tokens: [{ g: 3 }, {}],
    bank: { w: 0, u: 0, g: 1, r: 0, k: 3, y: 0 } });
  const { decision, rules } = policy(state);
  assert.deepEqual(decision.action, { type: 'buy', cardId: '1-07' });
  const target = state.market[1].find(card => card.id === '1-32');
  const before = rules.price(target, state.players[state.turn]);
  const result = rules.simulate(state, decision.action, decision.settlementChoices);
  assert.equal(result.ok, true);
  const after = rules.price(target, result.state.players[state.turn]);
  assert.equal(before.req.k, 4);
  assert.equal(after.req.k, 3);
});

test('V1 reserves a target for gold when the missing color cannot be taken from the bank', () => {
  const state = makeState({ market: { 1: ['1-08'] }, tokens: [{ u: 3 }, {}],
    bank: { w: 4, u: 0, g: 4, r: 4, k: 4, y: 1 } });
  const { decision } = policy(state);
  assert.deepEqual(decision.action, { type: 'reserve', cardId: '1-08' });
  assert.deepEqual(decision.diagnostics.route, ['1-08']);
});

test('purchase-time estimator does not invent a key color with an empty bank', () => {
  const state = makeState({ market: { 1: ['1-08'] }, bank: { w: 4, u: 0, g: 4, r: 4, k: 4, y: 0 } });
  const { rules, observation } = policy(state), shadow = Advanced._internals.shadowState(observation);
  const target = shadow.market[1][0], known = new Set([target.id]);
  assert.equal(Advanced._internals.acquisitionPlan(shadow, target, rules, state.turn, known, observation, 64), null);
});

test('V1 protects the only public card that would let the opponent overtake after a 15-point trigger', () => {
  const state = makeState({ turn: 0, scores: [14, 14], market: { 1: ['1-16'], 2: ['2-05'] },
    tokens: [{ r: 4 }, { w: 5 }], bank: { w: 0, u: 4, g: 4, r: 0, k: 4, y: 5 }, nobles: [] });
  const { decision } = policy(state);
  assert.deepEqual(decision.action, { type: 'reserve', cardId: '2-05' });
});

test('V1 discard choice is legal under the ten-token cap and keeps universal gold when possible', () => {
  const state = makeState({ tokens: [{ w: 2, u: 2, g: 2, r: 2, k: 1, y: 2 }, {}] });
  const { rules } = policy(state), observation = rules.observe(state, state.turn);
  const discards = Advanced.discardColors(observation, rules), scratch = rules.copyState(state);
  scratch.rulePhase = 'discard';
  assert.equal(discards.length, 1);
  assert.equal(rules.validateAction(scratch, { type: 'discard', color: discards[0] }, state.turn).ok, true);
  assert.equal(rules.executeAction(scratch, { type: 'discard', color: discards[0] }, state.turn).ok, true);
  assert.equal(ALL.reduce((sum, color) => sum + scratch.players[state.turn].tokens[color], 0), 10);
});

test('V1 selects one eligible noble in simulated settlement without bypassing the core', () => {
  const state = makeState({ market: { 1: ['1-07'] }, tokens: [{ g: 3 }, {}], nobles: [] });
  state.nobles = [{ id: 1, name: 'A', req: { k: 1 } }, { id: 2, name: 'B', req: { k: 1 } }];
  const { rules, decision } = policy(state);
  assert.deepEqual(decision.action, { type: 'buy', cardId: '1-07' });
  assert.ok([1, 2].includes(decision.settlementChoices.nobleId));
  const result = rules.simulate(state, decision.action, decision.settlementChoices);
  assert.equal(result.ok, true);assert.equal(result.pending, null);
  assert.equal(result.state.players[state.turn].nobles.length, 1);
  assert.equal(result.state.players[state.turn].score, 3);
});

test('V1 public-market purchase uses the actual core refill and payment settlement', () => {
  const state = makeState({ market: { 1: ['1-08'] }, tokens: [{ u: 4 }, {}] });
  const { rules, decision } = policy(state);
  assert.deepEqual(decision.action, { type: 'buy', cardId: '1-08' });
  const replacement = state.deck[1].at(-1), beforeBank = { ...state.bank };
  const result = rules.simulate(state, decision.action, decision.settlementChoices);
  assert.equal(result.ok, true);assert.equal(result.state.market[1][0].id, replacement.id);
  assert.equal(result.state.players[state.turn].cards.at(-1).id, '1-08');
  assert.equal(result.state.players[state.turn].score, 1);
  assert.equal(result.state.players[state.turn].bonuses.k, 1);
  assert.equal(result.state.bank.u, beforeBank.u + 4);
});

test('same visible position and RNG reproduce a legal move without reading hidden deck order or mutating state', () => {
  const state = makeState(), rules = require('../js/rules.js').create(require('./helpers/ai-v1-harness.cjs').data.cards);
  const observation = rules.observe(state, state.turn), before = JSON.stringify(state);
  const first = Advanced.decide(observation, rules, 0x12345678);
  const changed = require('./helpers/game-harness.cjs').plain(state);
  for (const tier of [1, 2, 3]) changed.deck[tier].reverse();
  const second = Advanced.decide(rules.observe(changed, changed.turn), rules, 0x12345678);
  assert.deepEqual(second.action, first.action);
  assert.deepEqual(second.settlementChoices, first.settlementChoices);
  assert.equal(second.nextRng, first.nextRng);
  assert.equal(JSON.stringify(state), before);
  assert.equal(rules.validateAction(state, first.action, state.turn).ok, true);
  const result = rules.simulate(state, first.action, first.settlementChoices);
  assert.equal(result.ok, true);assert.equal(result.pending, null);
  assert.equal(JSON.stringify(state), before);
});
