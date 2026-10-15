'use strict';

const { performance } = require('node:perf_hooks');
const { fixture } = require('./game-harness.cjs');
const RulesAPI = require('../../js/rules.js');
const Legacy = require('../../js/legacy-v1.js');
const Advanced = require('../../js/advanced-v1.js');
const data = fixture('classic-data-v1.json');
const byId = new Map(data.cards.map(card => [card.id, card]));
const COLORS = ['w', 'u', 'g', 'r', 'k'], ALL = [...COLORS, 'y'];

function randomFor(seed) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(1664525, value) + 1013904223) >>> 0;return value / 4294967296; };
}

function shuffle(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));[result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function newBoard(seed) {
  const random = randomFor(seed), market = {}, deck = {};
  for (const tier of [1, 2, 3]) {
    const cards = shuffle(data.cards.filter(card => card.tier === tier).map(card => structuredClone(card)), random);
    deck[tier] = cards.slice(0, -4);market[tier] = cards.slice(-4).reverse();
  }
  const nobles = shuffle(data.nobles.map(noble => structuredClone(noble)), random).slice(0, 3);
  const player = () => ({ score: 0, tokens: Object.fromEntries(ALL.map(color => [color, 0])),
    bonuses: Object.fromEntries(COLORS.map(color => [color, 0])), cards: [], nobles: [], reserved: [] });
  return { bank: Object.fromEntries([...COLORS.map(color => [color, 4]), ['y', 5]]), market, deck, nobles,
    players: [player(), player()], turn: 0, round: 1, over: false, endTrigger: false, rulePhase: 'action' };
}

function assertBoard(state) {
  for (const color of ALL) assertResource(state, color);
  const cards = [1, 2, 3].flatMap(tier => [...state.deck[tier], ...state.market[tier]])
    .concat(state.players.flatMap(player => [...player.cards, ...player.reserved]));
  if (cards.length !== 90 || new Set(cards.map(card => card.id)).size !== 90) throw new Error('card conservation failed');
  for (const player of state.players) {
    if (player.score !== player.cards.reduce((sum, card) => sum + card.score, 0) + 3 * player.nobles.length) throw new Error('score mismatch');
    for (const color of COLORS) if (player.bonuses[color] !== player.cards.filter(card => card.color === color).length) throw new Error('discount mismatch');
    if (ALL.reduce((sum, color) => sum + player.tokens[color], 0) > 10) throw new Error('token limit failed');
  }
}

function assertResource(state, color) {
  const expected = color === 'y' ? 5 : 4;
  if ([state.bank[color], ...state.players.map(player => player.tokens[color])].reduce((a, b) => a + b, 0) !== expected) {
    throw new Error(`${color} token conservation failed`);
  }
}

function legacyChoices(state, observation, action, rules, side) {
  const scratch = rules.copyState(state), applied = rules.executeAction(scratch, action, side);
  if (!applied.ok) throw new Error('legacy action did not apply in settlement preview');
  let pending = rules.prepareSettlement(scratch, side), discardColors = [];
  while (pending.type === 'discard') {
    const colors = Legacy.discardColors(rules.observe(scratch, side));
    const color = colors[0];if (!color) throw new Error('legacy discard preview was incomplete');
    discardColors.push(color);rules.executeAction(scratch, { type: 'discard', color }, side);
    pending = rules.prepareSettlement(scratch, side);
  }
  return { discardColors, ...(pending.type === 'noble' ? { nobleId: pending.options[0] } : {}) };
}

function runGame(seed, swapped, maxActions = 180, withTrace = false) {
  const state = newBoard(seed), rules = RulesAPI.create(data.cards), rng = [seed ^ 0x9e3779b9, seed ^ 0x85ebca6b];
  const policyAt = swapped ? ['v1', 'simple'] : ['simple', 'v1'];
  let actions = 0;const elapsed = [], trace = [];
  while (!state.over && actions < maxActions) {
    const side = state.turn, observation = rules.observe(state, side), strategy = policyAt[side];
    const start = performance.now();
    const decision = strategy === 'v1' ? Advanced.decide(observation, rules, rng[side]) : Legacy.decide(observation, rng[side]);
    if (strategy === 'v1') elapsed.push(performance.now() - start);
    if (!decision.action) throw new Error(`${strategy} returned no move at seed ${seed}, action ${actions}`);
    if (withTrace) trace.push({ round: state.round, side, strategy, score: state.players[side].score,
      action: decision.action, route: decision.diagnostics?.route || [] });
    const valid = rules.validateAction(state, decision.action, side);
    if (!valid.ok) throw new Error(`${strategy} returned illegal move ${JSON.stringify(decision.action)}: ${valid.reason}`);
    rng[side] = decision.nextRng;
    const choices = strategy === 'v1' ? decision.settlementChoices : legacyChoices(state, observation, decision.action, rules, side);
    const result = rules.simulate(state, decision.action, choices);
    if (!result.ok || result.pending) throw new Error(`${strategy} settlement failed at seed ${seed}: ${result.reason || result.pending?.type}`);
    Object.assign(state, result.state);actions++;assertBoard(state);
  }
  if (!state.over) throw new Error(`game exceeded ${maxActions} actions at seed ${seed}`);
  const winner = rules.winnerSide(state);
  return { seed, swapped, actions, round: state.round, winnerPolicy: winner < 0 ? 'draw' : policyAt[winner],
    scores: state.players.map(player => player.score), zeroPointCards: state.players.map(player => player.cards.filter(card => card.score === 0).length),
    v1Times: elapsed, ...(withTrace ? { trace } : {}) };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function runSmoke({ boardCount = 20, firstSeed = 73013 } = {}) {
  if (!Number.isInteger(boardCount) || boardCount < 1 || boardCount > 50) throw new RangeError('boardCount must be 1..50');
  const games = [];
  for (let index = 0; index < boardCount; index++) {
    const seed = (firstSeed + index * 7919) >>> 0;
    games.push(runGame(seed, false), runGame(seed, true));
  }
  const summary = {};
  for (const policy of ['simple', 'v1']) {
    const played = games.length, wins = games.filter(game => game.winnerPolicy === policy).length;
    const draws = games.filter(game => game.winnerPolicy === 'draw').length;
    const scoreIndex = policy === 'v1' ? (game => game.swapped ? 0 : 1) : (game => game.swapped ? 1 : 0);
    const scores = games.map(game => game.scores[scoreIndex(game)]), zeros = games.map(game => game.zeroPointCards[scoreIndex(game)]);
    const victories = games.filter(game => game.winnerPolicy === policy);
    summary[policy] = { played, wins, draws, losses: played - wins - draws, winRate: (wins + draws / 2) / played,
      firstSeat: games.filter(game => (game.swapped ? policy === 'v1' : policy === 'simple')).length,
      averageFinalScore: scores.reduce((a, b) => a + b, 0) / scores.length,
      averageWinningRound: victories.length ? victories.reduce((sum, game) => sum + game.round, 0) / victories.length : null,
      averageZeroPointCards: zeros.reduce((a, b) => a + b, 0) / zeros.length };
  }
  const timings = games.flatMap(game => game.v1Times);
  return { boardCount, gameCount: games.length, seeds: games.filter(game => !game.swapped).map(game => game.seed),
    summary, v1DecisionMs: { samples: timings.length, p50: percentile(timings, .5), p95: percentile(timings, .95),
      p99: percentile(timings, .99), max: Math.max(...timings) } };
}

module.exports = { newBoard, runGame, runSmoke, assertBoard, legacyChoices, data };
