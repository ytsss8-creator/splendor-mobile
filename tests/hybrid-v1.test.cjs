'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RulesAPI = require('../js/rules.js');
const Legacy = require('../js/legacy-v1.js');
const Advanced = require('../js/advanced-v1.js');
const P2 = require('./fixtures/p3/p2-advanced-v1.js');
const Hybrid = require('../js/hybrid-v1.js');
const { fixture } = require('./helpers/game-harness.cjs');
const { newBoard, legacyChoices, assertBoard, data } = require('./helpers/ai-battles.cjs');

const rules = RulesAPI.create(fixture('classic-data-v1.json').cards);
const clone = value => structuredClone(value);

function publicPositionKey(state) {
  return JSON.stringify({ turn: state.turn, bank: state.bank, nobles: state.nobles.map(noble => noble.id),
    drawCounts: Object.fromEntries([1, 2, 3].map(tier => [tier, state.deck[tier].length])),
    market: Object.fromEntries([1, 2, 3].map(tier => [tier, state.market[tier].map(card => card.id)])), players: state.players.map(player => ({
    score: player.score, tokens: player.tokens, bonuses: player.bonuses,
    cards: player.cards.map(card => card.id), reserved: player.reserved.map(card => card.id),
  })) });
}

function replayToAction(seed, swapped, actionIndex) {
  const state = newBoard(seed), rng = [seed ^ 0x9e3779b9, seed ^ 0x85ebca6b];
  const baselineHybrid = Hybrid.create();
  const policies = swapped ? ['hybrid', 'legacy'] : ['legacy', 'hybrid'];
  for (let index = 0; index < actionIndex; index++) {
    const side = state.turn, observation = rules.observe(state, side), policy = policies[side];
    const choice = policy === 'legacy' ? Legacy.decide(observation, rng[side])
      : baselineHybrid.decide(observation, rules, rng[side]);
    const settlement = policy === 'legacy'
      ? legacyChoices(state, observation, choice.action, rules, side) : choice.settlementChoices;
    const result = rules.simulate(state, choice.action, settlement);
    assert.equal(result.ok, true);
    assert.equal(result.pending, null);
    rng[side] = choice.nextRng;
    Object.assign(state, result.state);
  }
  return { state, rng, policies };
}

test('hybrid with all tactics disabled is an observation-only legacy adapter', () => {
  const state = newBoard(4039509411), observation = rules.observe(state, 0), before = JSON.stringify(state);
  const rng = 0x10203040, baseline = Legacy.decide(observation, rng);
  const wrapped = Hybrid.create({ terminal: false, reservation: false, scoring: false })
    .decide(observation, rules, rng);
  assert.deepEqual(wrapped.action, baseline.action);
  assert.equal(wrapped.nextRng, baseline.nextRng);
  assert.equal(wrapped.status, 'ok');
  assert.equal(wrapped.diagnostics.override, null);
  assert.equal(JSON.stringify(state), before, 'decision mutated the real game');
});

test('hybrid is deterministic from the same public observation and RNG', () => {
  const state = newBoard(73013), observation = rules.observe(state, 0), rng = 0xdecafbad;
  const ai = Hybrid.create();
  const a = ai.decide(observation, rules, rng), b = ai.decide(clone(observation), rules, rng);
  assert.deepEqual(a, b);
  assert.equal(rules.validateAction(state, a.action, 0).ok, true);
  const withPrivateNoise = { ...clone(observation), privateDeck: [{ id: 'secret-card', score: 99 }] };
  assert.deepEqual(ai.decide(withPrivateNoise, rules, rng), a);
});

test('seed 3987438674 reproduces a conserved no-legal-action state and hybrid reports it as blocked', () => {
  const seed = 3987438674, state = newBoard(seed);
  const rng = [seed ^ 0x9e3779b9, seed ^ 0x85ebca6b], at = ['final', 'p2'];
  let actions = 0;
  while (!state.over && actions < 30) {
    const side = state.turn, observation = rules.observe(state, side), policy = at[side];
    const decision = policy === 'final'
      ? Advanced.decide(observation, rules, rng[side])
      : P2.decide(observation, rules, rng[side]);
    if (!decision.action) break;
    assert.equal(rules.validateAction(state, decision.action, side).ok, true);
    const settlement = decision.settlementChoices || legacyChoices(state, observation, decision.action, rules, side);
    const result = rules.simulate(state, decision.action, settlement);
    assert.equal(result.ok, true);
    assert.equal(result.pending, null);
    rng[side] = decision.nextRng;
    Object.assign(state, result.state);
    actions++;
    assertBoard(state);
  }
  assert.equal(actions, 16);
  assert.equal(state.round, 9);
  const observation = rules.observe(state, state.turn);
  assert.deepEqual(rules.legalActions(state, state.turn), []);
  assert.equal(rules.legalActions(state, state.turn).length, 0);
  assert.deepEqual(Object.fromEntries(['w', 'u', 'g', 'r', 'k'].map(color => [color, state.bank[color]])),
    { w: 0, u: 0, g: 0, r: 0, k: 0 });
  assert.equal(Hybrid.create().decide(observation, rules, rng[state.turn]).status, 'blocked_no_legal_action');
  assertBoard(state);
});

