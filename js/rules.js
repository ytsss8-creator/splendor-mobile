/* Pure classic rules. This source is also embedded verbatim in index.html. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplendorRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const COLORS = ['w', 'u', 'g', 'r', 'k'], ALL = [...COLORS, 'y'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const count = player => ALL.reduce((sum, color) => sum + player.tokens[color], 0);

  function create(catalogue) {
    const byId = new Map(catalogue.map(card => [card.id, card]));
    const marketCards = state => [3, 2, 1].flatMap(tier => state.market[tier]);
    const findCard = (state, id, who) => marketCards(state).find(card => card.id === id)
      || state.players[who]?.reserved.find(card => card.id === id) || null;
    const phase = state => state.modal && !['discard', 'noble'].includes(state.modal.type) ? 'blocked'
      : state.rulePhase || (state.modal?.type === 'discard' ? 'discard' : state.modal?.type === 'noble' ? 'noble' : 'action');
    const validPlayer = (state, who) => Number.isInteger(who) && (who === 0 || who === 1)
      && !!state.players?.[who];
    const validTokens = values => values && ALL.every(color => Number.isInteger(values[color]) && values[color] >= 0);
    const sameCard = (card, expected) => !!card && !!expected && card.id === expected.id
      && card.tier === expected.tier && card.color === expected.color && card.score === expected.score
      && COLORS.every(color => (card.cost?.[color] || 0) === (expected.cost?.[color] || 0));
    const eligible = (state, who) => state.nobles.filter(noble => COLORS.every(color =>
      (state.players[who].bonuses[color] || 0) >= (noble.req[color] || 0)));

    function price(card, player) {
      const req = {};let short = 0;
      for (const color of COLORS) {
        req[color] = Math.max(0, (card.cost[color] || 0) - (player.bonuses[color] || 0));
        short += Math.max(0, req[color] - (player.tokens[color] || 0));
      }
      return { req, short, left: Math.max(0, short - (player.tokens.y || 0)) };
    }

    function canTake(state, pick) {
      // Gold is never obtainable through a take action, even with two equal entries.
      if (!Array.isArray(pick) || !pick.length || !Array.from(pick).every(color => COLORS.includes(color))
        || !validTokens(state.bank)) return false;
      const available = COLORS.filter(color => state.bank[color] > 0).length;
      if (available > 0 && pick.length === Math.min(3, available) && new Set(pick).size === pick.length) {
        return pick.every(color => state.bank[color] > 0);
      }
      return pick.length === 2 && pick[0] === pick[1] && state.bank[pick[0]] >= 4;
    }

    function validateAction(state, action, who = state.turn) {
      const reject = reason => ({ ok: false, reason });
      if (!validPlayer(state, who) || who !== state.turn) return reject('wrong_actor');
      if (state.over) return reject('game_over');
      if (!action || typeof action !== 'object' || Array.isArray(action)) return reject('invalid_action');
      if (state.modal && !['discard', 'noble'].includes(state.modal.type)) return reject('modal_open');
      if (!validTokens(state.bank) || !validTokens(state.players[who].tokens)) return reject('invalid_resources');
      const player = state.players[who], current = phase(state);
      if (['take', 'buy', 'reserve', 'blind_reserve'].includes(action.type)) {
        if (current !== 'action') return reject('action_already_taken');
        if (action.type === 'take') return canTake(state, action.colors) ? { ok: true } : reject('invalid_take');
        if (action.type === 'blind_reserve') {
          if (!Number.isInteger(action.tier) || ![1, 2, 3].includes(action.tier)) return reject('invalid_tier');
          return player.reserved.length < 3 && state.deck[action.tier].length > 0
            ? { ok: true } : reject('cannot_reserve');
        }
        if (typeof action.cardId !== 'string') return reject('invalid_card');
        const card = findCard(state, action.cardId, who);
        if (!sameCard(card, byId.get(action.cardId))) return reject('invalid_card');
        if (action.type === 'buy') return price(card, player).left === 0 ? { ok: true } : reject('cannot_afford');
        return player.reserved.length < 3 && marketCards(state).some(value => value.id === card.id)
          ? { ok: true } : reject('cannot_reserve');
      }
      if (action.type === 'discard') {
        return current === 'discard' && count(player) > 10 && ALL.includes(action.color) && player.tokens[action.color] > 0
          ? { ok: true } : reject('invalid_discard');
      }
      if (action.type === 'noble') {
        return current === 'noble' && Number.isInteger(action.id) && eligible(state, who).some(noble => noble.id === action.id)
          ? { ok: true } : reject('invalid_noble');
      }
      return reject('unknown_action');
    }

    function legalActions(state, who = state.turn) {
      if (!validPlayer(state, who) || who !== state.turn || state.over) return [];
      let candidates = [], current = phase(state);
      if (current === 'discard') candidates = ALL.map(color => ({ type: 'discard', color }));
      else if (current === 'noble') candidates = eligible(state, who).map(noble => ({ type: 'noble', id: noble.id }));
      else if (current === 'action') {
        const available = COLORS.filter(color => state.bank[color] > 0);
        if (available.length < 3) candidates.push({ type: 'take', colors: available });
        else for (let i = 0; i < available.length; i++) for (let j = i + 1; j < available.length; j++) {
          for (let k = j + 1; k < available.length; k++) candidates.push({ type: 'take', colors: [available[i], available[j], available[k]] });
        }
        candidates.push(...COLORS.map(color => ({ type: 'take', colors: [color, color] })));
        candidates.push(...[...marketCards(state), ...state.players[who].reserved].map(card => ({ type: 'buy', cardId: card.id })));
        candidates.push(...marketCards(state).map(card => ({ type: 'reserve', cardId: card.id })));
        candidates.push(...[1, 2, 3].map(tier => ({ type: 'blind_reserve', tier })));
      }
      return candidates.filter(action => validateAction(state, action, who).ok);
    }

    function removeFace(state, card) {
      const cards = state.market[card.tier], index = cards.findIndex(value => value.id === card.id);
      const replacement = state.deck[card.tier].pop();
      if (replacement) cards[index] = replacement;else cards.splice(index, 1);
    }

    function executeAction(state, action, who = state.turn) {
      const check = validateAction(state, action, who);
      if (!check.ok) return { ...check, events: [] };
      const player = state.players[who];let event;
      if (action.type === 'take') {
        for (const color of action.colors) { state.bank[color]--;player.tokens[color]++; }
        event = { type: 'take', colors: [...action.colors] };
      } else if (action.type === 'buy') {
        const card = findCard(state, action.cardId, who), req = price(card, player).req;
        const spent = Object.fromEntries(ALL.map(color => [color, 0]));
        for (const color of COLORS) { spent[color] = Math.min(req[color], player.tokens[color]);spent.y += req[color] - spent[color]; }
        for (const color of ALL) { player.tokens[color] -= spent[color];state.bank[color] += spent[color]; }
        if (player.reserved.some(value => value.id === card.id)) player.reserved = player.reserved.filter(value => value.id !== card.id);
        else removeFace(state, card);
        player.cards.push(card);player.bonuses[card.color]++;player.score += card.score;
        event = { type: 'buy', card: clone(card), spent };
      } else if (action.type === 'reserve' || action.type === 'blind_reserve') {
        const card = action.type === 'reserve' ? findCard(state, action.cardId, who) : state.deck[action.tier].pop();
        if (action.type === 'reserve') removeFace(state, card);else card.blindReserved = true;
        player.reserved.push(card);
        if (state.bank.y > 0) { state.bank.y--;player.tokens.y++; }
        event = { type: action.type, ...(action.type === 'blind_reserve' ? { tier: action.tier } : {}), card: clone(card) };
      } else if (action.type === 'discard') {
        player.tokens[action.color]--;state.bank[action.color]++;
        state.rulePhase = count(player) > 10 ? 'discard' : 'settle';
        event = { type: 'discard', color: action.color };
      } else {
        const noble = state.nobles.find(value => value.id === action.id);
        player.nobles.push(noble);player.score += 3;
        state.nobles = state.nobles.filter(value => value.id !== noble.id);
        state.rulePhase = 'complete';event = { type: 'noble', id: noble.id };
      }
      if (['take', 'buy', 'reserve', 'blind_reserve'].includes(action.type)) state.rulePhase = 'settle';
      return { ok: true, events: [event] };
    }

    function prepareSettlement(state, who = state.turn) {
      if (!validPlayer(state, who) || who !== state.turn || state.over) return { type: 'invalid' };
      if (!['settle', 'discard', 'noble', 'complete'].includes(phase(state))) return { type: 'invalid' };
      if (state.rulePhase === 'complete') return { type: 'complete' };
      if (count(state.players[who]) > 10) {
        state.rulePhase = 'discard';return { type: 'discard', need: count(state.players[who]) - 10 };
      }
      const nobles = eligible(state, who);
      if (nobles.length) { state.rulePhase = 'noble';return { type: 'noble', options: nobles.map(noble => noble.id) }; }
      state.rulePhase = 'complete';return { type: 'complete' };
    }

    function winnerSide(state) {
      const [a, b] = state.players;
      return a.score !== b.score ? (a.score > b.score ? 0 : 1)
        : a.cards.length !== b.cards.length ? (a.cards.length < b.cards.length ? 0 : 1) : -1;
    }

    function advanceTurn(state, who = state.turn) {
      if (!validPlayer(state, who) || who !== state.turn || state.over || state.rulePhase !== 'complete') return { ok: false };
      if (who === 0) { if (state.players[0].score >= 15) state.endTrigger = true;state.turn = 1; }
      else { state.turn = 0;state.round++;if (state.endTrigger || state.players[1].score >= 15) state.over = true; }
      state.rulePhase = state.over ? 'over' : 'action';
      return { ok: true, finished: !!state.over, winnerSide: state.over ? winnerSide(state) : null };
    }

    function copyState(state) {
      // No setup, RNG, history, replay, animation, selection or browser objects.
      const result = clone(Object.fromEntries(['bank', 'market', 'deck', 'players', 'nobles', 'turn', 'round', 'over', 'endTrigger'].map(key => [key, state[key]])));
      result.rulePhase = phase(state);
      return result;
    }

    function simulate(state, action, choices = {}) {
      const next = copyState(state), who = next.turn, result = executeAction(next, action, who);
      const events = [...result.events];let discardIndex = 0;
      if (!result.ok) return { ...result, state: next };
      while (true) {
        const pending = prepareSettlement(next, who);
        if (pending.type === 'complete') { const end = advanceTurn(next, who);return { ok: true, state: next, events, pending: null, ...end }; }
        let follow;
        if (pending.type === 'discard') {
          const color = choices.discardColors?.[discardIndex++];
          if (color === undefined) return { ok: true, state: next, events, pending };
          follow = { type: 'discard', color };
        } else if (pending.type === 'noble') {
          const id = pending.options.length === 1 ? pending.options[0] : choices.nobleId;
          if (id === undefined) return { ok: true, state: next, events, pending };
          follow = { type: 'noble', id };
        } else return { ok: false, reason: 'invalid_settlement', state: next, events };
        const applied = executeAction(next, follow, who);
        if (!applied.ok) return { ...applied, state: next, events };
        events.push(...applied.events);
      }
    }

    function observe(state, who) {
      if (!validPlayer(state, who)) throw new Error('Invalid observer');
      const card = value => ({ id: value.id, tier: value.tier, color: value.color, score: value.score,
        cost: Object.fromEntries(COLORS.filter(color => value.cost[color]).map(color => [color, value.cost[color]])),
        ...(value.blindReserved ? { blindReserved: true } : {}) });
      const noble = value => ({ id: value.id, name: value.name,
        req: Object.fromEntries(COLORS.filter(color => value.req[color]).map(color => [color, value.req[color]])) });
      const tokens = value => Object.fromEntries(ALL.map(color => [color, value[color] || 0]));
      return {
        self: who, turn: state.turn, round: state.round, over: !!state.over, endTrigger: !!state.endTrigger,
        bank: tokens(state.bank), market: Object.fromEntries([1, 2, 3].map(tier => [tier, state.market[tier].map(card)])),
        drawPileCounts: Object.fromEntries([1, 2, 3].map(tier => [tier, state.deck[tier].length])),
        nobles: state.nobles.map(noble),
        players: state.players.map((player, side) => ({ score: player.score, tokens: tokens(player.tokens), bonuses: tokens(player.bonuses),
          cards: player.cards.map(card), nobles: player.nobles.map(noble),
          reserved: player.reserved.map(value => side !== who && value.blindReserved
            ? { tier: value.tier, faceDown: true } : card(value)) })),
      };
    }

    return Object.freeze({ price, canTake, sameCard, findCard, eligible, validateAction, legalActions,
      executeAction, prepareSettlement, advanceTurn, winnerSide, copyState, simulate, observe });
  }
  return Object.freeze({ create });
});
