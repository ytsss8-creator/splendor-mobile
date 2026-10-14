'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { create } = require('../js/rules.js');
const legacy = require('../js/legacy-v1.js');
const { fixture, expandDecisionInput, startGame, loadGame, plain } = require('./helpers/game-harness.cjs');
const rules = create(fixture('classic-data-v1.json').cards);
const primary = events => events.find(event => ['take', 'buy', 'reserve', 'blind_reserve'].includes(event.action.type))?.action;
const command = event => !event ? null : event.type === 'take' ? { type: 'take', colors: event.colors }
  : event.type === 'blind_reserve' ? { type: 'blind_reserve', tier: event.tier } : { type: event.type, cardId: event.card.id };

for (const sample of fixture('legacy-decisions-v1.json').cases) {
  test(`isolated legacy-v1 policy preserves frozen decision: ${sample.name}`, () => {
    const state = expandDecisionInput(sample.input), observation = rules.observe(state, 1), before = plain(observation);
    const decision = legacy.decide(observation, state.botRng);
    assert.equal(decision.strategyId, 'legacy-v1');
    assert.deepEqual(decision.action, command(primary(sample.expected.events)));
    assert.equal(decision.nextRng, sample.expected.rng);
    assert.deepEqual(observation, before, 'Policy must not mutate observation');
  });
  if (!sample.name.startsWith('synthetic')) {
    test(`pure simulation matches original complete turn: ${sample.name}`, () => {
      const state = expandDecisionInput(sample.input), before = plain(state), expected = sample.expected.events;
      const simulated = rules.simulate(state, command(primary(expected)), {
        discardColors: expected.filter(event => event.action.type === 'discard').map(event => event.action.color),
        nobleId: expected.find(event => event.action.type === 'noble')?.action.id,
      });
      assert.equal(simulated.ok, true);assert.equal(simulated.pending, null);
      assert.deepEqual(state, before, 'Simulation must not mutate the supplied state');
      const original = loadGame({ baseline: true });original.api.setState(plain(state));original.api.botTurn();
      for (const key of ['bank', 'market', 'deck', 'players', 'nobles', 'turn', 'round', 'over', 'endTrigger']) {
        assert.deepEqual(simulated.state[key], plain(original.api.getState()[key]), key);
      }
    });
  }
}

for (const [name, action, who, modify] of [
  ['two gold', { type: 'take', colors: ['y', 'y'] }, 0],
  ['mixed gold', { type: 'take', colors: ['w', 'u', 'y'] }, 0],
  ['single gold', { type: 'take', colors: ['y'] }, 0],
  ['three gold', { type: 'take', colors: ['y', 'y', 'y'] }, 0],
  ['unknown color', { type: 'take', colors: ['w', 'u', 'unknown'] }, 0],
  ['malformed colors', { type: 'take', colors: 'wug' }, 0],
  ['missing colors', { type: 'take' }, 0],
  ['sparse colors', { type: 'take', colors: ['w', 'u', ,] }, 0],
  ['wrong actor', { type: 'take', colors: ['w', 'u', 'g'] }, 1],
  ['invalid actor', { type: 'take', colors: ['w', 'u', 'g'] }, 2],
  ['finished game', { type: 'take', colors: ['w', 'u', 'g'] }, 0, state => { state.over = true; }],
  ['second primary action', { type: 'take', colors: ['w', 'u', 'g'] }, 0, state => { state.rulePhase = 'settle'; }],
  ['non-rule modal', { type: 'take', colors: ['w', 'u', 'g'] }, 0, state => { state.modal = { type: 'setup' }; }],
  ['fabricated card', { type: 'buy', cardId: 'fake' }, 0],
  ['missing card id', { type: 'buy' }, 0],
  ['unknown reserve', { type: 'reserve', cardId: 'fake' }, 0],
  ['unknown tier', { type: 'blind_reserve', tier: 4 }, 0],
  ['string tier', { type: 'blind_reserve', tier: '1' }, 0],
  ['discard in primary phase', { type: 'discard', color: 'w' }, 0],
  ['noble in primary phase', { type: 'noble', id: 1 }, 0],
  ['pass is not a legal action', { type: 'pass' }, 0],
  ['null action', null, 0],
]) {
  test(`core rejection is atomic: ${name}`, () => {
    const { api, effects } = startGame();const state = api.getState();modify?.(state);
    const before = plain(state), effectsBefore = { writes: effects.writes.length, renders: effects.renders };
    const result = rules.executeAction(state, action, who);
    assert.equal(result.ok, false);assert.deepEqual(result.events, []);
    assert.deepEqual(plain(state), before);
    assert.equal(effects.writes.length, effectsBefore.writes);assert.equal(effects.renders, effectsBefore.renders);
  });
}

test('legal action enumeration covers takes, buys, both reserves and settlement choices', () => {
  const state = fixture('save-ai-initial.json');
  const actions = rules.legalActions(state);
  assert.equal(actions.filter(action => action.type === 'take').length, 15);
  assert.equal(actions.filter(action => action.type === 'reserve').length, 12);
  assert.equal(actions.filter(action => action.type === 'blind_reserve').length, 3);
  assert.ok(actions.every(action => rules.validateAction(state, action).ok));
  assert.ok(actions.every(action => !action.colors?.includes('y')));
  assert.equal(rules.legalActions(state, 1).length, 0);
  const discard = fixture('save-pvp-discard.json');
  assert.ok(rules.legalActions(discard).every(action => action.type === 'discard'));
  const noble = fixture('save-pvp-noble.json');
  assert.deepEqual(rules.legalActions(noble), [{ type: 'noble', id: 6 }, { type: 'noble', id: 10 }]);
});

