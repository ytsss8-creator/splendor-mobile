'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { ROOT, BASELINE, fixture, startGame, loadGame, plain, giveTokens, assertInvariants } = require('./helpers/game-harness.cjs');
const actionFromEvent = event => event.action.type === 'take' ? { type: 'take', colors: [...event.action.colors] }
  : event.action.type === 'blind_reserve' ? { type: 'blind_reserve', tier: event.action.tier }
    : { type: event.action.type, cardId: event.action.card.id };

for (const mode of ['ai', 'pvp']) {
  test(`${mode}: new games store easy and legacy-v1 without changing setup format`, () => {
    const { api, storage } = startGame({ mode }), state = api.getState();
    assert.equal(state.aiDifficulty, 'easy');assert.equal(state.aiVersion, 'legacy-v1');assert.equal(state.rulePhase, 'action');
    assert.deepEqual(plain(state.setup), fixture('board-seed-v1.json').setup);
    assert.equal(JSON.parse(storage.get('splendor_classic_v4')).aiDifficulty, 'easy');
  });
  test(`${mode}: setup shows disabled future difficulties only in AI mode`, () => {
    const { api } = startGame({ mode }), html = api.makeMatchSetupHTML();
    assert.match(html, /value="easy" selected/);
    assert.match(html, /value="normal"[^>]*>普通/);
    assert.match(html, /value="hard"[^>]*>困难（实验版）/);
    assert.doesNotMatch(html, /value="hard" disabled/);
    if (mode === 'pvp') assert.match(html, /id="matchDifficultyRow" hidden style="display:none"/);
    else assert.doesNotMatch(html, /id="matchDifficultyRow" hidden/);
  });
}

test('new simple AI game executes the frozen legacy-v1 decision', () => {
  const { api } = startGame();const state = api.getState();
  state.turn = 1;state.rulePhase = 'action';
  const expected = api.legacy.decide(api.observation(1), state.botRng);
  api.botTurn();
  const actual = state.replay.findLast(event => event.actor === 'bot' && ['take', 'buy', 'reserve', 'blind_reserve'].includes(event.action.type));
  assert.deepEqual(actionFromEvent(actual), plain(expected.action));
  assert.equal(state.aiVersion, 'legacy-v1');
});

for (const name of ['save-ai-initial.json', 'save-ai-pending.json', 'save-ai-midgame.json', 'save-ai-pre-replay.json',
  'save-pvp-discard.json', 'save-pvp-noble.json', 'save-pvp-midgame.json', 'save-pvp-final-response.json', 'save-pvp-ended.json']) {
  test(`missing difficulty defaults to easy and keeps RNG/setup: ${name}`, () => {
    const original = fixture(name), { api } = loadGame({ saved: original }), state = api.getState();
    assert.equal(state.aiDifficulty, 'easy');assert.equal(state.aiVersion, 'legacy-v1');
    assert.equal(state.botRng, original.botRng);assert.deepEqual(plain(state.setup), original.setup);
    assert.deepEqual(plain(state.players), original.players);
    assert.deepEqual(plain(state.deck), original.deck);
    assert.equal(state.rulePhase, original.over ? 'over' : original.modal?.type === 'discard' ? 'discard'
      : original.modal?.type === 'noble' ? 'noble' : 'action');
  });
}

test('unknown difficulty cannot silently start a new game or advance the RNG', () => {
  const { api } = startGame(), state = api.getState(), before = plain(state);
  assert.throws(() => api.newGame('shuffle', null, { mode: 'ai', difficulty: 'future-test' }), /尚未启用/);
  assert.deepEqual(plain(api.getState()), before);
  state.turn = 1;state.aiDifficulty = 'future-test';
  const unsupported = plain(state);
  assert.throws(() => api.botTurn(), /尚未启用/);
  assert.deepEqual(plain(state), unsupported);
});