test('P3.3 cycle entry reproduces and route-fix reserves 1-16 for a rule-replayed next-own-turn buy in both seats', () => {
  const seed = 2336270054;
  for (const swapped of [false, true]) {
    const loopEntryIndex = 25, firstHybridAction = swapped ? 26 : 25;
    const replay = replayToAction(seed, swapped, loopEntryIndex);
    const { state, rng, policies } = replay;
    // The P3.3 baseline reproduces the old two-action no-progress cycle.
    const entry = rules.copyState(state);
    for (let index = loopEntryIndex; index < 27; index++) {
      const actor = state.turn, current = rules.observe(state, actor), policy = policies[actor];
      const choice = policy === 'legacy' ? Legacy.decide(current, rng[actor])
        : Hybrid.create().decide(current, rules, rng[actor]);
      const settlement = policy === 'legacy'
        ? legacyChoices(state, current, choice.action, rules, actor) : choice.settlementChoices;
      const result = rules.simulate(state, choice.action, settlement);
      assert.equal(result.ok, true);
      assert.equal(result.pending, null);
      rng[actor] = choice.nextRng;
      Object.assign(state, result.state);
    }
    assert.equal(publicPositionKey(entry), publicPositionKey(state));

    // Rebuild the exact loop-entry state and apply only the new route toggle.
    const atEntry = replayToAction(seed, swapped, firstHybridAction);
    const side = atEntry.state.turn, entryObservation = rules.observe(atEntry.state, side);
    assert.equal(atEntry.policies[side], 'hybrid');
    const decision = Hybrid.create({ reservationRouteFix: true })
      .decide(entryObservation, rules, atEntry.rng[atEntry.state.turn]);
    assert.deepEqual(decision.action, { type: 'reserve', cardId: '1-16' });
    assert.equal(decision.diagnostics.override.kind, 'target-reserve');
    assert.equal(decision.diagnostics.override.evidence.resourceActionsAfterReserve, 0);
    assert.equal(decision.diagnostics.override.evidence.buyWithinOwnActions, 1);
    assert.equal(decision.diagnostics.override.evidence.totalOwnActionsIncludingReserve, 2);
    assert.equal(decision.diagnostics.override.evidence.actionsSaved, 1);

    const reserveResult = rules.simulate(atEntry.state, decision.action, decision.settlementChoices);
    assert.equal(reserveResult.ok, true);
    assert.equal(reserveResult.pending, null);
    const held = reserveResult.state.players[atEntry.state.turn].reserved.find(card => card.id === '1-16');
    assert.ok(held);
    assert.equal(reserveResult.state.players[atEntry.state.turn].tokens.y,
      atEntry.state.players[atEntry.state.turn].tokens.y + 1);
    const plannedState = rules.copyState(reserveResult.state);
    plannedState.turn = atEntry.state.turn;plannedState.rulePhase = 'action';
    const plannedObservation = rules.observe(plannedState, plannedState.turn);
    const plan = Advanced._internals.acquisitionPlan(plannedState, held, rules, plannedState.turn,
      Advanced._internals.knownIdsOf(plannedObservation), plannedObservation, 16);
    assert.ok(plan);
    assert.equal(plan.turns, 0);
    assert.ok(Advanced._internals.applyPlanAndBuy(plannedState, held, plan, rules,
      plannedState.turn, plannedObservation, Advanced._internals.knownIdsOf(plannedObservation)));

    // Replay the intervening legacy move, then purchase the reserved card on
    // the next own turn through the ordinary rules engine.
    const opponent = 1 - plannedState.turn, opponentObservation = rules.observe(reserveResult.state, opponent);
    const opponentChoice = Legacy.decide(opponentObservation, atEntry.rng[opponent]);
    const opponentResult = rules.simulate(reserveResult.state, opponentChoice.action,
      legacyChoices(reserveResult.state, opponentObservation, opponentChoice.action, rules, opponent));
    assert.equal(opponentResult.ok, true);
    const buy = { type: 'buy', cardId: '1-16' };
    assert.equal(rules.validateAction(opponentResult.state, buy, plannedState.turn).ok, true);
    const buyResult = rules.simulate(opponentResult.state, buy, {});
    assert.equal(buyResult.ok, true);
    assert.equal(buyResult.pending, null);
    assert.ok(buyResult.state.players[plannedState.turn].score > reserveResult.state.players[plannedState.turn].score);
    assertBoard(buyResult.state);
  }
});