test('core uses the canonical available card and rejects corrupted card definitions', () => {
  const state = fixture('save-ai-initial.json'), card = state.market[1][0];
  card.cost = {};
  const before = plain(state);
  assert.equal(rules.executeAction(state, { type: 'buy', cardId: card.id }).ok, false);
  assert.deepEqual(state, before);
});

test('core cannot buy or reserve the opponent private or public reserve', () => {
  const state = fixture('save-pvp-midgame.json'), opponent = state.players[1].reserved[0];
  for (const type of ['buy', 'reserve']) {
    const before = plain(state);
    assert.equal(rules.executeAction(state, { type, cardId: opponent.id }).ok, false);
    assert.deepEqual(state, before);
  }
});

test('settlement cannot claim a second noble or advance a turn twice', () => {
  const state = fixture('save-pvp-noble.json');
  assert.equal(rules.executeAction(state, { type: 'noble', id: 10 }).ok, true);
  assert.equal(rules.executeAction(state, { type: 'noble', id: 6 }).ok, false, 'A stale choice modal cannot grant a second noble');
  state.modal = null;
  assert.equal(rules.executeAction(state, { type: 'noble', id: 6 }).ok, false);
  assert.equal(rules.advanceTurn(state, 0).ok, true);
  const before = plain(state);
  assert.equal(rules.advanceTurn(state, 0).ok, false);assert.deepEqual(state, before);
});

test('settlement cannot finish a fresh turn before a primary action', () => {
  const state = fixture('save-ai-initial.json'), before = plain(state);
  assert.deepEqual(rules.prepareSettlement(state), { type: 'invalid' });
  assert.equal(rules.advanceTurn(state).ok, false);
  assert.deepEqual(state, before);
});

test('observation hides opponent secrets, keeps own blind reserve, and does not alias state', () => {
  const state = fixture('save-pvp-midgame.json'), before = plain(state), observation = rules.observe(state, 1);
  assert.deepEqual(observation.players[0].reserved, [{ tier: 1, faceDown: true }]);
  for (const key of ['deck', 'setup', 'history', 'replay', 'botRng', 'boardId', 'modal', 'playerNames']) assert.equal(key in observation, false);
  const ownObservation = rules.observe(state, 0);
  assert.equal(ownObservation.players[0].reserved[0].id, state.players[0].reserved[0].id);
  observation.market[1][0].cost.w = 100;observation.bank.w = 100;observation.players[1].tokens.y = 100;
  assert.deepEqual(state, before);
});

test('observation never reads hidden pile entries, opponent blind card face or replay', () => {
  const state = fixture('save-pvp-midgame.json');
  for (const key of ['setup', 'replay', 'history']) Object.defineProperty(state, key, { get() { throw new Error('Secret read: ' + key); } });
  for (const tier of [1, 2, 3]) {
    const length = state.deck[tier].length;
    state.deck[tier] = new Proxy([], { get(target, key) { if (key === 'length') return length;throw new Error('Hidden pile read'); } });
  }
  const hidden = state.players[0].reserved[0];
  for (const key of ['id', 'score', 'cost', 'color']) Object.defineProperty(hidden, key, { get() { throw new Error('Private face read'); } });
  const observation = rules.observe(state, 1);
  assert.deepEqual(observation.players[0].reserved, [{ tier: 1, faceDown: true }]);
  assert.doesNotThrow(() => legacy.decide(observation, 123));
});

test('simulation has no UI, storage, logging, clock or animation dependencies', () => {
  const { api, effects } = startGame(), state = api.getState();
  for (const key of ['history', 'replay', 'setup']) Object.defineProperty(state, key, { get() { throw new Error('Non-rule access: ' + key); } });
  const writes = effects.writes.length, renders = effects.renders;
  assert.equal(rules.simulate(state, { type: 'take', colors: ['w', 'u', 'g'] }).ok, true);
  assert.equal(effects.writes.length, writes);assert.equal(effects.renders, renders);
});

test('legacy scoring, RNG and discard function bodies are verbatim copies of the archive', () => {
  const frozen = fs.readFileSync('tests/baseline/legacy-v1.html', 'utf8');
  const policy = fs.readFileSync('js/legacy-v1.js', 'utf8');
  for (const name of ['bonusCards', 'price', 'canBuy', 'canTake', 'owned', 'marketOf', 'getMarketCards', 'allOptions',
    'weightedColor', 'botRandom', 'lookAhead', 'usefulTake', 'autoDiscard', 'botTurn']) {
    const start = frozen.indexOf('function ' + name + '(');
    const end = name === 'botTurn' ? frozen.indexOf('\nconst costHTML', start) : frozen.indexOf('\nfunction ', start + 1);
    assert.ok(policy.includes(frozen.slice(start, end)), name);
  }
});