test('hard starts and dispatches frozen V2 C, and reload preserves its exact policy identity', () => {
  const { api } = startGame();
  api.newGame('shuffle', null, { mode: 'ai', names: ['玩家1', 'AI'], difficulty: 'hard' });
  const state = api.getState();
  assert.equal(state.aiDifficulty, 'hard');assert.equal(state.aiVersion, 'v2-search');
  assert.equal(state.aiConfigId, '79d417842cf84f158a08d3db4910fd8ffd4d2f5e3c82e6a83df67485fb63d572');
  assert.equal(api.policyForState(state), api.v2);
  assert.deepEqual(plain(api.v2Config), { enabled: true, mode: 'minimax', tacticalTrigger: false,
    endgameRaceEvaluation: false, rootTopK: 6, responseTopK: 4, maxNodes: 320,
    maxExpansions: 320, timeBudgetMs: 180, uncertaintyPenalty: 0.75, debug: true });
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(plain(api.v2Config))).digest('hex'), api.v2ConfigId);
  assert.equal(api.v2.configuration.timeBudgetMs, 180);assert.equal(api.v2.configuration.maxNodes, 320);
  state.turn = 1;state.rulePhase = 'action';
  const before = plain(state), observation = api.observation(1), decision = api.v2.decide(observation, api.rules, state.botRng);
  assert.ok(decision.action, 'Frozen V2 C selects a root action for the initial legal position');
  assert.equal(api.rules.validateAction(before, decision.action, 1).ok, true);
  api.botTurn();
  assert.equal(state.aiVersion, 'v2-search');assert.equal(state.aiConfigId, api.v2ConfigId);
  const event = state.replay.findLast(value => value.actor === 'bot' && ['take', 'buy', 'reserve', 'blind_reserve'].includes(value.action.type));
  assert.ok(event, 'The standalone game dispatcher records the hard AI action');
  assert.equal(api.rules.validateAction(before, actionFromEvent(event), 1).ok, true);
  const restored = loadGame({ saved: plain(state) }).api.getState();
  assert.equal(restored.aiDifficulty, 'hard');assert.equal(restored.aiVersion, 'v2-search');
  assert.equal(restored.aiConfigId, api.v2ConfigId);
});

test('illegal V2 action triggers a legal Hybrid C exception fallback', () => {
  const { api } = startGame(), state = api.getState();state.turn = 1;state.rulePhase = 'action';
  const observation = api.observation(1), rng = state.botRng;
  const expected = api.hybrid.decide(observation, api.rules, rng);
  for (const candidate of [
    { decide: () => ({ action: { type: 'take', colors: ['y', 'y', 'y'] } }) },
    { decide: () => { throw new Error('injected V2 failure'); } },
  ]) {
    const fallback = api.safeV2Decision(observation, rng, candidate);
    assert.deepEqual(plain(fallback.action), plain(expected.action));
    assert.equal(api.rules.validateAction(state, fallback.action, 1).ok, true);
  }
});

test('hard bot applies its complete discard and noble settlement choices through core rules', () => {
  const overflow = startGame();
  overflow.api.newGame('shuffle', null, { mode: 'ai', names: ['玩家1', 'AI'], difficulty: 'hard' });
  Object.assign(overflow.api.getState(), { turn: 1, rulePhase: 'action' });
  giveTokens(overflow.api, 1, { w: 3, u: 3, g: 3 });
  assert.equal(overflow.api.take(['r', 'k', 'w'], 1), true);
  overflow.api.afterAction(1, { discardColors: ['w', 'u'] });
  const discards = overflow.api.getState().replay.filter(event => event.actor === 'bot' && event.action.type === 'discard');
  assert.deepEqual(plain(discards.map(event => event.action.color)), ['w', 'u']);
  assert.equal(Object.values(overflow.api.getState().players[1].tokens).reduce((sum, value) => sum + value, 0), 10);

  const noble = startGame();
  noble.api.newGame('shuffle', null, { mode: 'ai', names: ['玩家1', 'AI'], difficulty: 'hard' });
  const live = noble.api.getState();live.turn = 1;live.rulePhase = 'settle';
  for (const color of noble.api.COLORS) live.players[1].bonuses[color] = 5;
  const eligible = noble.api.eligible(1), selected = eligible.at(-1).id;
  assert.ok(eligible.length > 1);
  noble.api.afterAction(1, { nobleId: selected });
  assert.deepEqual(plain(live.players[1].nobles.map(value => value.id)), [selected]);
});

