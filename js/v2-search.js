/* P4.B1 observation-only V2 framework with bounded two-ply selection. */
(function (root, factory) {
  const Advanced = typeof module === 'object' && module.exports
    ? require('./advanced-v1.js') : root.SplendorAdvancedAI;
  const Hybrid = typeof module === 'object' && module.exports
    ? require('./hybrid-v1.js') : root.SplendorHybridAI;
  const api = factory(Advanced, Hybrid);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplendorV2Search = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Advanced, Hybrid) {
  'use strict';

  const COLORS = ['w', 'u', 'g', 'r', 'k'];
  const ALL = [...COLORS, 'y'];
  const ACTION_TYPES = new Set(['take', 'buy', 'reserve', 'blind_reserve']);
  const clone = value => JSON.parse(JSON.stringify(value));
  const cardKey = card => card && typeof card.id === 'string' ? card.id : '';
  const isAbstract = card => cardKey(card).startsWith('__');
  const actionKey = action => JSON.stringify(action);
  const clockNow = () => typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() : Date.now();

  function create(settings = {}) {
    if (!Advanced?._internals?.shadowState || !Hybrid?.create) {
      throw new Error('V2 requires the observation adapter and Hybrid C fallback');
    }
    const fallbackConfiguration = Object.freeze({ terminal: true, reservation: true, scoring: true,
      reservationRouteFix: true, zeroProgressComparison: true, planNodes: 16 });
    const configuration = Object.freeze({ enabled: false, mode: 'minimax', tacticalTrigger: false,
      endgameRaceEvaluation: false,
      rootTopK: 6, responseTopK: 4, maxNodes: 320, maxExpansions: 320,
      timeBudgetMs: 180, uncertaintyPenalty: 0.75, debug: true,
      ...settings, fallback: fallbackConfiguration });
    validateConfiguration(configuration);
    const fallback = Hybrid.create(configuration.fallback);

    function validateConfiguration(options) {
      if (typeof options.enabled !== 'boolean' || typeof options.tacticalTrigger !== 'boolean'
        || typeof options.endgameRaceEvaluation !== 'boolean'
        || !['off', 'score', 'minimax'].includes(options.mode)
        || !Number.isInteger(options.rootTopK) || options.rootTopK < 1
        || !Number.isInteger(options.responseTopK) || options.responseTopK < 1
        || !Number.isInteger(options.maxNodes) || options.maxNodes < 1
        || !Number.isInteger(options.maxExpansions) || options.maxExpansions < 1
        || !Number.isFinite(options.timeBudgetMs) || options.timeBudgetMs <= 0
        || !Number.isFinite(options.uncertaintyPenalty) || options.uncertaintyPenalty < 0
        || typeof options.debug !== 'boolean') throw new RangeError('Invalid V2 search configuration');
    }

    function createTracker(options, startedAt) {
      const stats = { nodes: 0, expansions: 0, evaluations: 0, legalActionsEnumerated: 0,
        v2RuleSimulations: 0, stateCopies: 0, actionExecutions: 0,
        tacticalRuleSimulations: 0,
        settlementAttempts: 0, settlementCompletions: 0, failedLegalSimulations: 0,
        sortComparisons: 0, rootCandidates: 0, opponentResponses: 0, selectedRootCandidates: 0,
        selectedOpponentResponses: 0, tacticalRootActions: 0, tacticalOpponentResponses: 0,
        incompleteResponseSets: 0, uncertaintyAffectedRoots: 0, uncertainMarketRefills: 0,
        uncertainReserveOutcomes: 0, maxDepthReached: 0,
        rootCandidateMs: 0, opponentCandidateMs: 0, settlementMs: 0, tacticalTriggerMs: 0,
        ruleSimulationMs: 0, positionEvaluationMs: 0,
        endgameRaceEvaluationMs: 0, endgameRaceEvaluationCalls: 0,
        endgameRaceEvaluatedPositions: 0, endgameRaceRuleSimulations: 0,
        endgameRaceCacheHits: 0, endgameRaceUnknownTargets: 0 };
      const endgameRaceCache = new WeakMap();
      let abortReason = null;
      const abort = reason => { abortReason = reason;throw Object.assign(new Error(reason), { v2BudgetAbort: true }); };
      const check = () => {
        if (abortReason) abort(abortReason);
        if (clockNow() - startedAt >= options.timeBudgetMs) abort('time_budget');
      };
      return {
        stats,
        endgameRaceCache,
        endgameRaceEnabled: options.endgameRaceEvaluation,
        check,
        get abortReason() { return abortReason; },
        expansion() {
          check();
          if (stats.expansions >= options.maxExpansions) abort('max_expansions');
          stats.expansions++;
        },
        node() {
          check();
          if (stats.nodes >= options.maxNodes) abort('max_nodes');
          stats.nodes++;
        },
        evaluation() { check();stats.evaluations++;check(); },
        simulation() { check();stats.v2RuleSimulations++; },
        tacticalSimulation() { check();stats.tacticalRuleSimulations++; },
        endgameRaceEvaluation() { check();stats.endgameRaceEvaluationCalls++; },
        endgameRacePosition() { check();stats.endgameRaceEvaluatedPositions++; },
        endgameRaceSimulation() { check();stats.endgameRaceRuleSimulations++; },
        endgameRaceUnknownTarget() { stats.endgameRaceUnknownTargets++; },
        endgameRaceCacheHit() { stats.endgameRaceCacheHits++; },
        failedSimulation() { stats.failedLegalSimulations++; },
        time(key, elapsed) { stats[key] += elapsed; },
        enumerated(count) { stats.legalActionsEnumerated += count;check(); },
        comparison() { stats.sortComparisons++;check(); },
        reachedDepth(depth) { stats.maxDepthReached = Math.max(stats.maxDepthReached, depth);check(); },
        copyState() { stats.stateCopies++;check(); },
        executeAction() { stats.actionExecutions++;check(); },
        settlementAttempt() { stats.settlementAttempts++;check(); },
        settlementComplete() { stats.settlementCompletions++;check(); },
      };
    }

    function copyState(state, rules, tracker) {
      tracker?.copyState();
      return rules.copyState(state);
    }

    function executeAction(state, action, who, rules, tracker) {
      tracker?.executeAction();
      return rules.executeAction(state, action, who);
    }

    function knownIdsFor(state, who, observer) {
      const ids = new Set([3, 2, 1].flatMap(tier => state.market[tier]
        .filter(card => !isAbstract(card)).map(card => card.id)));
      // A player can know its own blind reservation; the other player cannot.
      for (const card of state.players[who].reserved) {
        if (!isAbstract(card) && (who === observer || !card.blindReserved)) ids.add(card.id);
      }
      return ids;
    }

    function visibleGoals(state, who, observer, includeReserved = true) {
      const known = knownIdsFor(state, who, observer);
      const cards = [3, 2, 1].flatMap(tier => state.market[tier]);
      if (includeReserved) cards.push(...state.players[who].reserved);
      return cards.filter(card => known.has(card.id) && !isAbstract(card));
    }

    // A conservative distance proxy. It checks whether the bank can supply
    // each missing color, then estimates the number of three-token takes.
    // It never expands a purchase route or examines a hidden draw.
    function purchaseDistance(state, player, card, rules) {
      const price = rules.price(card, player);
      let missing = 0, bankReachable = 0;
      for (const color of COLORS) {
        const need = Math.max(0, price.req[color] - (player.tokens[color] || 0));
        missing += need;
        bankReachable += Math.min(need, state.bank[color] || 0);
      }
      const unavailable = missing - bankReachable;
      if (unavailable > (player.tokens.y || 0)) return Infinity;
      const takes = Math.ceil(Math.max(0, missing - (player.tokens.y || 0)) / 3);
      return 1 + takes;
    }

    const ENDGAME_RACE_THRESHOLD = 10;
    const ENDGAME_RACE_WEIGHT = 0.28;
    const ENDGAME_RACE_FINISH_PRESSURE = 0.75;

    function raceTargets(state, who, observer) {
      const known = knownIdsFor(state, who, observer);
      const targets = [3, 2, 1].flatMap(tier => state.market[tier]
        .filter(card => !isAbstract(card)).map(card => ({ card, market: true })));
      let unknownReservations = 0;
      for (const card of state.players[who].reserved) {
        if (isAbstract(card) || card.blindReserved && who !== observer) {
          // Opaque reservations are counted as uncertainty only; their identity is never inspected.
          unknownReservations++;
        } else if (known.has(card.id)) targets.push({ card, market: false });
      }
      return { targets, unknownReservations };
    }

    function publicNobleAfterBuy(state, player, card) {
      const bonus = { ...player.bonuses, [card.color]: (player.bonuses[card.color] || 0) + 1 };
      return state.nobles.some(noble => COLORS.every(color =>
        (bonus[color] || 0) >= (noble.req[color] || 0)));
    }

    // This is a bounded route estimate over the current bank and a single visible
    // target. If the bank is short, later token returns are unknown, so the route
    // stays finite and is explicitly marked uncertain rather than declared impossible.
    function estimateRacePurchase(state, player, card, rules, bonusOverride = null) {
      const pricedPlayer = bonusOverride ? { ...player, bonuses: bonusOverride } : player;
      const price = rules.price(card, pricedPlayer);
      const deficits = Object.fromEntries(COLORS.map(color => [color,
        Math.max(0, price.req[color] - (player.tokens[color] || 0))]));
      let remaining = price.left;
      let gold = player.tokens.y || 0;
      const colorsByScarcity = [...COLORS].sort((a, b) =>
        (state.bank[a] || 0) - (state.bank[b] || 0) || COLORS.indexOf(a) - COLORS.indexOf(b));
      for (const color of colorsByScarcity) {
        const used = Math.min(gold, deficits[color]);
        deficits[color] -= used;gold -= used;
      }
      const bankNeed = Object.fromEntries(COLORS.map(color => [color,
        Math.min(deficits[color], state.bank[color] || 0)]));
      const bankReachable = Object.values(bankNeed).reduce((sum, value) => sum + value, 0);
      const unresolved = Math.max(0, remaining - bankReachable);
      const bankLimited = unresolved > 0;
      const bank = { ...state.bank };
      const available = COLORS.filter(color => bank[color] > 0);
      const wanted = available.filter(color => bankNeed[color] > 0);
      const slots = Math.min(3, available.length);
      const uniquePick = wanted.slice(0, slots);
      for (const color of available) if (uniquePick.length < slots && !uniquePick.includes(color)) uniquePick.push(color);
      const uniqueLegal = !!uniquePick.length && rules.canTake({ bank }, uniquePick);
      const legalDouble = color => bank[color] >= 4 && rules.canTake({ bank }, [color, color]);
      let doubleActions = 0, singleTokens = 0, maximumSinglesForOneColor = 0;
      for (const color of COLORS) {
        let usable = bankNeed[color];
        if (usable >= 2 && legalDouble(color)) { doubleActions++;usable -= 2; }
        singleTokens += usable;
        maximumSinglesForOneColor = Math.max(maximumSinglesForOneColor, usable);
      }
      const legalSlots = uniqueLegal ? slots : 0;
      const singleRounds = legalSlots
        ? Math.max(maximumSinglesForOneColor, Math.ceil(singleTokens / legalSlots)) : 0;
      let takes = doubleActions + singleRounds;
      if (unresolved) takes += Math.ceil(unresolved / Math.max(1, legalSlots)) + 1;
      const tokenTotal = ALL.reduce((sum, color) => sum + (player.tokens[color] || 0), 0);
      const handCapPressure = tokenTotal >= 10 && remaining > 0;
      if (handCapPressure) takes += 0.5;
      return { turns: 1 + takes, takeTurns: takes, bankLimited: bankLimited || unresolved > 0,
        handCapPressure, direct: remaining === 0, tokensNeeded: remaining };
    }

    function visibleRaceScenario(state, who, card, isMarket) {
      const players = state.players.map((player, side) => ({
        score: player.score, tokens: { ...player.tokens }, bonuses: { ...player.bonuses },
        // P1's terminal tiebreak only needs public development-card counts.
        cards: new Array(player.cards.length).fill(null),
        nobles: new Array(player.nobles.length).fill(null),
        reserved: side === who && !isMarket ? [clone(card)] : [],
      }));
      const market = { 1: [], 2: [], 3: [] };
      if (isMarket) market[card.tier] = [clone(card)];
      return { bank: { ...state.bank }, market,
        // A market purchase removes the target. Empty piles deliberately prevent
        // any hypothetical action from drawing or observing a hidden refill.
        deck: { 1: [], 2: [], 3: [] }, players,
        nobles: state.nobles.map(noble => clone(noble)), turn: who, round: state.round,
        over: false, endTrigger: !!state.endTrigger, rulePhase: 'action' };
    }

    function simulateVisibleRacePurchase(state, who, observer, card, rules, tracker = null) {
      tracker?.check();
      tracker?.endgameRaceSimulation();
      const isMarket = [1, 2, 3].some(tier => state.market[tier]
        .some(value => !isAbstract(value) && value.id === card.id));
      const scratch = visibleRaceScenario(state, who, card, isMarket);
      const tokenTotalsBefore = Object.fromEntries(ALL.map(color => [color,
        scratch.bank[color] + scratch.players[0].tokens[color] + scratch.players[1].tokens[color]]));
      const beforeScore = scratch.players[who].score, beforeNobles = scratch.players[who].nobles.length;
      const action = { type: 'buy', cardId: card.id };
      const applied = rules.executeAction(scratch, action, who);
      if (!applied.ok) return { legal: false, scoreGain: 0, nobleGain: 0, over: false,
        finalResponseRemaining: false, winnerSide: null };
      let pending = rules.prepareSettlement(scratch, who), guard = 0;
      while (pending.type !== 'complete' && guard++ < 12) {
        tracker?.check();
        if (pending.type === 'discard') {
          const discard = rules.legalActions(scratch, who).find(candidate => candidate.type === 'discard');
          if (!discard || !rules.executeAction(scratch, discard, who).ok) return { legal: false,
            scoreGain: 0, nobleGain: 0, over: false, finalResponseRemaining: false, winnerSide: null };
        } else if (pending.type === 'noble') {
          const noble = { type: 'noble', id: pending.options[0] };
          if (!rules.executeAction(scratch, noble, who).ok) return { legal: false,
            scoreGain: 0, nobleGain: 0, over: false, finalResponseRemaining: false, winnerSide: null };
        } else return { legal: false, scoreGain: 0, nobleGain: 0, over: false,
          finalResponseRemaining: false, winnerSide: null };
        pending = rules.prepareSettlement(scratch, who);
      }
      if (pending.type !== 'complete') return { legal: false, scoreGain: 0, nobleGain: 0,
        over: false, finalResponseRemaining: false, winnerSide: null };
      const advanced = rules.advanceTurn(scratch, who);
      if (!advanced.ok) return { legal: false, scoreGain: 0, nobleGain: 0,
        over: false, finalResponseRemaining: false, winnerSide: null };
      return { legal: true, scoreGain: scratch.players[who].score - beforeScore,
        nobleGain: scratch.players[who].nobles.length - beforeNobles,
        over: scratch.over, endTrigger: scratch.endTrigger,
        finalResponseRemaining: !!scratch.endTrigger && !scratch.over,
        tokensAfter: { ...scratch.players[who].tokens },
        tokenCountAfter: ALL.reduce((sum, color) => sum + scratch.players[who].tokens[color], 0),
        tokenConserved: ALL.every(color => tokenTotalsBefore[color] === scratch.bank[color]
          + scratch.players[0].tokens[color] + scratch.players[1].tokens[color]),
        winnerSide: scratch.over ? rules.winnerSide(scratch) : null };
    }

    function evaluateEndgameRace(state, rootPlayer, rules, tracker = null) {
      tracker?.endgameRaceEvaluation();
      const cached = tracker?.endgameRaceCache.get(state);
      if (cached) { tracker.endgameRaceCacheHit();return cached; }
      const targetSets = [0, 1].map(who => raceTargets(state, who, rootPlayer));
      const unknownMarketCards = [1, 2, 3].reduce((sum, tier) => sum
        + state.market[tier].filter(isAbstract).length, 0);
      const unknownFutureRefillTiers = [1, 2, 3].filter(tier => state.deck[tier].length > 0);
      const unknownReservations = targetSets.reduce((sum, set) => sum + set.unknownReservations, 0);
      const eligibleForActivation = state.players.some(player => player.score >= ENDGAME_RACE_THRESHOLD)
        || !!state.endTrigger || state.players.some((player, who) => targetSets[who].targets.some(({ card }) => {
          if (rules.price(card, player).left !== 0) return false;
          const noble = publicNobleAfterBuy(state, player, card);
          return player.score + card.score + (noble ? 3 : 0) >= 15;
        }));
      if (unknownMarketCards) for (let count = 0; count < unknownMarketCards; count++) tracker?.endgameRaceUnknownTarget();
      if (!eligibleForActivation) {
        const inactive = { active: false, threshold: ENDGAME_RACE_THRESHOLD,
          valueByPlayer: [0, 0], bestRoutes: [null, null], discountShortcuts: [null, null],
          unknownMarketCards, unknownFutureRefillTiers, unknownReservations,
          finalResponseState: !!state.endTrigger };
        tracker?.endgameRaceCache.set(state, inactive);
        return inactive;
      }
      tracker?.endgameRacePosition();
      const playerValues = [], bestRoutes = [], discountShortcuts = [];
      for (const who of [0, 1]) {
        tracker?.check();
        const player = state.players[who], gap = Math.max(0, 15 - player.score);
        const { targets } = targetSets[who];
        const distanceByCard = new Map();
        const routeRows = targets.filter(({ card }) => card.score > 0
          || publicNobleAfterBuy(state, player, card)).map(({ card, market }) => {
          tracker?.check();
          const distance = estimateRacePurchase(state, player, card, rules);
          distanceByCard.set(card.id, distance);
          const noblePotential = publicNobleAfterBuy(state, player, card) ? 3 : 0;
          let scoreGain = card.score + noblePotential, direct = distance.direct;
          let exact = null;
          if (direct && (noblePotential > 0 || player.score + card.score >= 15 || state.endTrigger)) {
            exact = simulateVisibleRacePurchase(state, who, rootPlayer, card, rules, tracker);
            if (exact.legal) {
              scoreGain = exact.scoreGain;
            }
          }
          const pointsTowardFinish = Math.min(gap, scoreGain);
          const turns = Math.max(1, distance.turns);
          const pointsValue = pointsTowardFinish / Math.pow(turns, 1.25);
          const finishPressure = gap > 0 && scoreGain >= gap
            ? ENDGAME_RACE_FINISH_PRESSURE / turns : 0;
          const threatenedMarket = market && (who !== state.turn || turns > 1);
          const availability = threatenedMarket ? 0.72 : 1;
          const value = availability * (ENDGAME_RACE_WEIGHT * pointsValue + finishPressure);
          return { cardId: card.id, scoreGain, turns, takeTurns: distance.takeTurns,
            direct, bankLimited: distance.bankLimited, handCapPressure: distance.handCapPressure,
            noblePotential: exact?.legal ? exact.nobleGain > 0 : noblePotential > 0,
            pointsTowardFinish, finishPressure: finishPressure > 0,
            threatenedMarket, finalResponseRemaining: exact?.finalResponseRemaining || false,
            immediateTerminal: exact?.over || false, value };
        }).sort((a, b) => b.value - a.value || a.cardId.localeCompare(b.cardId));
        const best = routeRows[0] || null;

        let bestShortcut = null;
        for (const { card: development, market } of targets) {
          if (development.score !== 0) continue;
          const purchase = estimateRacePurchase(state, player, development, rules);
          const nextBonuses = { ...player.bonuses,
            [development.color]: (player.bonuses[development.color] || 0) + 1 };
          let shortened = 0, targetId = null;
          for (const { card: target } of targets) {
            if ((target.score <= 0 && !publicNobleAfterBuy(state, player, target))
              || target.id === development.id) continue;
            const before = distanceByCard.get(target.id)?.turns
              ?? estimateRacePurchase(state, player, target, rules).turns;
            const after = estimateRacePurchase(state, player, target, rules, nextBonuses).turns;
            if (before - after > shortened) { shortened = before - after;targetId = target.id; }
          }
          if (shortened > 0) {
            const opportunityCost = purchase.turns + 1;
            const value = Math.min(0.4, ENDGAME_RACE_WEIGHT * shortened / opportunityCost);
            if (!bestShortcut || value > bestShortcut.value) bestShortcut = {
              cardId: development.id, targetCardId: targetId, subsequentRouteTurnsSaved: shortened,
              estimatedTurnsToDevelopment: purchase.turns,
              threatenedMarket: market && (who !== state.turn || purchase.turns > 1), value };
          }
        }
        const immediateCards = routeRows.filter(route => route.direct);
        const topRouteValue = best?.value || 0;
        const shortcutValue = bestShortcut?.value || 0;
        playerValues[who] = topRouteValue + shortcutValue;
        bestRoutes[who] = best;
        discountShortcuts[who] = bestShortcut;
        if (unknownMarketCards && bestRoutes[who]) bestRoutes[who].unknownMarketRefillNearby = true;
        if (state.endTrigger && player.score >= 15) {
          // Reaching 15 is only a trigger. The P1 rules engine decides the
          // official result after the opponent's final response.
          bestRoutes[who] = bestRoutes[who] ? { ...bestRoutes[who], own15IsNotTerminal: true } : {
            own15IsNotTerminal: true, immediateCards: immediateCards.map(route => route.cardId) };
        }
      }
      const result = { active: true, threshold: ENDGAME_RACE_THRESHOLD,
        valueByPlayer: playerValues, differential: playerValues[rootPlayer] - playerValues[1 - rootPlayer],
        bestRoutes, discountShortcuts, unknownMarketCards,
        unknownFutureRefillTiers, unknownReservations,
        finalResponseState: !!state.endTrigger && !state.over };
      tracker?.endgameRaceCache.set(state, result);
      return result;
    }

    function playerFeatures(state, who, rootPlayer, rules) {
      const player = state.players[who], opponent = state.players[1 - who];
      const market = [3, 2, 1].flatMap(tier => state.market[tier]).filter(card => !isAbstract(card));
      const goals = visibleGoals(state, who, rootPlayer, true);
      const scoring = market.filter(card => card.score > 0);
      const distances = new Map(goals.map(card => [card.id, purchaseDistance(state, player, card, rules)]));

      const developmentRates = scoring.map(card => {
        const distance = distances.get(card.id) ?? purchaseDistance(state, player, card, rules);
        return Number.isFinite(distance) ? (card.score + 0.25) / (distance ** 1.25) : 0;
      }).sort((a, b) => b - a).slice(0, 3);
      const development = developmentRates.length
        ? developmentRates.reduce((sum, value) => sum + value, 0) / developmentRates.length * 0.42 : 0;

      const ownedBonuses = COLORS.reduce((sum, color) => sum + (player.bonuses[color] || 0), 0);
      // Permanent discounts are monotone by construction. The former demand
      // bonus shrank when a newly acquired discount completed a color target.
      const discount = ownedBonuses * 0.07;

      const tokenValue = color => {
        if (!player.tokens[color]) return 0;
        if (color === 'y') return Math.min(3, player.tokens.y) * 0.22 + Math.max(0, player.tokens.y - 3) * 0.10;
        const demanded = goals.some(card => (card.cost[color] || 0) > (player.bonuses[color] || 0));
        const unit = demanded ? 0.13 : 0.035;
        return Math.min(2, player.tokens[color]) * unit + Math.max(0, player.tokens[color] - 2) * unit * 0.4;
      };
      const resources = ALL.reduce((sum, color) => sum + tokenValue(color), 0);

      let closestNoble = Infinity;
      for (const noble of state.nobles) {
        const distance = COLORS.reduce((sum, color) => sum + Math.max(0,
          (noble.req[color] || 0) - (player.bonuses[color] || 0)), 0);
        closestNoble = Math.min(closestNoble, distance);
      }
      const noble = Number.isFinite(closestNoble) && closestNoble < 5
        ? (5 - closestNoble) * 0.055 : 0;

      let reservedPotential = 0, hiddenReservations = 0;
      for (const card of player.reserved) {
        if (isAbstract(card) || card.blindReserved && who !== rootPlayer) {
          hiddenReservations++;
          continue;
        }
        const distance = purchaseDistance(state, player, card, rules);
        if (Number.isFinite(distance)) reservedPotential += (card.score + 0.3) / (distance + 1) * 0.10;
      }
      const slotCost = player.reserved.length * 0.10
        + Math.max(0, player.reserved.length - 1) * 0.11 + hiddenReservations * 0.08;
      const reserve = reservedPotential - slotCost;
      const closestPurchase = scoring.reduce((best, card) =>
        Math.min(best, distances.get(card.id) ?? Infinity), Infinity);

      return {
        score: player.score,
        development,
        discount,
        resources,
        noble,
        reserve,
        reserveSlots: player.reserved.length,
        hiddenReservations,
        closestNobleDistance: Number.isFinite(closestNoble) ? closestNoble : null,
        bestVisiblePurchaseDistance: Number.isFinite(closestPurchase) ? closestPurchase : null,
        cards: player.cards.length,
        opponentCards: opponent.cards.length,
      };
    }

    function evaluatePosition(state, rootPlayer, rules, tracker = null) {
      const startedAt = clockNow();
      tracker?.evaluation();
      try {
      if (state.over) {
        const winnerSide = rules.winnerSide(state);
        const outcome = winnerSide < 0 ? 0 : winnerSide === rootPlayer ? 1 : -1;
        return { value: outcome * 10000, terminal: { ended: true, winnerSide, outcome },
          features: { 0: null, 1: null }, unknownInfoIncomplete: hasUnknownCards(state) };
      }
      const a = playerFeatures(state, 0, rootPlayer, rules), b = playerFeatures(state, 1, rootPlayer, rules);
      const sum = features => features.score * 1.0 + features.development + features.discount
        + features.resources + features.noble + features.reserve;
      const baseValue = rootPlayer === 0 ? sum(a) - sum(b) : sum(b) - sum(a);
      const raceEnabled = tracker?.endgameRaceEnabled ?? configuration.endgameRaceEvaluation;
      let endgameRace = null, raceValue = 0;
      if (raceEnabled) {
        const raceStartedAt = clockNow();
        try {
          endgameRace = evaluateEndgameRace(state, rootPlayer, rules, tracker);
          raceValue = endgameRace.differential || 0;
        } finally { tracker?.time('endgameRaceEvaluationMs', clockNow() - raceStartedAt); }
      }
      const features = { 0: a, 1: b };
      if (raceEnabled) {
        features[0] = { ...a, endgameRaceValue: endgameRace.valueByPlayer[0],
          endgameRaceBestRoute: endgameRace.bestRoutes[0],
          endgameRaceDiscountShortcut: endgameRace.discountShortcuts[0] };
        features[1] = { ...b, endgameRaceValue: endgameRace.valueByPlayer[1],
          endgameRaceBestRoute: endgameRace.bestRoutes[1],
          endgameRaceDiscountShortcut: endgameRace.discountShortcuts[1] };
      }
      return { value: baseValue + raceValue,
        terminal: { ended: false, winnerSide: null, outcome: null },
        features, ...(raceEnabled ? { endgameRace } : {}),
        unknownInfoIncomplete: hasUnknownCards(state) };
      } finally {
        tracker?.time('positionEvaluationMs', clockNow() - startedAt);
      }
    }

    function hasUnknownCards(state) {
      return [1, 2, 3].some(tier => state.market[tier].some(isAbstract))
        || [1, 2, 3].some(tier => state.deck[tier].length > 0)
        || state.players.some(player => player.reserved.some(isAbstract));
    }

    function actionSetIsComplete(state) {
      const actor = state.turn;
      return ![1, 2, 3].some(tier => state.market[tier].some(isAbstract))
        && !state.players[actor].reserved.some(isAbstract);
    }

    function discardValue(state, who, color, rules, observer) {
      if (color === 'y') return 10;
      const player = state.players[who], goals = visibleGoals(state, who, observer, true);
      let best = 0;
      for (const card of goals) {
        if (!(player.tokens[color] || 0)) continue;
        const before = rules.price(card, player);
        const afterTokens = { ...player.tokens, [color]: player.tokens[color] - 1 };
        const after = rules.price(card, { ...player, tokens: afterTokens });
        if (after.left > before.left) best = Math.max(best, (card.score + 0.5) / (1 + before.left));
      }
      return best + (player.tokens[color] > 1 ? 0.02 * player.tokens[color] : 0);
    }

    function settle(state, action, who, rules, rootPlayer, tracker = null, settlementOverride = null) {
      tracker?.check();
      tracker?.settlementAttempt();
      const scratch = copyState(state, rules, tracker);
      scratch.turn = who;
      scratch.rulePhase = 'action';
      if (!executeAction(scratch, action, who, rules, tracker).ok) return null;
      const override = settlementOverride ? clone(settlementOverride) : null;
      const choices = override || { discardColors: [] };
      let discardIndex = 0;
      let pending = rules.prepareSettlement(scratch, who), guard = 0;
      while (pending.type !== 'complete' && guard++ < 12) {
        tracker?.check();
        if (pending.type === 'discard') {
          let choice;
          if (override) {
            const color = override.discardColors?.[discardIndex++];
            if (color === undefined) return null;
            choice = { type: 'discard', color };
          } else {
            const options = rules.legalActions(scratch, who).filter(candidate => candidate.type === 'discard');
            options.sort((a, b) => discardValue(scratch, who, a.color, rules, rootPlayer)
              - discardValue(scratch, who, b.color, rules, rootPlayer)
              || ALL.indexOf(a.color) - ALL.indexOf(b.color));
            choice = options[0];
            if (choice) choices.discardColors.push(choice.color);
          }
          if (!choice || !executeAction(scratch, choice, who, rules, tracker).ok) return null;
        } else if (pending.type === 'noble') {
          let id;
          if (override) {
            id = pending.options.length === 1 ? pending.options[0] : override.nobleId;
            if (id === undefined) return null;
          } else {
            const options = [...pending.options].sort((left, right) => {
              const a = copyState(scratch, rules, tracker), b = copyState(scratch, rules, tracker);
              executeAction(a, { type: 'noble', id: left }, who, rules, tracker);
              executeAction(b, { type: 'noble', id: right }, who, rules, tracker);
              const leftValue = evaluatePosition(a, rootPlayer, rules, tracker).value;
              const rightValue = evaluatePosition(b, rootPlayer, rules, tracker).value;
              // Main search utility never changes perspective: root chooses MAX,
              // opponent settlement choices choose MIN in that same utility.
              return (who === rootPlayer ? rightValue - leftValue : leftValue - rightValue) || left - right;
            });
            id = options[0];
            if (id !== undefined) choices.nobleId = id;
          }
          if (id === undefined || !executeAction(scratch, { type: 'noble', id }, who, rules, tracker).ok) return null;
        } else return null;
        pending = rules.prepareSettlement(scratch, who);
      }
      if (pending.type !== 'complete') return null;
      tracker?.check();
      // `scratch` already contains the action and every validated settlement
      // choice. Advancing it directly avoids copying and replaying the same
      // transition through rules.simulate a second time.
      const end = rules.advanceTurn(scratch, who);
      tracker?.check();
      if (!end.ok) return null;
      tracker?.settlementComplete();
      const simulated = { ok: true, state: scratch, events: [], pending: null, ...end };
      return { simulated, choices };
    }

    function makeNode(state, rootPlayer, rules, metadata = {}, tracker = null) {
      tracker?.node();
      // Callers pass a fresh shadow state or an exclusively owned settled child.
      const position = state;
      const evaluation = evaluatePosition(position, rootPlayer, rules, tracker);
      tracker?.check();
      return {
        state: position,
        actorToMove: position.turn,
        rootPlayer,
        observer: rootPlayer,
        depth: metadata.depth || 0,
        action: metadata.action ? clone(metadata.action) : null,
        settlementChoices: metadata.settlementChoices ? clone(metadata.settlementChoices) : null,
        parentKey: metadata.parentKey || null,
        evaluation,
        unknownInfoIncomplete: hasUnknownCards(position),
        actionSetComplete: actionSetIsComplete(position),
      };
    }

    function expandNode(parent, rules, budget = null, tracker = null, baseline = null) {
      if (!parent?.state || !Number.isInteger(parent.rootPlayer ?? parent.observer) || !rules?.legalActions) {
        throw new TypeError('expandNode expects a V2 node and P1 rules');
      }
      const state = parent.state, actor = state.turn;
      tracker?.check();
      const legal = rules.legalActions(state, actor).filter(action => ACTION_TYPES.has(action.type));
      tracker?.enumerated(legal.length);
      const candidates = [];
      let actionSetComplete = actionSetIsComplete(state);
      const parentKey = positionKey(state);
      for (const action of legal) {
        tracker?.expansion();
        // The acting player chooses its own settlement. Only information
        // available in this node is used for that choice.
        const isBaseline = parent.depth === 0 && baseline?.action
          && actionKey(action) === actionKey(baseline.action);
        const settlementStartedAt = clockNow();
        let complete;
        try {
          complete = settle(state, action, actor, rules, parent.rootPlayer ?? parent.observer, tracker,
            isBaseline ? baseline.settlementChoices : null);
        } finally { tracker?.time('settlementMs', clockNow() - settlementStartedAt); }
        if (!complete) {
          actionSetComplete = false;
          tracker?.failedSimulation();
          continue;
        }
        candidates.push(makeNode(complete.simulated.state, parent.rootPlayer ?? parent.observer, rules, {
          depth: parent.depth + 1, action, settlementChoices: complete.choices,
          parentKey,
        }, tracker));
      }
      if (tracker) tracker.check();
      return { parent, actor, candidates, budget, actionSetComplete };
    }

    function buildRoot(observation, rules, budget = null, tracker = null, baseline = null) {
      if (!observation || !rules?.legalActions || !Number.isInteger(observation.self)
        || observation.turn !== observation.self || observation.over) {
        throw new TypeError('v2-search expects a live current-player observation and P1 rules');
      }
      const rootPlayer = observation.self;
      // The adapter reads only fields exposed by Rules.observe. Deck entries are
      // abstract count placeholders and opaque opponent reserves stay opaque.
      const state = Advanced._internals.shadowState(observation);
      const root = makeNode(state, rootPlayer, rules, { depth: 0 }, tracker);
      return { root, ...expandNode(root, rules, budget, tracker, baseline), rootPlayer,
        observer: rootPlayer };
    }

    function positionKey(state) {
      return JSON.stringify({
        turn: state.turn, bank: state.bank,
        market: Object.fromEntries([1, 2, 3].map(tier => [tier, state.market[tier].map(card => card.id)])),
        nobles: state.nobles.map(noble => noble.id),
        drawCounts: Object.fromEntries([1, 2, 3].map(tier => [tier, state.deck[tier].length])),
        players: state.players.map(player => ({ score: player.score, tokens: player.tokens,
          bonuses: player.bonuses, cards: player.cards.map(card => card.id),
          reserved: player.reserved.map(card => card.id) })),
      });
    }

    function decisionBudget(budget) {
      const allowed = ['enabled', 'mode', 'tacticalTrigger', 'endgameRaceEvaluation',
        'rootTopK', 'responseTopK', 'maxNodes', 'maxExpansions',
        'timeBudgetMs', 'uncertaintyPenalty', 'debug'];
      if (budget === null || budget === undefined) return configuration;
      if (typeof budget !== 'object' || Array.isArray(budget)) throw new RangeError('Invalid V2 decision budget');
      const injected = Object.fromEntries(allowed.filter(key => Object.hasOwn(budget, key)).map(key => [key, budget[key]]));
      const merged = { ...configuration, ...injected };
      validateConfiguration(merged);
      return merged;
    }

    function simulatePublicAction(state, action, who, rules, settlementChoices = null, tracker = null) {
      tracker?.check();
      tracker?.tacticalSimulation();
      const scratch = rules.copyState(state);
      scratch.turn = who;
      scratch.rulePhase = 'action';
      const applied = rules.executeAction(scratch, action, who);
      if (!applied.ok) return { ok: false, reason: applied.reason || 'illegal_action', state: scratch };
      const choices = settlementChoices ? clone(settlementChoices) : { discardColors: [] };
      let discardIndex = 0, pending = rules.prepareSettlement(scratch, who), guard = 0;
      while (pending.type !== 'complete' && guard++ < 12) {
        tracker?.check();
        if (pending.type === 'discard') {
          let color = settlementChoices?.discardColors?.[discardIndex++];
          if (color === undefined) {
            color = rules.legalActions(scratch, who).find(candidate => candidate.type === 'discard')?.color;
            if (color === undefined) return { ok: false, reason: 'discard_settlement_unavailable', state: scratch };
            choices.discardColors.push(color);
          }
          const result = rules.executeAction(scratch, { type: 'discard', color }, who);
          if (!result.ok) return { ok: false, reason: result.reason || 'invalid_discard', state: scratch };
        } else if (pending.type === 'noble') {
          const id = settlementChoices?.nobleId !== undefined
            && pending.options.includes(settlementChoices.nobleId)
            ? settlementChoices.nobleId : pending.options[0];
          if (id === undefined) return { ok: false, reason: 'noble_settlement_unavailable', state: scratch };
          const result = rules.executeAction(scratch, { type: 'noble', id }, who);
          if (!result.ok) return { ok: false, reason: result.reason || 'invalid_noble', state: scratch };
          choices.nobleId = id;
        } else return { ok: false, reason: 'invalid_settlement', state: scratch };
        pending = rules.prepareSettlement(scratch, who);
      }
      if (pending.type !== 'complete') return { ok: false, reason: 'settlement_guard', state: scratch };
      tracker?.check();
      const advanced = rules.advanceTurn(scratch, who);
      if (!advanced.ok) return { ok: false, reason: 'turn_advance_failed', state: scratch };
      tracker?.check();
      return { ok: true, state: scratch, choices, ...advanced };
    }

    function evaluateTacticalTrigger(observation, rules, baseline, tracker = null) {
      let ruleSimulations = 0;
      const simulate = (state, action, who, choices = null) => {
        ruleSimulations++;
        return simulatePublicAction(state, action, who, rules, choices, tracker);
      };
      if (!observation || !Number.isInteger(observation.self) || observation.turn !== observation.self
        || !rules?.legalActions || !baseline?.action) {
        return { triggered: false, reasons: [], skipReason: 'no_baseline_action', ruleSimulations };
      }
      const root = observation.self, opponent = 1 - root;
      const initial = Advanced._internals.shadowState(observation);
      const initialLegal = rules.legalActions(initial, root);
      const baselineLegal = initialLegal.some(action => actionKey(action) === actionKey(baseline.action));
      if (!baselineLegal) return { triggered: true, ruleSimulations,
        reasons: [{ code: 'baseline_action_not_in_public_legal_set', cardIds: [] }] };

      const reasons = new Map();
      const add = (code, cardId, details = {}) => {
        let value = reasons.get(code);
        if (!value) { value = { code, cardIds: [], details: [] };reasons.set(code, value); }
        if (cardId && !value.cardIds.includes(cardId)) value.cardIds.push(cardId);
        if (Object.keys(details).length) value.details.push(details);
      };
      const noteRootImmediate = (action, outcome) => {
        if (actionKey(action) === actionKey(baseline.action)) return;
        const card = rules.findCard(initial, action.cardId, root);
        if (!card) return;
        if (outcome.state.over && rules.winnerSide(outcome.state) === root)
          add('our_immediate_terminal_buy', card.id, { score: card.score });
        if (outcome.state.players[root].score > initial.players[root].score)
          add('our_immediate_scoring_buy', card.id, { score: card.score });
        if (outcome.state.players[root].nobles.length > initial.players[root].nobles.length)
          add('our_immediate_noble_buy', card.id, { score: card.score });
      };

      // An immediately available score or noble action is a public tactical
      // alternative when Hybrid C has selected a different move.
      for (const action of initialLegal) {
        tracker?.check();
        if (action.type !== 'buy' || actionKey(action) === actionKey(baseline.action)) continue;
        const outcome = simulate(initial, action, root);
        if (outcome.ok) noteRootImmediate(action, outcome);
      }

      const fallback = simulate(initial, baseline.action, root,
        baseline.settlementChoices || { discardColors: [] });
      if (!fallback.ok || fallback.state.over) {
        if (!fallback.ok) add('baseline_transition_incomplete', null, { reason: fallback.reason });
        return { triggered: reasons.size > 0 || !fallback.ok, ruleSimulations,
          reasons: [...reasons.values()], skipReason: fallback.ok ? 'baseline_ends_game' : null };
      }
      const state = fallback.state;
      const opponentLegal = rules.legalActions(state, opponent);
      const visibleMarket = [3, 2, 1].flatMap(tier => state.market[tier])
        .filter(card => card && !isAbstract(card));
      const initiallyBuyableByRoot = new Set(initialLegal.filter(action => action.type === 'buy')
        .map(action => action.cardId));

      for (const action of opponentLegal) {
        tracker?.check();
        if (action.type !== 'buy') continue;
        const card = rules.findCard(state, action.cardId, opponent);
        if (!card || isAbstract(card)) continue;
        const outcome = simulate(state, action, opponent);
        if (!outcome.ok) continue;
        if (outcome.state.over && rules.winnerSide(outcome.state) === opponent)
          add('opponent_immediate_terminal_buy', card.id, { score: card.score });
        if (outcome.state.players[opponent].score > state.players[opponent].score)
          add('opponent_scoring_buy', card.id, { score: card.score });
        if (outcome.state.players[opponent].nobles.length > state.players[opponent].nobles.length)
          add('opponent_noble_buy', card.id, { score: card.score });
        if (!state.endTrigger && initiallyBuyableByRoot.has(card.id)
          && visibleMarket.some(value => value.id === card.id))
          add('opponent_contested_purchase', card.id, { score: card.score });
      }

      // A legal public reserve can remove a high-value card the root player
      // could buy on the following turn. Unknown replacement faces are ignored.
      if (!state.endTrigger) {
        const rootForecast = rules.copyState(state);
        rootForecast.turn = root;rootForecast.rulePhase = 'action';
        const rootBuyableAfterFallback = new Set(rules.legalActions(rootForecast, root)
          .filter(action => action.type === 'buy').map(action => action.cardId));
        for (const action of opponentLegal) {
          tracker?.check();
          if (action.type !== 'reserve' || !rootBuyableAfterFallback.has(action.cardId)) continue;
          const card = visibleMarket.find(value => value.id === action.cardId);
          if (!card || isAbstract(card)) continue;
          const nobleProgress = state.nobles.some(noble => {
            const before = COLORS.reduce((sum, color) => sum + Math.max(0,
              (noble.req[color] || 0) - (state.players[root].bonuses[color] || 0)), 0);
            const after = COLORS.reduce((sum, color) => sum + Math.max(0,
              (noble.req[color] || 0) - (state.players[root].bonuses[color] || 0)
              - (card.color === color ? 1 : 0)), 0);
            return after < before;
          });
          if (card.score > 0 || nobleProgress) add('opponent_can_reserve_root_key_purchase', card.id,
            { score: card.score, nobleProgress });
        }
      }

      const values = [...reasons.values()];
      tracker?.check();
      return { triggered: values.length > 0, reasons: values, ruleSimulations,
        skipReason: values.length ? null : 'no_public_immediate_tactical_threat' };
    }

    function tacticalReasons(before, after, actor, rules) {
      const prior = before.state, action = after.action;
      const player = prior.players[actor], opponent = prior.players[1 - actor];
      const reasons = [];
      if (after.state.over && rules.winnerSide(after.state) === actor) reasons.push('immediate_win');
      if (after.state.players[actor].score > player.score) reasons.push('score');
      if (after.state.players[actor].nobles.length > player.nobles.length) reasons.push('noble');
      if (!prior.endTrigger && after.state.endTrigger) reasons.push('last_round_trigger');
      if (action.type === 'buy' || action.type === 'reserve') {
        const card = [1, 2, 3].flatMap(tier => prior.market[tier]).find(value => value.id === action.cardId);
        if (card && rules.price(card, opponent).left === 0) reasons.push('snipes_affordable_card');
      }
      if (action.type === 'take') {
        const scarce = action.colors.some(color => (prior.bank[color] || 0) > 0
          && (after.state.bank[color] || 0) <= 1
          && [1, 2, 3].some(tier => prior.market[tier].some(card => !isAbstract(card)
            && (card.cost[color] || 0) > (opponent.bonuses[color] || 0))));
        if (scarce) reasons.push('scarce_token_denial');
      }
      return reasons;
    }

    function rankNodes(nodes, descending, tracker) {
      return [...nodes].sort((left, right) => {
        tracker?.comparison();
        const delta = left.evaluation.value - right.evaluation.value;
        return (descending ? -delta : delta) || actionKey(left.action).localeCompare(actionKey(right.action));
      });
    }

    function selectWithTactics(ranked, limit, reasonsByAction, tracker) {
      const selected = ranked.slice(0, limit), keys = new Set(selected.map(node => actionKey(node.action)));
      for (const node of ranked) {
        if ((reasonsByAction.get(actionKey(node.action)) || []).length && !keys.has(actionKey(node.action))) {
          selected.push(node);keys.add(actionKey(node.action));
        }
      }
      tracker.check();
      return selected;
    }

    function hasRiskOverlap(estimates, best) {
      return estimates.some(candidate => candidate !== best
        && best.lower <= candidate.upper && candidate.lower <= best.upper
        && (best.uncertainty > 0 || candidate.uncertainty > 0));
    }

    function publicDecision(baseline, diagnostics) {
      return { strategyId: 'v2-search', action: baseline.action ? clone(baseline.action) : null,
        nextRng: baseline.nextRng,
        settlementChoices: baseline.settlementChoices ? clone(baseline.settlementChoices) : { discardColors: [] },
        status: baseline.status || (baseline.action ? 'ok' : 'blocked_no_legal_action'), diagnostics };
    }

    function decide(observation, rules, rng = 0, budget = null) {
      const startedAt = clockNow();
      const baseline = fallback.decide(observation, rules, rng);
      const baselineMs = clockNow() - startedAt;
      const requested = budget !== null && budget !== undefined;
      let options;
      try { options = decisionBudget(budget); }
      catch (error) {
        return publicDecision(baseline, { phase: 'P4.B1', searchEnabled: false, mode: 'fallback',
          fallbackStrategy: 'hybrid-v1', fallbackStatus: baseline.status, fallbackUsed: true,
          fallbackReason: 'invalid_budget', budgetInjected: requested, budgetApplied: false,
          decisionMs: clockNow() - startedAt, hybridMs: baselineMs, error: error.message });
      }
      const mode = options.enabled ? options.mode : 'off';
      const emptyTiming = () => ({ hybridMs: baselineMs, rootCandidateMs: 0,
        opponentCandidateMs: 0, settlementMs: 0, tacticalTriggerMs: 0, ruleSimulationMs: 0,
        positionEvaluationMs: 0, endgameRaceEvaluationMs: 0, totalMs: clockNow() - startedAt,
        nesting: 'root/opponent candidate time includes settlement and position evaluation; settlement time includes action application, settlement choices and turn advance; ruleSimulationMs counts explicit rules.simulate calls' });
      if (mode === 'off') return publicDecision(baseline, { phase: 'P4.B1', searchEnabled: false,
        mode: 'off', fallbackStrategy: 'hybrid-v1', fallbackStatus: baseline.status,
        tacticalTriggerEnabled: false, tacticalTriggered: false, endgameRaceEvaluationEnabled: false,
        fallbackUsed: false, bypassReason: 'disabled', budgetInjected: requested, budgetApplied: false,
        decisionMs: clockNow() - startedAt, hybridMs: baselineMs, timing: emptyTiming(), nodes: 0, expansions: 0,
        candidateCount: baseline.action ? undefined : 0, depth: 0, strictWinClaim: false });

      const tracker = createTracker(options, startedAt);
      const baseDiagnostics = { phase: 'P4.B1', searchEnabled: true, mode,
        tacticalTriggerEnabled: options.tacticalTrigger,
        endgameRaceEvaluationEnabled: options.endgameRaceEvaluation,
        fallbackStrategy: 'hybrid-v1', fallbackStatus: baseline.status,
        budgetInjected: requested, budgetApplied: true, hybridMs: baselineMs,
        comparisonSemantics: 'heuristic ranking; uncertainty penalty bands are not statistical or sound bounds',
        limits: { maxNodes: options.maxNodes, maxExpansions: options.maxExpansions,
          timeBudgetMs: options.timeBudgetMs, rootTopK: options.rootTopK, responseTopK: options.responseTopK } };
      const timing = () => ({ hybridMs: baselineMs,
        rootCandidateMs: tracker.stats.rootCandidateMs,
        opponentCandidateMs: tracker.stats.opponentCandidateMs,
        settlementMs: tracker.stats.settlementMs, tacticalTriggerMs: tracker.stats.tacticalTriggerMs,
        ruleSimulationMs: tracker.stats.ruleSimulationMs,
        positionEvaluationMs: tracker.stats.positionEvaluationMs,
        endgameRaceEvaluationMs: tracker.stats.endgameRaceEvaluationMs,
        totalMs: clockNow() - startedAt,
        nesting: 'root/opponent candidate time includes settlement and position evaluation; settlement time includes action application, settlement choices and turn advance; ruleSimulationMs counts explicit rules.simulate calls' });
      let triggerResult = null;
      const fail = error => publicDecision(baseline, { ...baseDiagnostics, ...tracker.stats,
        fallbackUsed: true, fallbackReason: tracker.abortReason || (error?.v2BudgetAbort ? error.message : 'search_error'),
        error: tracker.abortReason ? undefined : String(error?.message || error), depth: tracker.stats.maxDepthReached,
        searchComplete: false,
        strictWinClaim: false,
        selectionReason: error?.v2BudgetAbort ? 'budget_fallback'
          : error?.message === 'incomplete_root_action_set' ? 'incomplete_information_fallback' : 'internal_error_fallback',
        tacticalTriggered: triggerResult?.triggered ?? false,
        tacticalTriggerReasons: triggerResult?.reasons || [],
        tacticalTriggerSkipReason: triggerResult?.skipReason || null,
        timing: timing(),
        decisionMs: clockNow() - startedAt,
        elapsedOverBudgetMs: Math.max(0, clockNow() - startedAt - options.timeBudgetMs) });
      try {
        tracker.check();
        if (options.tacticalTrigger) {
          const triggerStartedAt = clockNow();
          try { triggerResult = evaluateTacticalTrigger(observation, rules, baseline, tracker); }
          finally { tracker.time('tacticalTriggerMs', clockNow() - triggerStartedAt); }
          tracker.check();
          if (!triggerResult.triggered) return publicDecision(baseline, { ...baseDiagnostics, ...tracker.stats,
            fallbackUsed: false, searchBypassed: true, bypassReason: 'tactical_trigger_not_fired',
            tacticalTriggered: false, tacticalTriggerReasons: [],
            tacticalTriggerSkipReason: triggerResult.skipReason,
            depth: 0, searchComplete: false, decisionMs: clockNow() - startedAt,
            elapsedOverBudgetMs: Math.max(0, clockNow() - startedAt - options.timeBudgetMs),
            timing: timing() });
        }
        const rootStartedAt = clockNow();
        let built;
        try { built = buildRoot(observation, rules, options, tracker, baseline); }
        finally { tracker.time('rootCandidateMs', clockNow() - rootStartedAt); }
        tracker.reachedDepth(1);
        tracker.stats.rootCandidates = built.candidates.length;
        if (!built.candidates.length) return publicDecision(baseline, { ...baseDiagnostics, ...tracker.stats,
          fallbackUsed: false, candidateCount: 0, depth: 0, timing: timing(),
          decisionMs: clockNow() - startedAt, noLegalAction: true });
        if (!built.actionSetComplete) throw new Error('incomplete_root_action_set');
        const rootReasons = new Map(built.candidates.map(node => [actionKey(node.action),
          tacticalReasons(built.root, node, built.observer, rules)]));
        const baselineKey = baseline.action ? actionKey(baseline.action) : null;
        const baselineNode = baselineKey && built.candidates.find(node => actionKey(node.action) === baselineKey
          && actionKey(node.settlementChoices || {}) === actionKey(baseline.settlementChoices || {}));
        if (baseline.action && !baselineNode) throw new Error('hybrid_candidate_missing_from_root');
        const rankedRoots = rankNodes(built.candidates, true, tracker);
        // B and C share this exact candidate pool; C only adds opponent replies.
        const selectedRoots = selectWithTactics(rankedRoots, options.rootTopK, rootReasons, tracker);
        if (baselineNode && !selectedRoots.includes(baselineNode)) selectedRoots.push(baselineNode);
        const topRootKeys = new Set(rankedRoots.slice(0, options.rootTopK)
          .map(node => actionKey(node.action)));
        const rootSelectionReasons = selectedRoots.map(node => {
          const key = actionKey(node.action), reasons = [];
          if (topRootKeys.has(key)) reasons.push('root_top_k');
          reasons.push(...(rootReasons.get(key) || []).map(value => `tactical:${value}`));
          if (baselineNode === node && !reasons.includes('root_top_k')) reasons.push('hybrid_fallback');
          return { action: clone(node.action), reasons };
        });
        tracker.stats.selectedRootCandidates = selectedRoots.length;
        tracker.stats.tacticalRootActions = [...rootReasons.values()].filter(reasons => reasons.length).length;
        const estimates = [];
        for (const rootNode of selectedRoots) {
          tracker.check();
          const rootTactics = rootReasons.get(actionKey(rootNode.action)) || [];
          if (mode === 'score') {
            const terminalWin = rootNode.state.over && rootNode.evaluation.terminal.outcome > 0;
            estimates.push({ node: rootNode, value: rootNode.evaluation.value, lower: rootNode.evaluation.value,
              upper: rootNode.evaluation.value, uncertainty: 0, replies: 0, replyCoverage: null,
              actionSetComplete: rootNode.actionSetComplete, strictOutcome: terminalWin ? 'win' : null,
              riskKind: null, rootTactics });
            continue;
          }
          if (!rootNode.state.over && rootNode.state.turn !== 1 - built.observer) {
            throw new Error('turn_did_not_advance_after_root_action');
          }
          if (rootNode.state.over) {
            estimates.push({ node: rootNode, value: rootNode.evaluation.value, lower: rootNode.evaluation.value,
              upper: rootNode.evaluation.value, uncertainty: 0, replies: 0, replyCoverage: 1,
              actionSetComplete: true,
              strictOutcome: rootNode.evaluation.terminal.outcome > 0 ? 'win' : null,
              riskKind: null, rootTactics });
            continue;
          }
          const opponentStartedAt = clockNow();
          let responseSet;
          try { responseSet = expandNode(rootNode, rules, options, tracker); }
          finally { tracker.time('opponentCandidateMs', clockNow() - opponentStartedAt); }
          tracker.reachedDepth(2);
          tracker.stats.opponentResponses += responseSet.candidates.length;
          if (!responseSet.actionSetComplete) tracker.stats.incompleteResponseSets++;
          const responseReasons = new Map(responseSet.candidates.map(node => [actionKey(node.action),
            tacticalReasons(rootNode, node, responseSet.actor, rules)]));
          const rankedResponses = rankNodes(responseSet.candidates, false, tracker);
          const selectedResponses = selectWithTactics(rankedResponses, options.responseTopK, responseReasons, tracker);
          tracker.stats.selectedOpponentResponses += selectedResponses.length;
          tracker.stats.tacticalOpponentResponses += [...responseReasons.values()].filter(reasons => reasons.length).length;
          if (!selectedResponses.length) throw new Error('opponent_has_no_legal_response');
          // The response ordering is MIN from the unchanged rootPlayer view.
          // The minimum survives Top-4 because the list is sorted ascending.
          const worstResponse = rankedResponses[0];
          const rawWorst = worstResponse.evaluation.value;
          let uncertainty = responseSet.actionSetComplete ? 0 : options.uncertaintyPenalty;
          const unknownRefill = responseSet.candidates.some(response => [1, 2, 3]
            .some(tier => response.state.market[tier].some(isAbstract)));
          const unknownReserve = responseSet.candidates.some(response => response.state.players
            .some(player => player.reserved.some(isAbstract)));
          if (unknownRefill) {
            uncertainty += options.uncertaintyPenalty * 0.5;
            tracker.stats.uncertainMarketRefills++;
          }
          if (unknownReserve) {
            uncertainty += options.uncertaintyPenalty * 0.5;
            tracker.stats.uncertainReserveOutcomes++;
          }
          if (uncertainty) tracker.stats.uncertaintyAffectedRoots++;
          const conservative = rawWorst - uncertainty;
          const uncertaintyComponents = {
            incompleteActionSet: responseSet.actionSetComplete ? 0 : options.uncertaintyPenalty,
            unknownRefill: unknownRefill ? options.uncertaintyPenalty * 0.5 : 0,
            unknownReserve: unknownReserve ? options.uncertaintyPenalty * 0.5 : 0,
          };
          const allResponsesSelected = selectedResponses.length === responseSet.candidates.length;
          const strictOutcome = responseSet.actionSetComplete && allResponsesSelected
            && selectedResponses.every(node => node.state.over && node.evaluation.terminal.outcome > 0) ? 'win' : null;
          estimates.push({ node: rootNode, value: conservative, lower: conservative, upper: rawWorst,
            uncertainty, replies: responseSet.candidates.length, selectedReplies: selectedResponses.length,
            replyCoverage: responseSet.candidates.length ? selectedResponses.length / responseSet.candidates.length : 1,
            actionSetComplete: responseSet.actionSetComplete, strictOutcome,
            riskKind: uncertainty ? 'heuristic_risk_penalty' : null, uncertaintyComponents, rootTactics,
            worstResponse: clone(worstResponse.action), knownWorstResponseValue: rawWorst,
            knownWorstResponseFeatures: clone(worstResponse.evaluation.features) });
        }
        tracker.check();
        const ranked = [...estimates].sort((a, b) => {
          tracker.comparison();return b.value - a.value || actionKey(a.node.action).localeCompare(actionKey(b.node.action));
        });
        const best = ranked[0], baselineEstimate = baselineKey && ranked.find(item => actionKey(item.node.action) === baselineKey);
        const uncertaintyOverlap = hasRiskOverlap(ranked, best);
        const tiedWithBaseline = !!baselineEstimate && best.value === baselineEstimate.value;
        const riskFallback = uncertaintyOverlap;
        const chosen = riskFallback || tiedWithBaseline ? baselineEstimate : best;
        if (!chosen) throw new Error('hybrid_candidate_missing_from_estimates');
        const rootScoreBest = selectedRoots.reduce((current, candidate) => {
          tracker.comparison();
          return candidate.evaluation.value > current.evaluation.value
            || candidate.evaluation.value === current.evaluation.value
              && actionKey(candidate.action).localeCompare(actionKey(current.action)) < 0 ? candidate : current;
        });
        const rootScoreChoice = baselineNode && rootScoreBest.evaluation.value === baselineNode.evaluation.value
          ? baselineNode : rootScoreBest;
        const noRiskBest = estimates.reduce((current, candidate) => {
          tracker.comparison();
          return candidate.upper > current.upper
            || candidate.upper === current.upper
              && actionKey(candidate.node.action).localeCompare(actionKey(current.node.action)) < 0 ? candidate : current;
        });
        const noRiskChoice = baselineEstimate && noRiskBest.upper === baselineEstimate.upper
          ? baselineEstimate : noRiskBest;
        const selectedDecision = { action: clone(chosen.node.action),
          settlementChoices: clone(chosen.node.settlementChoices || { discardColors: [] }),
          nextRng: baseline.nextRng, status: baseline.status || 'ok' };
        const tookOver = actionKey(selectedDecision.action) !== baselineKey
          || actionKey(selectedDecision.settlementChoices) !== actionKey(baseline.settlementChoices || { discardColors: [] });
        const sameEvaluationAsHybrid = !!baselineEstimate && best.value === baselineEstimate.value;
        const riskPenaltyChangedAction = actionKey(chosen.node.action) !== actionKey(noRiskChoice.node.action);
        const actionChangeCause = !tookOver ? null
          : riskPenaltyChangedAction ? 'heuristic_uncertainty_penalty'
            : actionKey(chosen.node.action) === actionKey(rootScoreChoice.action)
              ? 'root_score_and_candidate_selection' : 'opponent_response_comparison';
        const strictEvaluationImprovement = tookOver && !!baselineEstimate && chosen.value > baselineEstimate.value
          && !chosen.uncertainty && !baselineEstimate.uncertainty;
        const hybridOverrideReason = !tookOver ? null : strictEvaluationImprovement ? 'strict_evaluation_improvement'
          : actionChangeCause === 'heuristic_uncertainty_penalty' ? 'risk_adjusted_improvement'
            : actionChangeCause;
        const diagnostics = { ...baseDiagnostics, ...tracker.stats,
          decisionMs: clockNow() - startedAt,
          elapsedOverBudgetMs: Math.max(0, clockNow() - startedAt - options.timeBudgetMs),
          tacticalTriggered: options.tacticalTrigger ? !!triggerResult?.triggered : false,
          tacticalTriggerReasons: triggerResult?.reasons || [],
          tacticalTriggerSkipReason: triggerResult?.skipReason || null,
          depth: mode === 'minimax' ? 2 : 1, searchComplete: true, rootActionCoverage: built.candidates.length,
          selectedRootCount: selectedRoots.length,
          selectedRootFraction: selectedRoots.length / Math.max(1, built.candidates.length),
          hybridActionIncluded: !!baselineNode, hybridActionSelected: !tookOver,
          hybridCandidateEvaluation: baselineEstimate?.value ?? null,
          sameEvaluationAsHybrid,
          strictEvaluationImprovement,
          actionChangeCause,
          rootScoreCounterfactualAction: options.debug ? clone(rootScoreChoice.action) : undefined,
          noRiskCounterfactualAction: options.debug ? clone(noRiskChoice.node.action) : undefined,
          riskPenaltyChangedAction,
          hybridAction: options.debug ? clone(baseline.action) : undefined,
          hybridSettlementChoices: options.debug ? clone(baseline.settlementChoices || { discardColors: [] }) : undefined,
          selectedRootReasons: options.debug ? rootSelectionReasons : undefined,
          hybridOverrideReason,
          selectionReason: riskFallback ? 'uncertainty_fallback'
            : tiedWithBaseline ? 'hybrid_tie_preferred' : tookOver ? 'candidate_evaluation_improvement' : 'hybrid_best',
          fallbackUsed: riskFallback,
          ...(riskFallback ? { fallbackReason: 'uncertainty_overlap_all_candidates' } : {}),
          uncertaintyOverlap,
          strictWinClaim: chosen.strictOutcome === 'win',
          timing: timing(),
          selectedEvaluation: { action: clone(selectedDecision.action), value: chosen.value,
            uncertainty: chosen.uncertainty, actionSetComplete: chosen.actionSetComplete,
            riskKind: chosen.riskKind, strictProofEligible: chosen.strictOutcome === 'win',
            uncertaintyComponents: chosen.uncertaintyComponents || null,
            strictOutcome: chosen.strictOutcome, knownWorstResponse: chosen.worstResponse || null,
            knownWorstResponseValue: chosen.knownWorstResponseValue ?? null,
            knownWorstResponseFeatures: chosen.knownWorstResponseFeatures || null,
            replyCoverage: chosen.replyCoverage },
          candidateEvaluations: options.debug ? ranked.map(item => ({ action: clone(item.node.action),
            value: item.value, uncertainty: item.uncertainty, actionSetComplete: item.actionSetComplete,
            staticValue: item.node.evaluation.value, staticFeatures: clone(item.node.evaluation.features),
            strictOutcome: item.strictOutcome, riskKind: item.riskKind,
            lower: item.lower, upper: item.upper,
            uncertaintyComponents: item.uncertaintyComponents || null,
            strictProofEligible: item.strictOutcome === 'win', worstResponse: item.worstResponse || null,
            knownWorstResponseValue: item.knownWorstResponseValue ?? null,
            knownWorstResponseFeatures: item.knownWorstResponseFeatures || null,
            replyCoverage: item.replyCoverage, tacticalReasons: item.rootTactics })) : undefined };
        return publicDecision(selectedDecision, diagnostics);
      } catch (error) { return fail(error); }
    }

    return Object.freeze({ strategyId: 'v2-search', configuration, decide,
        _internals: Object.freeze({ buildRoot, evaluatePosition, purchaseDistance, knownIdsFor,
        visibleGoals, hasUnknownCards, actionSetIsComplete, expandNode, positionKey,
        evaluateEndgameRace, estimateRacePurchase, simulateVisibleRacePurchase,
        evaluateTacticalTrigger, simulatePublicAction,
        tacticalReasons, decisionBudget, rankNodes, hasRiskOverlap }) });
  }

  return Object.freeze({ strategyId: 'v2-search', create });
});