test('hybrid route plus zero-progress comparison completes seed 2336270054 in both seat orders', () => {
  const seed = 2336270054;
  for (const swapped of [false, true]) {
    const state = newBoard(seed), rng = [seed ^ 0x9e3779b9, seed ^ 0x85ebca6b];
    const policies = swapped ? ['hybrid', 'legacy'] : ['legacy', 'hybrid'];
    const hybrid = Hybrid.create({ reservationRouteFix: true, zeroProgressComparison: true });
    const seen = new Set();let actions = 0, repeated = 0;
    while (!state.over && actions < 180) {
      const side = state.turn, observation = rules.observe(state, side), key = publicPositionKey(state);
      if (seen.has(key)) repeated++;else seen.add(key);
      const policy = policies[side];
      const decision = policy === 'legacy' ? Legacy.decide(observation, rng[side])
        : hybrid.decide(observation, rules, rng[side]);
      assert.ok(decision.action, `missing action at ${actions} in swapped=${swapped}`);
      assert.equal(rules.validateAction(state, decision.action, side).ok, true);
      const settlement = policy === 'legacy'
        ? legacyChoices(state, observation, decision.action, rules, side) : decision.settlementChoices;
      const result = rules.simulate(state, decision.action, settlement);
      assert.equal(result.ok, true);
      assert.equal(result.pending, null);
      rng[side] = decision.nextRng;
      Object.assign(state, result.state);actions++;
      assertBoard(state);
    }
    assert.equal(state.over, true, `seed did not finish in swapped=${swapped}`);
    assert.ok(actions < 180);
    assert.equal(repeated, 0);
  }
});

test('frozen Hybrid C completes seed 2360684404 in both seat orders without repeating a public state', () => {
  const seed = 2360684404;
  for (const swapped of [false, true]) {
    const state = newBoard(seed), rng = [seed ^ 0x9e3779b9, seed ^ 0x85ebca6b];
    const policies = swapped ? ['hybrid', 'legacy'] : ['legacy', 'hybrid'];
    const hybrid = Hybrid.create({ terminal: true, reservation: true, scoring: true,
      reservationRouteFix: true, zeroProgressComparison: true, planNodes: 16 });
    const seen = new Set();let actions = 0;
    while (!state.over && actions < 180) {
      const side = state.turn, observation = rules.observe(state, side), key = publicPositionKey(state);
      assert.equal(seen.has(key), false, `repeated public state at action ${actions}, swapped=${swapped}`);
      seen.add(key);
      const policy = policies[side];
      const decision = policy === 'legacy' ? Legacy.decide(observation, rng[side])
        : hybrid.decide(observation, rules, rng[side]);
      assert.ok(decision.action);
      assert.equal(rules.validateAction(state, decision.action, side).ok, true);
      const settlement = policy === 'legacy'
        ? legacyChoices(state, observation, decision.action, rules, side) : decision.settlementChoices;
      const result = rules.simulate(state, decision.action, settlement);
      assert.equal(result.ok, true);
      assert.equal(result.pending, null);
      rng[side] = decision.nextRng;
      Object.assign(state, result.state);actions++;
      assertBoard(state);
    }
    assert.equal(state.over, true, `seed did not finish in swapped=${swapped}`);
    assert.ok(actions < 180);
  }
});

test('zero-progress route compares bounded legal alternatives and replays its scored route', () => {
  const seed = 18718738, state = newBoard(seed), rng = [seed ^ 0x9e3779b9, seed ^ 0x85ebca6b];
  const policies = ['legacy', 'hybrid'];
  const hybrid = Hybrid.create({ reservationRouteFix: true, zeroProgressComparison: true });
  let checked = false;
  for (let actions = 0; actions < 40 && !checked; actions++) {
    const side = state.turn, observation = rules.observe(state, side), policy = policies[side];
    const decision = policy === 'legacy' ? Legacy.decide(observation, rng[side])
      : hybrid.decide(observation, rules, rng[side]);
    if (decision.diagnostics?.override?.kind === 'zero-progress-route') {
      const evidence = decision.diagnostics.override.evidence;
      assert.equal(evidence.actionsSaved, 1);
      assert.equal(evidence.goldReceived, 1);
      assert.ok(evidence.slotActionCost <= 1);
      assert.ok(decision.diagnostics.zeroProgressAudit.zeroProgressPositions > 0);
      assert.ok(decision.diagnostics.zeroProgressAudit.searchedRoutes <= 3);
      assert.equal(rules.validateAction(state, decision.action, side).ok, true);
      const result = rules.simulate(state, decision.action, decision.settlementChoices);
      assert.equal(result.ok, true);
      assert.equal(result.pending, null);
      const target = result.state.market[2].find(card => card.id === evidence.targetId)
        || result.state.players[side].reserved.find(card => card.id === evidence.targetId);
      assert.ok(target);
      const projected = rules.copyState(result.state);projected.turn = side;projected.rulePhase = 'action';
      const projectedObservation = rules.observe(projected, side);
      const route = { actions: evidence.replayablePlan, turns: evidence.replayablePlan.length };
      assert.ok(Advanced._internals.applyPlanAndBuy(projected, target, route, rules, side,
        projectedObservation, Advanced._internals.knownIdsOf(projectedObservation)));
      checked = true;
    } else {
      const settlement = policy === 'legacy'
        ? legacyChoices(state, observation, decision.action, rules, side) : decision.settlementChoices;
      const result = rules.simulate(state, decision.action, settlement);
      assert.equal(result.ok, true);
      assert.equal(result.pending, null);
      rng[side] = decision.nextRng;
      Object.assign(state, result.state);
      assertBoard(state);
    }
  }
  assert.equal(checked, true, 'expected a reproducible, bounded zero-progress alternative');
});