test('normal starts and runs the frozen Hybrid C configuration while easy remains legacy-v1', () => {
  const { api, storage } = startGame();
  api.newGame('shuffle', null, { mode: 'ai', names: ['玩家1', 'AI'], difficulty: 'normal' });
  const state = api.getState();assert.equal(state.aiDifficulty, 'normal');assert.equal(state.aiVersion, 'hybrid-v1');
  assert.equal(state.aiConfigId, 'b10785820427d5e0cc516c51538ffb9ca019ea5ce9036fadd0aee5b32d392a1c');
  assert.deepEqual(plain(api.hybridConfig), { terminal: true, reservation: true, scoring: true,
    reservationRouteFix: true, zeroProgressComparison: true, planNodes: 16 });
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(plain(api.hybridConfig))).digest('hex'), api.hybridConfigId);
  assert.equal(api.hybrid.configuration.reservationRouteFix, true);
  assert.equal(api.hybrid.configuration.zeroProgressComparison, true);
  assert.equal(api.hybrid.configuration.planNodes, 16);
  state.turn = 1;state.rulePhase = 'action';
  const expected = api.hybrid.decide(api.observation(1), api.rules, state.botRng);
  api.botTurn();
  assert.equal(state.turn, 0);assert.equal(state.round, 2);
  const actual = state.replay.findLast(event => event.actor === 'bot' && ['take', 'buy', 'reserve', 'blind_reserve'].includes(event.action.type));
  assert.deepEqual(actionFromEvent(actual), plain(expected.action), 'The game dispatcher executes the Hybrid C decision');
  assert.equal(state.aiDifficulty, 'normal');assert.equal(state.aiVersion, 'hybrid-v1');
  assert.equal(JSON.parse(storage.get('splendor_classic_v4')).aiDifficulty, 'normal');
  const restored = loadGame({ saved: plain(state) }).api.getState();
  assert.equal(restored.aiVersion, 'hybrid-v1');assert.equal(restored.aiConfigId, api.hybridConfigId);
});

test('an existing advanced-v1 normal save keeps its strategy and execution across reload', () => {
  const saved = fixture('save-ai-midgame.json');saved.aiDifficulty = 'normal';saved.aiVersion = 'advanced-v1';
  const { api } = loadGame({ saved }), state = api.getState();
  assert.equal(state.aiDifficulty, 'normal');assert.equal(state.aiVersion, 'advanced-v1');
  for (const key of ['players', 'bank', 'deck', 'market', 'setup', 'botRng', 'turn', 'round', 'replay']) {
    assert.deepEqual(plain(state[key]), saved[key], key);
  }
  state.matchMode = 'ai';state.turn = 1;state.rulePhase = 'action';
  const expected = api.advanced.decide(api.observation(1), api.rules, state.botRng);
  api.botTurn();
  const actual = state.replay.findLast(event => event.actor === 'bot' && ['take', 'buy', 'reserve', 'blind_reserve'].includes(event.action.type));
  assert.deepEqual(actionFromEvent(actual), plain(expected.action), 'Historical advanced-v1 games stay on advanced-v1');
});

test('a legacy normal save without strategy metadata keeps the historical advanced-v1 policy', () => {
  const saved = fixture('save-ai-midgame.json');saved.aiDifficulty = 'normal';delete saved.aiVersion;delete saved.aiConfigId;
  const { api } = loadGame({ saved });
  assert.equal(api.getState().aiDifficulty, 'normal');assert.equal(api.getState().aiVersion, 'advanced-v1');
});

