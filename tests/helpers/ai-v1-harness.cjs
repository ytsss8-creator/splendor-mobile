'use strict';

const { fixture, expandDecisionInput } = require('./game-harness.cjs');
const RulesAPI = require('../../js/rules.js');
const Advanced = require('../../js/advanced-v1.js');
const data = fixture('classic-data-v1.json');
const cardById = new Map(data.cards.map(card => [card.id, card]));
const nobleById = new Map(data.nobles.map(noble => [noble.id, noble]));
const COLORS = ['w', 'u', 'g', 'r', 'k'], ALL = [...COLORS, 'y'];

function makeState({ market = null, nobles = [1, 2, 3], turn = 0, scores = [0, 0], tokens = [{}, {}],
  bonuses = [{}, {}], reserved = [[], []], cards = [[], []], bank = null, round = 1 } = {}) {
  const state = expandDecisionInput(fixture('save-ai-initial.json'));
  state.market = market ? Object.fromEntries([1, 2, 3].map(tier => [tier, (market[tier] || []).map(id => structuredClone(cardById.get(id)))]))
    : state.market;
  state.nobles = nobles.map(id => structuredClone(nobleById.get(id)));
  state.players = [0, 1].map(side => ({ score: scores[side], tokens: Object.fromEntries(ALL.map(color => [color, 0])),
    bonuses: Object.fromEntries(COLORS.map(color => [color, 0])), cards: [], nobles: [], reserved: [] }));
  for (let side = 0; side < 2; side++) {
    for (const color of ALL) state.players[side].tokens[color] = tokens[side][color] || 0;
    for (const color of COLORS) state.players[side].bonuses[color] = bonuses[side][color] || 0;
    state.players[side].cards = cards[side].map(id => structuredClone(cardById.get(id)));
    state.players[side].reserved = reserved[side].map(id => structuredClone(cardById.get(id)));
  }
  state.bank = bank ? { ...bank } : Object.fromEntries([...COLORS.map(color => [color, 4]), ['y', 5]]);
  if (!bank) for (const color of ALL) for (const player of state.players) state.bank[color] -= player.tokens[color];
  state.turn = turn;state.round = round;state.over = false;state.endTrigger = false;state.rulePhase = 'action';state.modal = null;
  return state;
}

function policy(state, rng = 1) {
  const rules = RulesAPI.create(data.cards);
  const observation = rules.observe(state, state.turn);
  const decision = Advanced.decide(observation, rules, rng);
  return { rules, observation, decision };
}

module.exports = { Advanced, RulesAPI, data, cardById, nobleById, COLORS, ALL, makeState, policy };
