/* V1 advanced heuristic. Observation-only and deterministic; embedded for standalone HTML. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplendorAdvancedAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const COLORS = ['w', 'u', 'g', 'r', 'k'], ALL = [...COLORS, 'y'];
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const clone = value => JSON.parse(JSON.stringify(value));
  const tokenCount = tokens => ALL.reduce((sum, color) => sum + (tokens[color] || 0), 0);
  const safeCard = card => ({ id: card.id, tier: card.tier, color: card.color, score: card.score,
    cost: Object.fromEntries(COLORS.filter(color => card.cost?.[color]).map(color => [color, card.cost[color]])),
    ...(card.blindReserved ? { blindReserved: true } : {}) });

  function shadowState(observation) {
    const self = observation.self, market = Object.fromEntries([1, 2, 3].map(tier =>
      [tier, observation.market[tier].map(safeCard)]));
    const players = observation.players.map((player, side) => ({
      score: player.score, tokens: { ...player.tokens }, bonuses: { ...player.bonuses },
      cards: player.cards.map(safeCard), nobles: clone(player.nobles),
      reserved: player.reserved.map((card, index) => card.faceDown
        ? { id: `__opaque_reserve_${side}_${index}`, tier: card.tier, color: 'w', score: 0, cost: {}, blindReserved: true }
        : safeCard(card)),
    }));
    const deck = {};
    for (const tier of [1, 2, 3]) {
      deck[tier] = Array.from({ length: observation.drawPileCounts[tier] }, (_, index) => ({
        id: `__unknown_${tier}_${index}`, tier, color: 'w', score: 0, cost: {},
      }));
    }
    return {
      bank: { ...observation.bank }, market, deck, players, nobles: clone(observation.nobles),
      turn: self, round: observation.round, over: !!observation.over,
      endTrigger: !!observation.endTrigger, rulePhase: 'action',
    };
  }

  function knownIdsOf(observation) {
    return new Set([... [3, 2, 1].flatMap(tier => observation.market[tier].map(card => card.id)),
      ...observation.players[observation.self].reserved.filter(card => !card.faceDown).map(card => card.id)]);
  }

  function normalizeOwnTurn(state, self) {
    if (!state.over) { state.turn = self;state.rulePhase = 'action'; }
    return state;
  }

  function chooseNobleOption(state, who, options) {
    if (!options?.length) return undefined;
    if (options.length === 1) return options[0];
    const opponent = state.players[1 - who];
    return [...options].sort((a, b) => {
      const leftA = state.nobles.find(noble => noble.id === a), leftB = state.nobles.find(noble => noble.id === b);
      const distance = noble => COLORS.reduce((sum, color) => sum + Math.max(0,
        (noble.req[color] || 0) - (opponent.bonuses[color] || 0)), 0);
      return distance(leftA) - distance(leftB) || a - b;
    })[0];
  }

  function tokenUsefulness(state, who, color, knownIds, rules) {
    const player = state.players[who];
    if (color === 'y') return 2.5;
    let best = 0;
    const cards = [1, 2, 3].flatMap(tier => state.market[tier]).concat(player.reserved)
      .filter(card => knownIds.has(card.id));
    for (const card of cards) {
      const price = rules.price(card, player);
      if (price.req[color] > (player.tokens[color] || 0)) {
        const remaining = Math.max(1, price.left);
        const reward = card.score * 1.8 + 1.0;
        best = Math.max(best, reward / (1 + remaining * 0.28));
      }
    }
    return best + (player.tokens[color] ? 0.025 / player.tokens[color] : 0);
  }

  function settlementChoices(state, action, rules, who, knownIds) {
    const scratch = rules.copyState(state);
    const applied = rules.executeAction(scratch, action, who);
    if (!applied.ok) return { discardColors: [], nobleId: undefined };
    let pending = rules.prepareSettlement(scratch, who), discardColors = [];
    while (pending.type === 'discard') {
      const actions = rules.legalActions(scratch, who).filter(candidate => candidate.type === 'discard');
      actions.sort((a, b) => tokenUsefulness(scratch, who, a.color, knownIds, rules)
        - tokenUsefulness(scratch, who, b.color, knownIds, rules) || ALL.indexOf(a.color) - ALL.indexOf(b.color));
      const choice = actions[0];
      if (!choice) break;
      discardColors.push(choice.color);
      rules.executeAction(scratch, choice, who);
      pending = rules.prepareSettlement(scratch, who);
    }
    return { discardColors, nobleId: pending.type === 'noble' ? chooseNobleOption(scratch, who, pending.options) : undefined };
  }

  function simulateFull(state, action, rules, who, knownIds) {
    const choices = settlementChoices(state, action, rules, who, knownIds);
    return { ...rules.simulate(state, action, choices), choices };
  }

  function takeSets(bank, rules) {
    const available = COLORS.filter(color => bank[color] > 0), sets = [];
    if (available.length < 3) {
      if (available.length) sets.push(available);
    } else {
      for (let i = 0; i < available.length; i++) for (let j = i + 1; j < available.length; j++) {
        for (let k = j + 1; k < available.length; k++) sets.push([available[i], available[j], available[k]]);
      }
    }
    for (const color of COLORS) if (bank[color] >= 4) sets.push([color, color]);
    return sets;
  }

  function targetDiscard(tokens, req, knownIds, player, observation, who) {
    const result = { ...tokens };
    while (tokenCount(result) > 10) {
      const candidates = ALL.filter(color => result[color] > 0).map(color => {
        let keep = color === 'y' ? 2.5 : Math.max(0, (req[color] || 0) - Math.max(0, result[color] - 1)) > 0 ? 1.8 : 0.15;
        if (color !== 'y') {
          for (const card of [...[1, 2, 3].flatMap(tier => observation.market[tier]), ...observation.players[who].reserved]) {
            if (!knownIds.has(card.id)) continue;
            const need = Math.max(0, (card.cost[color] || 0) - (player.bonuses[color] || 0) - (player.tokens[color] || 0));
            if (need > 0) keep = Math.max(keep, 0.3 / need);
          }
        }
        return { color, keep };
      }).sort((a, b) => a.keep - b.keep || ALL.indexOf(a.color) - ALL.indexOf(b.color));
      if (!candidates.length) break;
      result[candidates[0].color]--;
    }
    return result;
  }

  function compactKey(node) {
    return `${ALL.map(color => node.tokens[color]).join('')}:${COLORS.map(color => node.bank[color]).join('')}:` +
      `${node.reservedIds.length}:${node.targetHeld ? 1 : 0}:${node.drawCounts[1]},${node.drawCounts[2]},${node.drawCounts[3]}`;
  }

  function planPriority(node, req) {
    let missing = 0, available = 0;
    for (const color of COLORS) {
      const deficit = Math.max(0, req[color] - node.tokens[color]);
      missing += deficit;available += Math.min(deficit, node.bank[color]);
    }
    const afterGold = Math.max(0, missing - node.tokens.y);
    const blocked = Math.max(0, missing - node.tokens.y - available);
    return node.path.length + Math.ceil(afterGold / 3) + blocked * 0.25;
  }

  function acquisitionPlan(state, target, rules, who, knownIds, observation, nodeLimit = 32) {
    const initialPlayer = state.players[who], startingReserved = initialPlayer.reserved.map(card => card.id);
    const start = { tokens: { ...initialPlayer.tokens }, bank: { ...state.bank }, reservedIds: startingReserved,
      marketIds: [3, 2, 1].flatMap(tier => state.market[tier].map(card => card.id)),
      drawCounts: { 1: state.deck[1].length, 2: state.deck[2].length, 3: state.deck[3].length },
      targetHeld: startingReserved.includes(target.id), path: [] };
    const queue = [start], seen = new Set([compactKey(start)]);let visited = 0;
    const req = Object.fromEntries(COLORS.map(color => [color, Math.max(0,
      (target.cost[color] || 0) - (initialPlayer.bonuses[color] || 0))]));
    const canAfford = node => {
      const tokens = node.tokens;
      return COLORS.reduce((sum, color) => sum + Math.max(0, req[color] - tokens[color]), 0) <= tokens.y;
    };
    const offer = node => {
      if (node.path.length >= 5 || visited >= nodeLimit) return;
      const deficit = color => Math.max(0, req[color] - node.tokens[color]);
      for (const colors of takeSets(node.bank, rules)) {
        if (!colors.some(color => deficit(color) > 0)) continue;
        if (!rules.canTake({ bank: node.bank }, colors)) continue;
        const tokens = { ...node.tokens }, bank = { ...node.bank };
        for (const color of colors) { tokens[color]++;bank[color]--; }
        const nextTokens = targetDiscard(tokens, req, knownIds, initialPlayer, observation, who);
        const next = { ...node, tokens: nextTokens, bank,
          path: [...node.path, { action: { type: 'take', colors: [...colors] }, discardColors: ALL.flatMap(color =>
            Array.from({ length: tokens[color] - nextTokens[color] }, () => color)) }] };
        const key = compactKey(next);
        if (!seen.has(key)) { seen.add(key);queue.push(next); }
      }
      if (node.bank.y <= 0 || node.reservedIds.length >= 3) return;
      let reserveId;
      if (node.marketIds.includes(target.id)) reserveId = target.id;
      else reserveId = node.marketIds.find(id => id !== target.id && knownIds.has(id));
      if (!reserveId) {
        const tier = [1, 2, 3].find(value => node.drawCounts[value] > 0);
        if (tier) {
          const tokens = { ...node.tokens, y: node.tokens.y + 1 }, bank = { ...node.bank, y: node.bank.y - 1 };
          const nextTokens = targetDiscard(tokens, req, knownIds, initialPlayer, observation, who);
          const drawCounts = { ...node.drawCounts, [tier]: node.drawCounts[tier] - 1 };
          const next = { ...node, tokens: nextTokens, bank, drawCounts,
            reservedIds: [...node.reservedIds, `__unknown_${tier}_${drawCounts[tier]}`],
            path: [...node.path, { action: { type: 'blind_reserve', tier }, discardColors: ALL.flatMap(color =>
              Array.from({ length: tokens[color] - nextTokens[color] }, () => color)) }] };
          const key = compactKey(next);
          if (!seen.has(key)) { seen.add(key);queue.push(next); }
        }
        return;
      }
      const tokens = { ...node.tokens, y: node.tokens.y + 1 }, bank = { ...node.bank, y: node.bank.y - 1 };
      const nextTokens = targetDiscard(tokens, req, knownIds, initialPlayer, observation, who);
      const marketIds = node.marketIds.filter(id => id !== reserveId);
      const next = { ...node, tokens: nextTokens, bank, marketIds,
        reservedIds: [...node.reservedIds, reserveId], targetHeld: node.targetHeld || reserveId === target.id,
        path: [...node.path, { action: { type: 'reserve', cardId: reserveId }, discardColors: ALL.flatMap(color =>
          Array.from({ length: tokens[color] - nextTokens[color] }, () => color)) }] };
      const key = compactKey(next);
      if (!seen.has(key)) { seen.add(key);queue.push(next); }
    };
    while (queue.length && visited < nodeLimit) {
      queue.sort((a, b) => planPriority(a, req) - planPriority(b, req)
        || a.path.length - b.path.length || compactKey(a).localeCompare(compactKey(b)));
      const node = queue.shift();visited++;
      if (canAfford(node)) return { actions: node.path, turns: node.path.length, tokens: node.tokens,
        bank: node.bank, targetHeld: node.targetHeld, visited };
      offer(node);
    }
    return null;
  }

  function projectedAction(state, item, rules, who, observation, knownIds) {
    const choices = { discardColors: item.discardColors || [] };
    const sim = rules.simulate(state, item.action, choices);
    if (!sim.ok || sim.pending) return null;
    return normalizeOwnTurn(sim.state, who);
  }

  function applyPlanAndBuy(state, target, plan, rules, who, observation, knownIds) {
    let current = rules.copyState(state);normalizeOwnTurn(current, who);
    for (const item of plan.actions) {
      current = projectedAction(current, item, rules, who, observation, knownIds);
      if (!current) return null;
    }
    const buy = { type: 'buy', cardId: target.id };
    if (!rules.validateAction(current, buy, who).ok) return null;
    const result = simulateFull(current, buy, rules, who, knownIds);
    if (!result.ok || result.pending) return null;
    return { state: result.state, choices: result.choices };
  }

  function targetRank(state, target, rules, who, knownIds) {
    const player = state.players[who], price = rules.price(target, player);
    const missing = Math.max(0, price.short - player.tokens.y);
    const lowerTurns = Math.ceil(missing / 3);
    const noble = state.nobles.reduce((best, value) => {
      const before = COLORS.reduce((sum, color) => sum + Math.max(0,
        (value.req[color] || 0) - (player.bonuses[color] || 0)), 0);
      const after = COLORS.reduce((sum, color) => sum + Math.max(0,
        (value.req[color] || 0) - (player.bonuses[color] || 0) - (target.color === color ? 1 : 0)), 0);
      return Math.max(best, before - after === 0 && after === 0 ? 3.0 : before - after > 0 ? 0.35 : 0);
    }, 0);
    const stage = clamp(Math.max(player.score / 15, state.round / 18), 0, 1);
    const engine = target.score === 0 ? (1 - stage) * 1.2 : 0;
    const reserved = player.reserved.some(card => card.id === target.id) ? 0.35 : 0;
    return target.score * 2.2 + noble + engine + reserved - lowerTurns * 0.32;
  }

  function relevantTargets(state, rules, who, knownIds) {
    const player = state.players[who];
    const options = [3, 2, 1].flatMap(tier => state.market[tier]).concat(player.reserved)
      .filter(card => knownIds.has(card.id));
    const ranked = options.map(card => ({ card, rank: targetRank(state, card, rules, who, knownIds),
      affordable: rules.price(card, player).left === 0, reserved: player.reserved.some(value => value.id === card.id) }))
      .sort((a, b) => Number(b.affordable) - Number(a.affordable) || Number(b.reserved) - Number(a.reserved)
        || b.rank - a.rank || a.card.id.localeCompare(b.card.id));
    const selected = ranked.slice(0, 10);
    for (const item of ranked) if ((item.affordable || item.reserved) && !selected.some(value => value.card.id === item.card.id)) selected.push(item);
    return selected.slice(0, 12).map(item => item.card);
  }

  function terminalValue(state, self, rules, knownIds, observation) {
    if (state.over) {
      const winner = rules.winnerSide(state);
      return winner < 0 ? 0 : winner === self ? 10000 : -10000;
    }
    if (state.endTrigger && state.players[self].score >= 15 && self === 0) {
      const opponent = 1;
      const responseState = rules.copyState(state);responseState.turn = opponent;responseState.rulePhase = 'action';
      const allResponses = rules.legalActions(responseState, opponent), buys = allResponses.filter(action => action.type === 'buy');
      const responseActions = buys.length ? buys : allResponses.slice(0, 1);
      let worst = Infinity;
      for (const action of responseActions) {
        const sim = simulateFull(responseState, action, rules, opponent, knownIds);
        if (!sim.ok || !sim.state.over) continue;
        const winner = rules.winnerSide(sim.state);
        const outcome = winner < 0 ? 0 : winner === self ? 10000 : -10000;
        worst = Math.min(worst, outcome);
      }
      return Number.isFinite(worst) ? worst : -10000;
    }
    return null;
  }

  function reserveOpportunityCost(player, stage) {
    const hidden = player.reserved.filter(card => card.blindReserved).length;
    return player.reserved.length * (0.12 + stage * 0.22) + hidden * (0.85 + stage * 0.55)
      + Math.max(0, player.reserved.length - 1) ** 2 * 0.35;
  }

  function opponentThreatPenalty(state, self, rules, knownIds) {
    const opponent = 1 - self;
    if (self !== 1 || opponent !== 0 || state.players[opponent].score < 10) return 0;
    const threatState = rules.copyState(state);threatState.turn = opponent;threatState.rulePhase = 'action';
    let worst = 0;
    for (const action of rules.legalActions(threatState, opponent)) {
      if (action.type !== 'buy') continue;
      const simulated = simulateFull(threatState, action, rules, opponent, knownIds);
      if (!simulated.ok || !simulated.state.endTrigger || simulated.state.turn !== self) continue;
      let bestReply = -10000;
      const replies = rules.legalActions(simulated.state, self), replyBuys = replies.filter(reply => reply.type === 'buy');
      for (const reply of replyBuys.length ? replyBuys : replies.slice(0, 1)) {
        const response = simulateFull(simulated.state, reply, rules, self, knownIds);
        if (!response.ok || !response.state.over) continue;
        const winner = rules.winnerSide(response.state);
        bestReply = Math.max(bestReply, winner < 0 ? 0 : winner === self ? 10000 : -10000);
      }
      if (bestReply < 0) worst = Math.min(worst, -600);
      else if (bestReply === 0) worst = Math.min(worst, -160);
    }
    return worst;
  }

  function immediateEndThreats(state, self, rules, knownIds) {
    const opponent = 1 - self, threats = new Set();
    if (state.players[opponent].score < 10) return threats;
    const forecast = rules.copyState(state);forecast.turn = opponent;forecast.rulePhase = 'action';
    for (const action of rules.legalActions(forecast, opponent)) {
      if (action.type !== 'buy') continue;
      const result = simulateFull(forecast, action, rules, opponent, knownIds);
      if (result.ok && (result.state.over || result.state.endTrigger)) threats.add(action.cardId);
    }
    return threats;
  }

  function stateUtility(state, cost, self, rules, knownIds, includeThreat = false) {
    const terminal = terminalValue(state, self, rules, knownIds);
    if (terminal !== null) return terminal - cost * 45;
    const player = state.players[self], opponent = state.players[1 - self];
    const stage = clamp(Math.max((player.score + opponent.score) / 30, state.round / 18), 0, 1);
    const scoreWeight = 7.2 + 3.2 * stage;
    const turnCost = 1.25 + 1.1 * stage;
    const discounts = COLORS.reduce((sum, color) => sum + (player.bonuses[color] || 0), 0);
    const engineWeight = 1.65 * (1 - stage) ** 2 + 0.08;
    const tiePotential = (opponent.cards.length - player.cards.length) * (0.04 + stage * 0.12);
    const material = Math.min(10, tokenCount(player.tokens)) * (0.11 + (1 - stage) * 0.06);
    return player.score * scoreWeight - cost * turnCost + discounts * engineWeight + material + tiePotential
      - reserveOpportunityCost(player, stage)
      + (includeThreat ? opponentThreatPenalty(state, self, rules, knownIds) : 0);
  }

  function routeSearch(state, rules, self, knownIds, observation) {
    const initialTerminal = terminalValue(state, self, rules, knownIds);
    if (initialTerminal !== null) return { value: initialTerminal, route: [], explored: 0 };
    let best = { value: stateUtility(state, 0, self, rules, knownIds, true), route: [] }, explored = 0;
    let beam = [{ state, cost: 0, route: [] }];
    for (let depth = 0; depth < 3; depth++) {
      const children = [];
      for (const node of beam) {
        const targets = relevantTargets(node.state, rules, self, knownIds).slice(0, depth === 2 ? 1 : 2);
        for (const target of targets) {
          const plan = acquisitionPlan(node.state, target, rules, self, knownIds, observation, 5);
          explored += plan?.visited || 1;
          if (!plan || node.cost + plan.turns + 1 > 14) continue;
          const transition = applyPlanAndBuy(node.state, target, plan, rules, self, observation, knownIds);
          if (!transition) continue;
          const cost = node.cost + plan.turns + 1, route = [...node.route, target.id];
          const value = stateUtility(transition.state, cost, self, rules, knownIds);
          if (value > best.value) best = { value, route, cost };
          children.push({ state: transition.state, cost, route, value });
        }
      }
      children.sort((a, b) => b.value - a.value || a.cost - b.cost || a.route.join('|').localeCompare(b.route.join('|')));
      beam = children.slice(0, 1);
      if (!beam.length) break;
    }
    return { ...best, explored };
  }

  function quickUtility(state, self, rules, knownIds) {
    const terminal = terminalValue(state, self, rules, knownIds);
    if (terminal !== null) return terminal;
    const player = state.players[self], opponent = state.players[1 - self];
    const stage = clamp(Math.max((player.score + opponent.score) / 30, state.round / 18), 0, 1);
    const scoreWeight = 7.2 + 3.2 * stage, turnCost = 1.25 + 1.1 * stage;
    const discounts = COLORS.reduce((sum, color) => sum + (player.bonuses[color] || 0), 0);
    const engine = discounts * (1.65 * (1 - stage) ** 2 + 0.08);
    const material = Math.min(10, tokenCount(player.tokens)) * (0.11 + (1 - stage) * 0.06);
    const tie = (opponent.cards.length - player.cards.length) * (0.04 + stage * 0.12);
    let best = player.score * scoreWeight + engine + material + tie - reserveOpportunityCost(player, stage);
    const options = [3, 2, 1].flatMap(tier => state.market[tier]).concat(player.reserved)
      .filter(card => knownIds.has(card.id));
    for (const card of options) {
      const price = rules.price(card, player), missing = {};
      let inaccessible = 0, total = 0;
      for (const color of COLORS) {
        missing[color] = Math.max(0, price.req[color] - player.tokens[color]);
        total += missing[color];
        inaccessible += Math.max(0, missing[color] - state.bank[color]);
      }
      if (Math.max(0, inaccessible - player.tokens.y) > 0) continue;
      const takes = Math.ceil(Math.max(0, total - player.tokens.y) / 3);
      let nobleGain = 0;
      for (const noble of state.nobles) if (COLORS.every(color =>
        (player.bonuses[color] || 0) + (card.color === color ? 1 : 0) >= (noble.req[color] || 0))) nobleGain = 3;
      const projected = player.score + card.score + nobleGain;
      const residualEngine = (card.score === 0 ? (1 - stage) * 0.4 : 0);
      const value = projected * scoreWeight - (takes + 1) * turnCost + engine + residualEngine
        - reserveOpportunityCost(player, stage);
      best = Math.max(best, value);
    }
    return best;
  }

  function decide(observation, rules, rng = 0) {
    if (!observation || !rules || !Number.isInteger(observation.self) || observation.over) {
      throw new TypeError('advanced-v1 requires a live observation and rules engine');
    }
    const self = observation.self, knownIds = knownIdsOf(observation), state = shadowState(observation);
    const actions = rules.legalActions(state, self).filter(action => ['take', 'buy', 'reserve', 'blind_reserve'].includes(action.type));
    let evaluated = 0;
    const candidates = [];
    for (const action of actions) {
      const sim = simulateFull(state, action, rules, self, knownIds);
      if (!sim.ok || sim.pending) continue;
      evaluated++;
      const candidateState = normalizeOwnTurn(sim.state, self);
      candidates.push({ action, choices: sim.choices, state: candidateState,
        quick: quickUtility(candidateState, self, rules, knownIds), value: null, route: [] });
    }
    candidates.sort((a, b) => b.quick - a.quick || JSON.stringify(a.action).localeCompare(JSON.stringify(b.action)));
    const refine = new Set(candidates.slice(0, 3));
    for (const type of ['take', 'buy', 'reserve']) {
      const candidate = candidates.find(value => type === 'reserve'
        ? value.action.type === 'reserve' || value.action.type === 'blind_reserve'
        : value.action.type === type);
      if (candidate) refine.add(candidate);
    }
    const endThreats = immediateEndThreats(state, self, rules, knownIds);
    for (const candidate of candidates) if (candidate.action.type === 'reserve' && endThreats.has(candidate.action.cardId)) refine.add(candidate);
    for (const candidate of candidates) {
      const player = candidate.state.players[self];
      if (player.score >= 15 || candidate.state.over) refine.add(candidate);
    }
    let routeNodes = 0;
    for (const candidate of refine) {
      const route = routeSearch(candidate.state, rules, self, knownIds, observation);
      routeNodes += route.explored;
      candidate.value = route.value;candidate.route = route.route;
    }
    let best = null;
    for (const candidate of candidates) {
      if (candidate.value === null) continue;
      const value = candidate.value;
      if (!best || value > best.value + 1e-9) best = { ...candidate, value };
    }
    if (!best) return { strategyId: 'advanced-v1', action: null, nextRng: rng >>> 0,
      diagnostics: { candidates: actions.length, evaluated, refined: refine.size, routeNodes } };
    return { strategyId: 'advanced-v1', action: clone(best.action), nextRng: rng >>> 0,
      settlementChoices: clone(best.choices),
      diagnostics: { candidates: actions.length, evaluated, refined: refine.size, routeNodes, value: best.value, route: [...best.route],
        refinedActions: [...refine].map(candidate => ({ action: clone(candidate.action), quick: candidate.quick,
          value: candidate.value, route: [...candidate.route] })) } };
  }

  function discardColors(observation, rules) {
    const known = knownIdsOf(observation), state = shadowState(observation), who = observation.self;
    state.rulePhase = 'discard';
    const colors = [], scratch = rules.copyState(state);
    while (tokenCount(scratch.players[who].tokens) > 10) {
      const action = rules.legalActions(scratch, who).filter(value => value.type === 'discard')
        .sort((a, b) => tokenUsefulness(scratch, who, a.color, known, rules) - tokenUsefulness(scratch, who, b.color, known, rules)
          || ALL.indexOf(a.color) - ALL.indexOf(b.color))[0];
      if (!action) break;
      colors.push(action.color);rules.executeAction(scratch, action, who);
      rules.prepareSettlement(scratch, who);
    }
    return colors;
  }

  function chooseNoble(observation, options) {
    const state = shadowState(observation);
    return chooseNobleOption(state, observation.self, options);
  }

  return Object.freeze({ strategyId: 'advanced-v1', decide, discardColors, chooseNoble,
    _internals: Object.freeze({ shadowState, acquisitionPlan, routeSearch, terminalValue }) });
});