test('same-board replay preserves the source match strategy version', () => {
  const current = startGame();current.api.newGame('shuffle', null,
    { mode: 'ai', names: ['玩家1', 'AI'], difficulty: 'normal' });
  current.api.newGame('replay');
  assert.equal(current.api.getState().aiVersion, 'hybrid-v1');
  assert.equal(current.api.getState().aiConfigId, current.api.hybridConfigId);

  const saved = fixture('save-ai-midgame.json');saved.aiDifficulty = 'normal';saved.aiVersion = 'advanced-v1';
  const historical = loadGame({ saved });historical.api.newGame('replay');
  assert.equal(historical.api.getState().aiVersion, 'advanced-v1');
  assert.equal('aiConfigId' in historical.api.getState(), false);
});

test('Hybrid C observations omit hidden decks and the opponent private reserved-card identity', () => {
  const { api } = startGame({ mode: 'pvp' }), state = api.getState();
  assert.equal(api.blindReserve(1, 0), true);
  state.turn = 1;state.rulePhase = 'action';
  const observation = api.observation(1), hidden = observation.players[0].reserved[0];
  assert.equal('deck' in observation, false);assert.equal('setup' in observation, false);
  assert.equal('history' in observation, false);assert.equal('replay' in observation, false);
  assert.equal(hidden.faceDown, true);assert.equal('id' in hidden, false);
  assert.equal('score' in hidden, false);assert.equal('cost' in hidden, false);
  const decision = api.hybrid.decide(observation, api.rules, state.botRng);
  assert.ok(decision.action);
});

test('V2 C receives only the public observation, including when hidden deck order changes', () => {
  const { api } = startGame({ mode: 'pvp' }), state = api.getState();
  assert.equal(api.blindReserve(1, 0), true);
  state.turn = 1;state.rulePhase = 'action';
  const observation = api.observation(1), serialized = JSON.stringify(observation), hiddenIds = state.deck[1].map(card => card.id);
  assert.equal('deck' in observation, false);assert.equal('setup' in observation, false);
  assert.equal(observation.players[0].reserved[0].faceDown, true);
  assert.equal('id' in observation.players[0].reserved[0], false);
  for (const tier of [1, 2, 3]) state.deck[tier].reverse();
  const afterShuffleObservation = api.observation(1);
  assert.equal(JSON.stringify(afterShuffleObservation), serialized);
  const decision = api.v2.decide(observation, api.rules, state.botRng);
  assert.ok(decision.action);
  assert.equal(api.rules.validateAction(state, decision.action, 1).ok, true);
  assert.notDeepEqual(state.deck[1].map(card => card.id), hiddenIds);
});

for (const [name, phase] of [['save-pvp-discard.json', 'discard'], ['save-pvp-noble.json', 'noble']]) {
  test(`saved pending modal restores its phase even with stale additive metadata: ${phase}`, () => {
    const saved = fixture(name);saved.rulePhase = 'action';saved.aiDifficulty = 'easy';saved.aiVersion = 'legacy-v1';
    const { api } = loadGame({ saved });
    assert.equal(api.getState().rulePhase, phase);
    for (const key of ['players', 'bank', 'deck', 'market', 'replay', 'botRng']) assert.deepEqual(plain(api.getState()[key]), saved[key]);
    if (phase === 'discard') api.discardOne('w');else api.endModalChoice(10);
    assertInvariants(api);
  });
}

test('loading an unsupported saved difficulty explicitly falls back without losing progress', () => {
  const original = fixture('save-ai-midgame.json');original.aiDifficulty = 'hard';original.aiVersion = 'future-test';
  const { api } = loadGame({ saved: original }), state = api.getState();
  assert.equal(state.aiDifficulty, 'easy');assert.equal(state.aiVersion, 'legacy-v1');
  assert.match(state.notice, /尚未启用.*简单/);
  for (const key of ['players', 'deck', 'market', 'setup', 'botRng', 'turn', 'round', 'replay']) assert.deepEqual(plain(state[key]), original[key]);
});

for (const colors of [['y', 'y'], ['w', 'u', 'y'], ['y'], ['y', 'y', 'y']]) {
  test(`production rule adapter rejects gold take atomically: ${colors.join(',')}`, () => {
    const { api, effects } = startGame();api.getState().turn = 1;
    const before = plain(api.getState()), writes = effects.writes.length, renders = effects.renders;
    assert.equal(api.canTake(colors, 1), false);assert.equal(api.take(colors, 1), false);
    assert.deepEqual(plain(api.getState()), before);
    assert.equal(effects.writes.length, writes);assert.equal(effects.renders, renders);
  });
}

