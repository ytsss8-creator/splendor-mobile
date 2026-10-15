/* V1 advanced heuristic. Observation-only and deterministic; embedded for standalone HTML. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplendorAdvancedAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPolicy(settings) {
  'use strict';
  settings = settings || {};
  const configuration = Object.freeze({ investment: true, topK: 6, beamWidth: 1,
    resourceNodes: 5, liquidity: false, threatConsistency: false, fallback: false,
    fastQueue: true, memoEconomy: true, rootDefense: true, ...settings });
  for (const key of ['topK', 'beamWidth', 'resourceNodes']) if (!Number.isInteger(configuration[key]) || configuration[key] < 1 || configuration[key] > 32) throw new RangeError(`Invalid ${key}`);
  const COLORS = ['w', 'u', 'g', 'r', 'k'], ALL = [...COLORS, 'y'];
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const clone = value => JSON.parse(JSON.stringify(value));
  const tokenCount = tokens => ALL.reduce((sum, color) => sum + (tokens[color] || 0), 0);
  let decisionEconomy = null;
  function economyMemo(state) {
    if (!decisionEconomy) return null;
    let entry = decisionEconomy.get(state);
    if (!entry) { entry = { remaining: [], engine: [], demand: [{}, {}], targets: [] };decisionEconomy.set(state, entry); }
    return entry;
  }
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

  function returnDiscards(bank, before, after) {
    // Resource-search settlement must return every discarded token to the bank.
    for (const color of ALL) bank[color] += before[color] - after[color];
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
    const enqueue = (next, key) => {
      if (seen.has(key)) return;
      if (configuration.fastQueue) { next.searchPriority = planPriority(next, req);next.searchKey = key; }
      seen.add(key);queue.push(next);
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
        returnDiscards(bank, tokens, nextTokens);
        const next = { ...node, tokens: nextTokens, bank,
          path: [...node.path, { action: { type: 'take', colors: [...colors] }, discardColors: ALL.flatMap(color =>
            Array.from({ length: tokens[color] - nextTokens[color] }, () => color)) }] };
        const key = compactKey(next);
        enqueue(next, key);
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
          returnDiscards(bank, tokens, nextTokens);
          const drawCounts = { ...node.drawCounts, [tier]: node.drawCounts[tier] - 1 };
          const next = { ...node, tokens: nextTokens, bank, drawCounts,
            reservedIds: [...node.reservedIds, `__unknown_${tier}_${drawCounts[tier]}`],
            path: [...node.path, { action: { type: 'blind_reserve', tier }, discardColors: ALL.flatMap(color =>
              Array.from({ length: tokens[color] - nextTokens[color] }, () => color)) }] };
          const key = compactKey(next);
          enqueue(next, key);
        }
        return;
      }
      const tokens = { ...node.tokens, y: node.tokens.y + 1 }, bank = { ...node.bank, y: node.bank.y - 1 };
      const nextTokens = targetDiscard(tokens, req, knownIds, initialPlayer, observation, who);
      returnDiscards(bank, tokens, nextTokens);
      const marketIds = node.marketIds.filter(id => id !== reserveId);
      const next = { ...node, tokens: nextTokens, bank, marketIds,
        reservedIds: [...node.reservedIds, reserveId], targetHeld: node.targetHeld || reserveId === target.id,
        path: [...node.path, { action: { type: 'reserve', cardId: reserveId }, discardColors: ALL.flatMap(color =>
          Array.from({ length: tokens[color] - nextTokens[color] }, () => color)) }] };
      const key = compactKey(next);
      enqueue(next, key);
    };
    while (queue.length && visited < nodeLimit) {
      let node;
      if (configuration.fastQueue) {
        if (visited === 0) { start.searchPriority = planPriority(start, req);start.searchKey = compactKey(start); }
        let index = 0;
        for (let i = 1; i < queue.length; i++) {
          const compare = queue[i].searchPriority - queue[index].searchPriority
            || queue[i].path.length - queue[index].path.length || queue[i].searchKey.localeCompare(queue[index].searchKey);
          if (compare < 0) index = i;
        }
        node = queue.splice(index, 1)[0];
      } else {
        queue.sort((a, b) => planPriority(a, req) - planPriority(b, req)
          || a.path.length - b.path.length || compactKey(a).localeCompare(compactKey(b)));
        node = queue.shift();
      }
      visited++;
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
    const stage = configuration.investment ? economicStage(state, who, rules, knownIds) : clamp(Math.max(player.score / 15, state.round / 18), 0, 1);
    const engine = configuration.investment ? discountDemand(state, who, target.color, knownIds) * (1 - stage) * 2.4 : target.score === 0 ? (1 - stage) * 1.2 : 0;
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
      const outcome = winner < 0 ? 0 : winner === self ? 10000 : -10000;
      return outcome + (configuration.threatConsistency ? (state.players[self].score - state.players[1 - self].score) * 0.1
        + (state.players[1 - self].cards.length - state.players[self].cards.length) * 0.001 : 0);
    }
    if (state.endTrigger && state.players[self].score >= 15 && self === 0) {
      const opponent = 1;
      const responseState = rules.copyState(state);responseState.turn = opponent;responseState.rulePhase = 'action';
      const allResponses = rules.legalActions(responseState, opponent), buys = allResponses.filter(action => action.type === 'buy');
      const responseActions = configuration.threatConsistency ? allResponses : buys.length ? buys : allResponses.slice(0, 1);
      let worst = Infinity;
      for (const action of responseActions) {
        const sim = simulateFull(responseState, action, rules, opponent, knownIds);
        if (!sim.ok || !sim.state.over) continue;
        const winner = rules.winnerSide(sim.state);
        const base = winner < 0 ? 0 : winner === self ? 10000 : -10000;
        const outcome = base + (configuration.threatConsistency ? (sim.state.players[self].score - sim.state.players[opponent].score) * 0.1
          + (sim.state.players[opponent].cards.length - sim.state.players[self].cards.length) * 0.001 : 0);
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

  function visibleTargets(state, who, knownIds) {
    const memo = economyMemo(state);if (memo?.targets[who]) return memo.targets[who];
    const targets = [3, 2, 1].flatMap(tier => state.market[tier]).concat(state.players[who].reserved).filter(card => knownIds.has(card.id));
    if (memo) memo.targets[who] = targets;
    return targets;
  }

  function resourceLowerBound(card, player, bank, bonuses = player.bonuses) {
    const missing = COLORS.map(color => Math.max(0, (card.cost[color] || 0) - (bonuses[color] || 0) - player.tokens[color]));
    let gold = player.tokens.y;
    // Gold removes concentrated color shortages before broad shortages.
    while (gold > 0 && missing.some(n => n > 0)) { const index = missing.indexOf(Math.max(...missing));missing[index]--;gold--; }
    const concentrated = Math.max(0, ...missing.map((n, i) => n - (n >= 2 && bank[COLORS[i]] >= 4 ? 1 : 0)));
    return 1 + Math.max(Math.ceil(missing.reduce((a, b) => a + b, 0) / 3), concentrated);
  }

  function remainingActions(state, who, knownIds) {
    const memo = economyMemo(state);if (memo?.remaining[who] !== undefined) return memo.remaining[who];
    const player = state.players[who], cards = visibleTargets(state, who, knownIds).filter(card => card.score > 0);
    const rates = cards.map(card => card.score / resourceLowerBound(card, player, state.bank)).sort((a, b) => b - a);
    const rate = rates.length ? rates.slice(0, 4).reduce((a, b) => a + b, 0) / Math.min(4, rates.length) : 0.7;
    const result = clamp((15 - player.score) / Math.max(0.5, rate), 1, 18);
    if (memo) memo.remaining[who] = result;
    return result;
  }

  function economicStage(state, who, rules, knownIds) {
    const own = remainingActions(state, who, knownIds), opponent = remainingActions(state, 1 - who, knownIds);
    return clamp(Math.max(Math.max(state.players[who].score, state.players[1 - who].score) / 15 * 0.7,
      1 - Math.min(own, opponent) / 18), 0, 1);
  }

  function discountDemand(state, who, color, knownIds) {
    const memo = economyMemo(state);if (memo?.demand[who][color] !== undefined) return memo.demand[who][color];
    const player = state.players[who], targets = visibleTargets(state, who, knownIds).filter(card => card.score > 0);
    let demand = 0, total = 0;
    for (const card of targets) {
      const weight = (card.score + 1) / resourceLowerBound(card, player, state.bank);
      total += weight;if ((card.cost[color] || 0) > (player.bonuses[color] || 0)) demand += weight;
    }
    const noble = state.nobles.some(n => (n.req[color] || 0) > (player.bonuses[color] || 0)
      && COLORS.reduce((s,c) => s + Math.max(0, (n.req[c] || 0) - player.bonuses[c]), 0) <= 5);
    const result = (total ? demand / total : 0) + (noble ? 0.2 : 0);
    if (memo) memo.demand[who][color] = result;
    return result;
  }

  function engineResidual(state, who, rules, knownIds, stage) {
    const memo = economyMemo(state);if (memo?.engine[who] !== undefined) return memo.engine[who];
    const player = state.players[who], targets = visibleTargets(state, who, knownIds).filter(card => card.score > 0);
    let saving = 0, totalWeight = 0, scoreMean = 0;
    for (const card of targets) {
      const after = resourceLowerBound(card, player, state.bank), before = resourceLowerBound(card, player, state.bank, {});
      const weight = (card.score + 1) / after;
      saving += Math.max(0, before - after) * weight;totalWeight += weight;scoreMean += card.score * weight;
    }
    const horizon = Math.min(remainingActions(state, who, knownIds), remainingActions(state, 1 - who, knownIds));
    const futureBuys = totalWeight ? Math.min(horizon / 2, (15 - player.score) / Math.max(1, scoreMean / totalWeight), 6) : 0;
    const discounts = totalWeight ? saving / totalWeight * futureBuys * (2.5 + 1.0 * (1 - stage)) : 0;
    // Noble distance provides contingent value, never a compulsory route.
    const noble = state.nobles.reduce((best, n) => {
      const distance = COLORS.reduce((s,c) => s + Math.max(0, (n.req[c] || 0) - player.bonuses[c]), 0);
      return Math.max(best, distance > 0 && distance <= horizon ? 12 * Math.exp(-distance * 0.55) * (1 - stage * 0.5) : 0);
    }, 0);
    const result = discounts + noble;
    if (memo) memo.engine[who] = result;
    return result;
  }

  function reserveLiability(state, who, knownIds) {
    const player = state.players[who];let liability = 0, slow = 0;
    for (const card of player.reserved) {
      if (!knownIds.has(card.id)) { liability += 1.5;slow++;continue; }
      const effort = resourceLowerBound(card, player, state.bank);
      const blocked = COLORS.reduce((s,c) => s + Math.max(0, (card.cost[c] || 0) - player.bonuses[c] - player.tokens[c] - state.bank[c]), 0) > player.tokens.y;
      liability += Math.max(0, effort - 1) * 0.65 + (blocked ? 1.5 : 0);
      slow += Number(effort > 2 || blocked);
    }
    if (player.reserved.length === 3) liability += 1.5 + slow * 1.5;
    return liability;
  }

  function reserveAssessment(before, after, action, self, rules, knownIds, endThreats) {
    if (!['reserve', 'blind_reserve'].includes(action.type)) return null;
    if (action.type === 'reserve' && endThreats.has(action.cardId)) return { kind: 'defense', effort: null, realizationProxy: null, penalty: 0 };
    const card = action.type === 'reserve' ? after.players[self].reserved.find(c => c.id === action.cardId) : null;
    const effort = card ? resourceLowerBound(card, after.players[self], after.bank) : null;
    const demand = card ? discountDemand(after, self, card.color, knownIds) : 0;
    const target = card && effort <= 3 && (card.score > 0 || demand > 0.5);
    const receivedGold = after.players[self].tokens.y > before.players[self].tokens.y;
    let saving = 0;
    for (const goal of visibleTargets(before, self, knownIds).filter(c => c.score > 0)) {
      saving = Math.max(saving, resourceLowerBound(goal, before.players[self], before.bank)
        - resourceLowerBound(goal, after.players[self], after.bank) - 1);
    }
    return { kind: target ? 'target' : 'resource', effort,
      realizationProxy: effort === null ? 0 : 1 / effort,
      // This is a feasibility proxy, not a calibrated probability. Gold must
      // cover its reserve action before offsetting the resource-reserve cost.
      penalty: target ? 0.25 : Math.max(0, 1.5 - Math.max(0, saving) * 1.2) + (receivedGold ? 0 : 1.5) };
  }

  function actionWaste(before, after, action, choices, self, rules, knownIds) {
    if (action.type !== 'take') return 0;
    let bestReduction = 0;
    for (const card of visibleTargets(before, self, knownIds)) bestReduction = Math.max(bestReduction,
      rules.price(card, before.players[self]).left - rules.price(card, after.players[self]).left);
    const discards = (choices.discardColors || []).reduce((s,c) => s + (c === 'y' ? 1.5 : 0.18), 0);
    return discards + (bestReduction <= 0 ? 1.5 : 0);
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
    if (configuration.threatConsistency && state.endTrigger && self === 1) return threats;
    if (state.players[opponent].score < 10) return threats;
    const forecast = rules.copyState(state);forecast.turn = opponent;forecast.rulePhase = 'action';
    for (const action of rules.legalActions(forecast, opponent)) {
      if (action.type !== 'buy') continue;
      const result = simulateFull(forecast, action, rules, opponent, knownIds);
      if (result.ok && (result.state.over || result.state.endTrigger)) threats.add(action.cardId);
    }
    return threats;
  }

  function nextEndOutcome(state, self, rules, knownIds) {
    if (state.over || state.endTrigger && self === 0 && state.players[self].score >= 15) return 1;
    const opponent = 1 - self, player = state.players[opponent];
    if (player.score < 7) return 1;
    const forecast = rules.copyState(state);forecast.turn = opponent;forecast.rulePhase = 'action';
    const all = rules.legalActions(forecast, opponent), alreadyEligible = rules.eligible(forecast, opponent).length > 0;
    const actions = alreadyEligible ? all.filter(a => a.type !== 'take').concat(all.filter(a => a.type === 'take').slice(0, 1)) : all.filter(a => a.type === 'buy');
    let worst = 1;
    for (const action of actions) {
      if (action.type === 'buy') {
        const card = rules.findCard(forecast, action.cardId, opponent);
        const noble = forecast.nobles.some(n => COLORS.every(c => player.bonuses[c] + (card.color === c ? 1 : 0) >= (n.req[c] || 0))) ? 3 : 0;
        if (player.score + card.score + noble < 15 && !forecast.endTrigger) continue;
      } else if (player.score + 3 < 15) continue;
      const sim = simulateFull(forecast, action, rules, opponent, knownIds);
      if (!sim.ok || sim.pending || !sim.state.over && !sim.state.endTrigger) continue;
      if (sim.state.over) {
        const winner = rules.winnerSide(sim.state);worst = Math.min(worst, winner < 0 ? 0 : winner === self ? 1 : -1);
      } else {
        // Only the mandatory classic final reply; no further opponent plies.
        const replies = rules.legalActions(sim.state, self);let best = -1;
        for (const reply of replies) {
          const response = simulateFull(sim.state, reply, rules, self, knownIds);
          if (!response.ok || response.pending || !response.state.over) continue;
          const winner = rules.winnerSide(response.state);best = Math.max(best, winner < 0 ? 0 : winner === self ? 1 : -1);
          if (best === 1) break;
        }
        worst = Math.min(worst, best);
      }
      if (worst === -1) break;
    }
    return worst;
  }

  function publicEndDistance(state, self) {
    const opponent = state.players[1 - self];let distance = Infinity;
    for (const card of [3, 2, 1].flatMap(t => state.market[t]).concat(opponent.reserved).filter(c => !c.id.startsWith('__'))) {
      const noble = state.nobles.some(n => COLORS.every(c => opponent.bonuses[c] + (card.color === c ? 1 : 0) >= (n.req[c] || 0))) ? 3 : 0;
      if (opponent.score + card.score + noble >= 15) distance = Math.min(distance, resourceLowerBound(card, opponent, state.bank));
    }
    return distance;
  }

  function stateUtility(state, cost, self, rules, knownIds, includeThreat = false, deadline = Infinity) {
    const terminal = terminalValue(state, self, rules, knownIds);
    if (terminal !== null && configuration.threatConsistency && cost > 0) {
      // Projected own turns omit opponent development. Reaching 15 in that
      // forecast is a finite race estimate, never a guaranteed actual win.
      const score = state.players[self].score;
      return score * 10.4 - cost * 2.35 + 60 / (1 + cost)
        - Math.max(0, cost - deadline + 1) * 20 - (terminal < 0 ? 300 : 0);
    }
    if (terminal !== null) return terminal - cost * 45;
    const player = state.players[self], opponent = state.players[1 - self];
    const stage = configuration.investment ? economicStage(state, self, rules, knownIds) : clamp(Math.max((player.score + opponent.score) / 30, state.round / 18), 0, 1);
    const scoreWeight = 7.2 + 3.2 * stage;
    const turnCost = 1.25 + 1.1 * stage;
    const discounts = COLORS.reduce((sum, color) => sum + (player.bonuses[color] || 0), 0);
    const engineWeight = 1.65 * (1 - stage) ** 2 + 0.08;
    const tiePotential = (opponent.cards.length - player.cards.length) * (0.04 + stage * 0.12);
    const material = Math.min(10, tokenCount(player.tokens)) * (0.11 + (1 - stage) * 0.06);
    const engine = configuration.investment ? engineResidual(state, self, rules, knownIds, stage) : discounts * engineWeight;
    return player.score * scoreWeight - cost * turnCost + engine + material + tiePotential
      - reserveOpportunityCost(player, stage) - (configuration.liquidity ? reserveLiability(state, self, knownIds) : 0)
      + (includeThreat && !configuration.threatConsistency ? opponentThreatPenalty(state, self, rules, knownIds) : 0);
  }

  function routeSearch(state, rules, self, knownIds, observation) {
    const deadline = configuration.threatConsistency ? publicEndDistance(state, self) : Infinity;
    const initialTerminal = terminalValue(state, self, rules, knownIds);
    if (initialTerminal !== null) return { value: initialTerminal, route: [], explored: 0 };
    let best = { value: stateUtility(state, 0, self, rules, knownIds, true), route: [], projectedScore: state.players[self].score }, explored = 0;
    let beam = [{ state, cost: 0, route: [] }];
    for (let depth = 0; depth < 3; depth++) {
      const children = [];
      for (const node of beam) {
        const targets = relevantTargets(node.state, rules, self, knownIds).slice(0, depth === 2 ? 1 : 2);
        for (const target of targets) {
          const plan = acquisitionPlan(node.state, target, rules, self, knownIds, observation, configuration.resourceNodes);
          explored += plan?.visited || 1;
          if (!plan || node.cost + plan.turns + 1 > 14) continue;
          const transition = applyPlanAndBuy(node.state, target, plan, rules, self, observation, knownIds);
          if (!transition) continue;
          const cost = node.cost + plan.turns + 1, route = [...node.route, target.id];
          const value = stateUtility(transition.state, cost, self, rules, knownIds, false, deadline);
          if (value > best.value) best = { value, route, cost, projectedScore: transition.state.players[self].score };
          children.push({ state: transition.state, cost, route, value });
        }
      }
      children.sort((a, b) => b.value - a.value || a.cost - b.cost || a.route.join('|').localeCompare(b.route.join('|')));
      beam = children.slice(0, configuration.beamWidth);
      if (!beam.length) break;
    }
    // If the narrow route cannot finish, test two omitted known targets as
    // standalone purchases. This is a bounded partial-route fallback.
    if (configuration.fallback && best.projectedScore < 15) {
      for (const target of relevantTargets(state, rules, self, knownIds).slice(2, 4)) {
        const plan = acquisitionPlan(state, target, rules, self, knownIds, observation, configuration.resourceNodes);
        explored += plan?.visited || 1;
        if (!plan) continue;
        const transition = applyPlanAndBuy(state, target, plan, rules, self, observation, knownIds);
        if (!transition) continue;
        const cost = plan.turns + 1, value = stateUtility(transition.state, cost, self, rules, knownIds, false, deadline);
        if (value > best.value) best = { value, route: [target.id], cost, projectedScore: transition.state.players[self].score };
      }
    }
    return { ...best, explored };
  }

  function quickUtility(state, self, rules, knownIds) {
    const terminal = terminalValue(state, self, rules, knownIds);
    if (terminal !== null) return terminal;
    const player = state.players[self], opponent = state.players[1 - self];
    const stage = configuration.investment ? economicStage(state, self, rules, knownIds) : clamp(Math.max((player.score + opponent.score) / 30, state.round / 18), 0, 1);
    const scoreWeight = 7.2 + 3.2 * stage, turnCost = 1.25 + 1.1 * stage;
    const discounts = COLORS.reduce((sum, color) => sum + (player.bonuses[color] || 0), 0);
    const engine = configuration.investment ? engineResidual(state, self, rules, knownIds, stage) : discounts * (1.65 * (1 - stage) ** 2 + 0.08);
    const material = Math.min(10, tokenCount(player.tokens)) * (0.11 + (1 - stage) * 0.06);
    const tie = (opponent.cards.length - player.cards.length) * (0.04 + stage * 0.12);
    const liability = configuration.liquidity ? reserveLiability(state, self, knownIds) : 0;
    let best = player.score * scoreWeight + engine + material + tie - reserveOpportunityCost(player, stage) - liability;
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
      const residualEngine = configuration.investment ? discountDemand(state, self, card.color, knownIds) * (1 - stage) * 2.4 : (card.score === 0 ? (1 - stage) * 0.4 : 0);
      const value = projected * scoreWeight - (takes + 1) * turnCost + engine + residualEngine
        - reserveOpportunityCost(player, stage) - liability;
      best = Math.max(best, value);
    }
    return best;
  }

  function computeDecision(observation, rules, rng = 0) {
    if (!observation || !rules || !Number.isInteger(observation.self) || observation.over) {
      throw new TypeError('advanced-v1 requires a live observation and rules engine');
    }
    const self = observation.self, knownIds = knownIdsOf(observation), state = shadowState(observation);
    const endThreats = immediateEndThreats(state, self, rules, knownIds);
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
      const candidate = candidates[candidates.length - 1];
      candidate.reserve = configuration.liquidity ? reserveAssessment(state, candidateState, action, self, rules, knownIds, endThreats) : null;
      candidate.penalty = configuration.liquidity ? (candidate.reserve?.penalty || 0)
        + actionWaste(state, candidateState, action, sim.choices, self, rules, knownIds) : 0;
      candidate.endOutcome = configuration.threatConsistency ? nextEndOutcome(candidateState, self, rules, knownIds) : 1;
      candidate.riskPenalty = candidate.endOutcome < 0 ? 10000 : candidate.endOutcome === 0 ? 500 : 0;
      candidate.penalty += candidate.riskPenalty;
      candidate.quick -= candidate.penalty;
    }
    candidates.sort((a, b) => b.quick - a.quick || JSON.stringify(a.action).localeCompare(JSON.stringify(b.action)));
    const refine = new Set(candidates.slice(0, configuration.topK));
    for (const type of ['take', 'buy', 'reserve']) {
      const candidate = candidates.find(value => type === 'reserve'
        ? value.action.type === 'reserve' || value.action.type === 'blind_reserve'
        : value.action.type === type);
      if (candidate) refine.add(candidate);
    }
    for (const candidate of candidates) if ((candidate.action.type === 'reserve' || configuration.rootDefense && candidate.action.type === 'buy') && endThreats.has(candidate.action.cardId)) refine.add(candidate);
    for (const candidate of candidates) {
      const player = candidate.state.players[self];
      if (player.score >= 15 || candidate.state.over) refine.add(candidate);
    }
    let routeNodes = 0;
    for (const candidate of refine) {
      const route = routeSearch(candidate.state, rules, self, knownIds, observation);
      routeNodes += route.explored;
      candidate.value = route.value - candidate.penalty;candidate.route = route.route;
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
        ...(configuration.liquidity ? { reserveKind: best.reserve?.kind, reserveAssessment: best.reserve } : {}),
        ...(configuration.threatConsistency ? { endOutcome: best.endOutcome,
          forcedLoss: candidates.every(c => c.endOutcome < 0 || terminalValue(c.state, self, rules, knownIds) !== null
            && terminalValue(c.state, self, rules, knownIds) < 0) } : {}),
        refinedActions: [...refine].map(candidate => ({ action: clone(candidate.action), quick: candidate.quick,
          value: candidate.value, route: [...candidate.route] })) } };
  }

  function decide(observation, rules, rng = 0) {
    decisionEconomy = configuration.memoEconomy ? new WeakMap() : null;
    try { return computeDecision(observation, rules, rng); } finally { decisionEconomy = null; }
  }

  function evaluateAction(observation, rules, action) {
    const self = observation.self, knownIds = knownIdsOf(observation), state = shadowState(observation);
    const sim = simulateFull(state, action, rules, self, knownIds);if (!sim.ok || sim.pending) return null;
    const next = normalizeOwnTurn(sim.state, self), threats = immediateEndThreats(state, self, rules, knownIds);
    const reserve = configuration.liquidity ? reserveAssessment(state, next, action, self, rules, knownIds, threats) : null;
    const outcome = configuration.threatConsistency ? nextEndOutcome(next, self, rules, knownIds) : 1;
    const penalty = (configuration.liquidity ? (reserve?.penalty || 0) + actionWaste(state, next, action, sim.choices, self, rules, knownIds) : 0)
      + (outcome < 0 ? 10000 : outcome === 0 ? 500 : 0);
    const route = routeSearch(next, rules, self, knownIds, observation);
    return { value: route.value - penalty, route: route.route };
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

  return Object.freeze({ strategyId: 'advanced-v1', decide, discardColors, chooseNoble, create: createPolicy, configuration,
    _internals: Object.freeze({ shadowState, knownIdsOf, acquisitionPlan, applyPlanAndBuy, simulateFull,
      routeSearch, terminalValue, economicStage, engineResidual, resourceLowerBound,
      nextEndOutcome, publicEndDistance, evaluateAction, reserveAssessment, reserveLiability }) });
});