test('production adapters reject a wrong actor, forged card, invalid tier and invalid noble choice', () => {
  const { api } = startGame(), state = api.getState();
  const forged = plain(state.market[1][0]);forged.cost = {};
  const before = plain(state);
  assert.equal(api.take(['w', 'u', 'g'], 1), false);
  assert.equal(api.pay(forged, 0), false);
  assert.equal(api.reserve(forged, 0), false);
  assert.equal(api.blindReserve(99, 0), false);
  assert.deepEqual(plain(state), before);
  const restored = loadGame({ saved: fixture('save-pvp-noble.json') });
  const pending = plain(restored.api.getState());restored.api.endModalChoice(999);
  assert.deepEqual(plain(restored.api.getState()), pending);
});

test('a second primary action cannot alter state or add log events in the same turn', () => {
  const { api } = startGame();assert.equal(api.take(['w', 'u', 'g'], 0), true);
  const before = plain(api.getState());
  assert.equal(api.take(['r', 'k', 'w'], 0), false);
  assert.equal(api.reserve(api.getState().market[1][0], 0), false);
  assert.deepEqual(plain(api.getState()), before);
});

test('new game cancels stale AI callbacks even if a new match also reaches AI turn', () => {
  const { api, effects } = startGame();api.take(['w', 'u', 'g'], 0);api.afterAction(0);
  const stale = [...effects.timers.values()].at(-1).callback;
  api.newGame('replay');api.take(['w', 'u', 'g'], 0);api.afterAction(0);
  const before = plain(api.getState());stale();
  assert.deepEqual(plain(api.getState()), before);
  assert.equal(effects.timers.size, 1);
});

test('closing an AI-turn setup dialog resumes the AI exactly once', () => {
  const { api, effects } = loadGame({ saved: fixture('save-ai-pending.json') });
  const pending = [...effects.timers.values()][0];
  api.getState().modal = { type: 'setup' };pending.callback();
  const before = api.getState().replay.length;
  api.dispatch({ act: 'match-cancel' });
  // The real browser removes fired timers; execute the newest scheduled one here.
  [...effects.timers.values()].at(-1).callback();
  assert.equal(api.getState().turn, 0);
  assert.equal(api.getState().replay.slice(before).filter(event => event.actor === 'bot' && ['take', 'buy', 'reserve'].includes(event.action.type)).length, 1);
});

test('runtime contains unchanged layout CSS, artwork, card rendering and no affordability badges', () => {
  const original = fs.readFileSync(BASELINE, 'utf8'), current = fs.readFileSync(ROOT + '/index.html', 'utf8');
  assert.equal(current.match(/<style>([\s\S]*?)<\/style>/)[1], original.match(/<style>([\s\S]*?)<\/style>/)[1]);
  for (const name of ['cardArtHTML', 'cardShellHTML', 'cardHTML', 'reservedCardHTML', 'reservePlayerHTML', 'selectedBox', 'mobileDockHTML']) {
    const start = original.indexOf('function ' + name + '(');
    const end = original.indexOf('\nfunction ', start + 1);
    assert.ok(current.includes(original.slice(start, end)), name);
  }
  assert.equal(/<script\b[^>]*\bsrc=/.test(current), false, 'Single-file HTML requires no external JS');
});

test('manual overflow may return gold acquired by a normal reservation, at most one gained', () => {
  const { api } = startGame({ mode: 'pvp' }), state = api.getState();
  giveTokens(api, 0, { w: 4, u: 4, g: 2 });
  api.selectCard(state.market[2][0].id);api.playerReserve();
  assert.equal(state.players[0].tokens.y, 1);assert.equal(state.bank.y, 4);assert.equal(state.modal.need, 1);
  api.discardOne('y');assert.equal(state.bank.y, 5);assert.equal(state.players[0].tokens.y, 0);
  assert.equal(state.turn, 1);assertInvariants(api, { settled: true });
});
