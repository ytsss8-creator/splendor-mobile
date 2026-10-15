/* Experimental, observation-only tactical wrapper around frozen legacy-v1. */
(function (root, factory) {
  const Legacy = typeof module === 'object' && module.exports ? require('./legacy-v1.js') : root.SplendorLegacyAI;
  const Advanced = typeof module === 'object' && module.exports ? require('./advanced-v1.js') : root.SplendorAdvancedAI;
  const api = factory(Legacy, Advanced);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplendorHybridAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Legacy, Advanced) {
  'use strict';
  const COLORS = ['w', 'u', 'g', 'r', 'k'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const actionKey = action => JSON.stringify(action);

  function create(settings = {}) {
    if (!Legacy?.decide || !Advanced?._internals?.shadowState) throw new Error('Hybrid requires legacy-v1 and advanced-v1 adapters');
    const configuration = Object.freeze({ terminal: true, reservation: true, scoring: true,
      reservationRouteFix: false, zeroProgressComparison: false, planNodes: 16, ...settings });
    if (!Number.isInteger(configuration.planNodes) || configuration.planNodes < 1 || configuration.planNodes > 32) {
      throw new RangeError('Invalid hybrid planNodes');
    }

    function stateOf(observation) { return Advanced._internals.shadowState(observation); }
    function knownIdsOf(observation) { return Advanced._internals.knownIdsOf(observation); }
    function visibleLegalActions(state, who, rules) {
      return rules.legalActions(state, who).filter(action =>
        !(action.type === 'buy' && String(action.cardId).startsWith('__opaque_reserve_')));
    }

    // Simulate only public information and select the same legacy discard/noble
    // settlement unless a tactical line explicitly needs the better noble choice.
    function simulateSettled(state, action, who, rules, noblePolicy = 'legacy') {
      const scratch = rules.copyState(state);scratch.turn = who;scratch.rulePhase = 'action';
      const applied = rules.executeAction(scratch, action, who);
      if (!applied.ok) return null;
      const choices = { discardColors: [] };let pending = rules.prepareSettlement(scratch, who),guard = 0;
      while (pending.type !== 'complete' && guard++ < 12) {
        if (pending.type === 'discard') {
          const observation = rules.observe(scratch, who),suggested = Legacy.discardColors(observation) || [];
          const action = suggested.find(color => rules.legalActions(scratch, who).some(candidate => candidate.type === 'discard' && candidate.color === color))
            ? { type: 'discard', color: suggested.find(color => rules.legalActions(scratch, who).some(candidate => candidate.type === 'discard' && candidate.color === color)) }
            : rules.legalActions(scratch, who).find(candidate => candidate.type === 'discard');
          if (!action) return null;
          choices.discardColors.push(action.color);
          if (!rules.executeAction(scratch, action, who).ok) return null;
        } else if (pending.type === 'noble') {
          const observation = rules.observe(scratch, who);
          choices.nobleId = noblePolicy === 'advanced'
            ? Advanced.chooseNoble(observation, pending.options) : pending.options[0];
          if (!rules.executeAction(scratch, { type: 'noble', id: choices.nobleId }, who).ok) return null;
        } else return null;
        pending = rules.prepareSettlement(scratch, who);
      }
      if (pending.type !== 'complete') return null;
      const result = rules.simulate(state, action, choices);
      return result.ok && !result.pending ? { ...result, choices } : null;
    }

    function terminalWinner(state, self, rules) {
      if (state.over) return rules.winnerSide(state) === self;
      if (!state.endTrigger) return false;
      const responder = state.turn;
      if (responder !== 1 - self) return false;
      const replies = visibleLegalActions(state, responder, rules);
      // No legal final response is a blocked game, not a proven win for either side.
      if (!replies.length) return false;
      // Purchases are the only action class that can change a completed score.
      // Keep one legal non-purchase as the representative of the unchanged line.
      const outcomeChanging = replies.filter(action => action.type === 'buy');
      const unchanged = replies.find(action => action.type !== 'buy');
      if (unchanged) outcomeChanging.push(unchanged);
      return outcomeChanging.every(action => {
        const result = simulateSettled(state, action, responder, rules, 'advanced');
        return !!result && result.state.over && rules.winnerSide(result.state) === self;
      });
    }

    function forcedWinningActions(state, actor, rules) {
      // Only purchases can change score here. Takes and reserves cannot award a
      // noble because they do not add a permanent bonus.
      const candidates = visibleLegalActions(state, actor, rules).filter(action => action.type === 'buy');
      const winning = [];
      for (const action of candidates) {
        const result = simulateSettled(state, action, actor, rules, 'advanced');
        if (result && terminalWinner(result.state, actor, rules)) winning.push({ action, result });
      }
      return winning;
    }

    function pointsAfter(state, action, self, rules) {
      const result = simulateSettled(state, action, self, rules, 'advanced');
      return result ? { result, gained: result.state.players[self].score - state.players[self].score } : null;
    }

    function terminalTactic(observation, state, baseAction, rules) {
      const self = observation.self, legal = visibleLegalActions(state, self, rules), wins = [];
      for (const action of legal) {
        if (action.type !== 'buy') continue;
        const evaluated = pointsAfter(state, action, self, rules);
        if (evaluated && terminalWinner(evaluated.result.state, self, rules)) wins.push({ action, ...evaluated });
      }
      if (wins.length && !wins.some(candidate => actionKey(candidate.action) === actionKey(baseAction))) {
        wins.sort((a, b) => b.gained - a.gained || Number(b.action.type === 'buy') - Number(a.action.type === 'buy')
          || actionKey(a.action).localeCompare(actionKey(b.action)));
        return { action: wins[0].action, kind: 'forced-win', evidence: { winningActions: wins.map(item => item.action) } };
      }

      const base = simulateSettled(state, baseAction, self, rules, 'legacy');
      if (!base || base.state.over) return null;
      const opponent = 1 - self, threats = forcedWinningActions(base.state, opponent, rules);
      if (!threats.length) return null;
      const threatenedMarketIds = new Set(threats.map(item => item.action.cardId)
        .filter(id => base.state.market && [1, 2, 3].some(tier => base.state.market[tier].some(card => card.id === id))));
      const defenses = [];
      for (const id of threatenedMarketIds) for (const type of ['buy', 'reserve']) {
        const action = type === 'buy' ? { type, cardId: id } : { type, cardId: id };
        if (!rules.validateAction(state, action, self).ok) continue;
        const result = simulateSettled(state, action, self, rules, 'advanced');
        if (!result || (result.state.over && rules.winnerSide(result.state) !== self)) continue;
        if (!result.state.over && forcedWinningActions(result.state, opponent, rules).length) continue;
        defenses.push({ action, result, gained: result.state.players[self].score - state.players[self].score });
      }
      if (!defenses.length) return null;
      defenses.sort((a, b) => Number(b.action.type === 'buy') - Number(a.action.type === 'buy')
        || b.gained - a.gained || actionKey(a.action).localeCompare(actionKey(b.action)));
      return { action: defenses[0].action, kind: 'threat-defense', evidence: {
        forcedThreats: threats.map(item => item.action), defensiveAction: defenses[0].action,
      } };
    }

    function hasCurrentCommitment(state, observation, rules, knownIds) {
      const self = observation.self;
      return state.players[self].reserved.some(card => {
        if (!knownIds.has(card.id)) return false;
        const plan = Advanced._internals.acquisitionPlan(state, card, rules, self, knownIds, observation, configuration.planNodes);
        return !!plan && plan.turns <= 1;
      });
    }

    // Compare only the public position represented by the observation-backed
    // shadow state. Turn counters, RNG, and opaque deck identities are excluded.
    function publicPositionKey(state) {
      return JSON.stringify({
        bank: state.bank,
        market: Object.fromEntries([1, 2, 3].map(tier => [tier, state.market[tier].map(card => card.id)])),
        drawCounts: Object.fromEntries([1, 2, 3].map(tier => [tier, state.deck[tier].length])),
        nobles: state.nobles.map(noble => noble.id),
        players: state.players.map(player => ({ score: player.score, tokens: player.tokens,
          bonuses: player.bonuses, cards: player.cards.map(card => card.id),
          nobles: player.nobles.map(noble => noble.id), reserved: player.reserved.map(card => card.id) })),
      });
    }

    function scoreUnlocksEngine(state, postPurchase, observation, rules, knownIds, reservedId) {
      const goals = [3, 2, 1].flatMap(tier => observation.market[tier])
        .filter(card => card.score > 0 && card.id !== reservedId);
      for (const goal of goals) {
        const before = Advanced._internals.acquisitionPlan(state, goal, rules, observation.self,
          knownIds, observation, configuration.planNodes);
        if (!before) continue;
        const projected = rules.copyState(postPurchase);projected.turn = observation.self;projected.rulePhase = 'action';
        const projectedObservation = rules.observe(projected, observation.self);
      // Replacements in a simulated deck are opaque placeholders. Preserve the
      // original public-card set so those synthetic ids never become targets.
      const projectedKnown = knownIds;
        const after = Advanced._internals.acquisitionPlan(projected, goal, rules, observation.self,
          projectedKnown, projectedObservation, configuration.planNodes);
        if (after && before.turns - after.turns >= 1) return { cardId: goal.id, actionsSaved: before.turns - after.turns };
      }
      return null;
    }

    function reserveTactic(observation, state, baseAction, rules, audit) {
      const self = observation.self, player = state.players[self], knownIds = knownIdsOf(observation);
      audit.calls++;
      if (baseAction.type !== 'take') { audit.rejectedBaseAction++; return null; }
      if (player.reserved.length >= 3) { audit.rejectedFullSlots++; return null; }
      if (state.bank.y <= 0) { audit.rejectedNoGold++; return null; }
      if (hasCurrentCommitment(state, observation, rules, knownIds)) { audit.rejectedCommitment++; return null; }
      const baseline = simulateSettled(state, baseAction, self, rules, 'legacy');
      if (!baseline) { audit.rejectedBaselineSimulation++; return null; }
      const noProgress = publicPositionKey(state) === publicPositionKey(baseline.state);
      if (noProgress) audit.zeroProgressBase++;
      const market = [3, 2, 1].flatMap(tier => state.market[tier]).filter(card => knownIds.has(card.id));
      audit.eligibleDecisions++;
      const candidates = [];
      for (const target of market) {
        audit.targets++;
        if (target.score === 0 && ![3, 2, 1].flatMap(tier => state.market[tier])
          .some(card => card.score > 0 && (card.cost[target.color] || 0) > 0)) { audit.rejectedZeroNoUnlock++; continue; }
        const direct = Advanced._internals.acquisitionPlan(state, target, rules, self, knownIds,
          observation, configuration.planNodes);
        if (!direct) { audit.rejectedNoDirectPlan++; continue; }
        if (!configuration.reservationRouteFix && direct.turns < 2) { audit.rejectedDirectUnderTwo++; continue; }
        const action = { type: 'reserve', cardId: target.id };
        const sim = simulateSettled(state, action, self, rules, 'legacy');
        if (!sim || sim.state.players[self].reserved.length > 3) { audit.rejectedReserveSimulation++; continue; }
        const planned = rules.copyState(sim.state);planned.turn = self;planned.rulePhase = 'action';
        const plannedObservation = rules.observe(planned, self), plannedKnown = knownIds;
        const heldTarget = planned.players[self].reserved.find(card => card.id === target.id);
        if (!heldTarget) { audit.rejectedTargetMissing++; continue; }
        const after = Advanced._internals.acquisitionPlan(planned, heldTarget, rules, self,
          plannedKnown, plannedObservation, configuration.planNodes);
        if (!after) { audit.rejectedNoPostReservePlan++; continue; }
        if (after.turns > 1) { audit.rejectedBeyondTwoActions++; continue; }
        const immediateRoute = configuration.reservationRouteFix && direct.turns === 1
          && direct.actions.length === 1 && direct.actions[0].action.type === 'reserve'
          && direct.actions[0].action.cardId === target.id && after.turns === 0;
        if (configuration.reservationRouteFix && direct.turns < 2 && !immediateRoute) {
          audit.rejectedDirectUnderTwo++; continue;
        }
        let baselinePlan = null, baselineReplay = null;
        if (immediateRoute) {
          const baselineTarget = baseline.state.market[target.tier].find(card => card.id === target.id);
          if (!baselineTarget) { audit.rejectedBaselineTargetMissing++; continue; }
          const baselineState = rules.copyState(baseline.state);baselineState.turn = self;baselineState.rulePhase = 'action';
          const baselineObservation = rules.observe(baselineState, self);
          baselinePlan = Advanced._internals.acquisitionPlan(baselineState, baselineTarget, rules, self,
            knownIds, baselineObservation, configuration.planNodes);
          if (!baselinePlan) { audit.rejectedNoBaselinePlan++; continue; }
          baselineReplay = Advanced._internals.applyPlanAndBuy(baselineState, baselineTarget, baselinePlan,
            rules, self, baselineObservation, knownIds);
          if (!baselineReplay) { audit.rejectedBaselinePlanReplay++; continue; }
        }
        // The base action and candidate reserve both consume the current turn.
        // Compare the remaining, rule-replayed resource actions after each one;
        // do not subtract the reserve action again from a plan that already
        // starts after the base action has settled.
        const actionSavings = immediateRoute ? baselinePlan.turns - after.turns : direct.turns - after.turns - 1;
        const slotActionCost = 0.5 + player.reserved.length * 0.5;
        let goldActionBenefit = 0;
        if (sim.state.players[self].tokens.y > player.tokens.y) {
          const withoutGold = rules.copyState(planned);
          withoutGold.players[self].tokens.y--;withoutGold.bank.y++;
          const noGoldPlan = Advanced._internals.acquisitionPlan(withoutGold, heldTarget, rules, self,
            plannedKnown, plannedObservation, configuration.planNodes);
          if (noGoldPlan) goldActionBenefit = Math.max(0, noGoldPlan.turns - after.turns);
        }
        const verified = Advanced._internals.applyPlanAndBuy(planned, heldTarget, after, rules, self,
          plannedObservation, plannedKnown);
        if (!verified) { audit.rejectedPlanReplay++; continue; }
        let unlock = null;
        if (target.score === 0) unlock = scoreUnlocksEngine(state, verified.state, observation, rules, knownIds, target.id);
        if (target.score === 0 && !unlock) { audit.rejectedZeroNoScoringUnlock++; continue; }
        const opponentCanBuyTarget = rules.price(target, state.players[1 - self]).left === 0;
        if (immediateRoute && !noProgress && !opponentCanBuyTarget) {
          audit.rejectedImmediateNoTacticalGain++; continue;
        }
        const meetsNetCost = actionSavings >= 1 + slotActionCost
          || goldActionBenefit >= 1 && actionSavings >= slotActionCost;
        const noProgressBenefit = !meetsNetCost && configuration.zeroProgressComparison && noProgress && immediateRoute
          && actionSavings >= 0 && slotActionCost <= 1 && (target.score > 0 || !!unlock)
          && (actionSavings >= slotActionCost || goldActionBenefit >= 1 || opponentCanBuyTarget);
        if (!meetsNetCost && !noProgressBenefit) {
          audit.rejectedNetCost++; continue;
        }
        audit.candidates++;
        candidates.push({ action, evidence: {
          targetId: target.id, targetScore: target.score, resourceActionsWithoutReserve: direct.turns,
          resourceActionsAfterReserve: after.turns, buyWithinOwnActions: after.turns + 1,
          totalOwnActionsIncludingReserve: 1 + after.turns + 1,
          baselineResourceActionsAfterCurrentAction: baselinePlan?.turns ?? null,
          actionsSaved: actionSavings, slotActionCost, goldReceived: sim.state.players[self].tokens.y - player.tokens.y,
          goldActionBenefit, opponentCanBuyTarget, acceptedByZeroProgressComparison: !!noProgressBenefit,
          slotsBefore: player.reserved.length, slotsAfterReserve: sim.state.players[self].reserved.length,
          replayablePlan: after.actions, zeroPointEngineUnlock: unlock,
        } });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.evidence.actionsSaved - a.evidence.actionsSaved
        || b.evidence.targetScore - a.evidence.targetScore || a.evidence.targetId.localeCompare(b.evidence.targetId));
      return { ...candidates[0], kind: 'target-reserve' };
    }

    function zeroProgressTactic(observation, state, baseAction, rules, audit) {
      audit.calls++;
      if (!configuration.zeroProgressComparison || baseAction.type !== 'take') return null;
      const self = observation.self, knownIds = knownIdsOf(observation);
      const baseline = simulateSettled(state, baseAction, self, rules, 'legacy');
      if (!baseline || publicPositionKey(state) !== publicPositionKey(baseline.state)) return null;
      audit.zeroProgressPositions++;
      const routeBudget = Math.min(configuration.planNodes, 12);
      const baseState = rules.copyState(baseline.state);baseState.turn = self;baseState.rulePhase = 'action';
      const baseObservation = rules.observe(baseState, self);
      const goals = [3, 2, 1].flatMap(tier => state.market[tier])
        .concat(state.players[self].reserved.filter(card => knownIds.has(card.id)))
        .filter(card => knownIds.has(card.id) && card.score > 0);
      const baseRoutes = [];
      for (const target of goals) {
        const basePlan = Advanced._internals.acquisitionPlan(baseState, target, rules, self,
          knownIds, baseObservation, routeBudget);
        if (!basePlan) continue;
        const replay = Advanced._internals.applyPlanAndBuy(baseState, target, basePlan,
          rules, self, baseObservation, knownIds);
        if (replay) baseRoutes.push({ target, turns: basePlan.turns });
      }
      const heldIds = new Set(state.players[self].reserved.map(card => card.id));
      baseRoutes.sort((a, b) => Number(heldIds.has(b.target.id)) - Number(heldIds.has(a.target.id))
        || b.target.score - a.target.score || a.turns - b.turns || a.target.id.localeCompare(b.target.id));
      baseRoutes.length = Math.min(baseRoutes.length, 4);
      const candidates = [], routeOptions = [];
      for (const action of visibleLegalActions(state, self, rules)) {
        if (!['take', 'reserve', 'buy'].includes(action.type) || actionKey(action) === actionKey(baseAction)) continue;
        const result = simulateSettled(state, action, self, rules, 'legacy');
        if (!result) continue;
        if (action.type === 'buy') {
          const gained = result.state.players[self].score - state.players[self].score;
          if (gained > 0) candidates.push({ action, target: result.state.players[self].cards.at(-1),
            beforeTurns: 0, afterTurns: 0, saved: 0, plan: [], immediateScore: gained,
            slotActionCost: 0, goldReceived: 0 });
          continue;
        }
        let bestRoute = null;
        for (const route of baseRoutes) {
          const target = result.state.market[route.target.tier].find(card => card.id === route.target.id)
            || result.state.players[self].reserved.find(card => card.id === route.target.id);
          if (!target) continue;
          const beforeLeft = rules.price(route.target, baseState.players[self]).left;
          const afterLeft = rules.price(target, result.state.players[self]).left;
          const relief = beforeLeft - afterLeft;
          if (relief <= 0) continue;
          const candidateRoute = { route, target, result, relief };
          if (!bestRoute || relief > bestRoute.relief || relief === bestRoute.relief
            && (target.score > bestRoute.target.score || target.score === bestRoute.target.score
              && target.id.localeCompare(bestRoute.target.id) < 0)) bestRoute = candidateRoute;
        }
        if (bestRoute) routeOptions.push({ action, ...bestRoute });
      }
      routeOptions.sort((a, b) => b.relief - a.relief || b.target.score - a.target.score
        || Number(b.action.type === 'reserve') - Number(a.action.type === 'reserve')
        || actionKey(a.action).localeCompare(actionKey(b.action)));
      audit.candidateActions = routeOptions.length;
      for (const option of routeOptions.slice(0, 3)) {
          const { action, route, target, result } = option;
          const nextState = rules.copyState(result.state);nextState.turn = self;nextState.rulePhase = 'action';
          const nextObservation = rules.observe(nextState, self);
          const plan = Advanced._internals.acquisitionPlan(nextState, target, rules, self,
            knownIds, nextObservation, routeBudget);
          if (!plan || plan.turns >= route.turns || plan.turns > 2) continue;
          audit.searchedRoutes++;
          const verified = Advanced._internals.applyPlanAndBuy(nextState, target, plan,
            rules, self, nextObservation, knownIds);
          if (!verified) continue;
          const slotActionCost = action.type === 'reserve' ? 0.5 + state.players[self].reserved.length * 0.5 : 0;
          if (action.type === 'reserve' && (slotActionCost > 1 || route.turns - plan.turns < slotActionCost)) continue;
          audit.verifiedAlternatives++;
          candidates.push({ action, target, beforeTurns: route.turns, afterTurns: plan.turns,
            saved: route.turns - plan.turns, plan: plan.actions, slotActionCost,
            goldReceived: result.state.players[self].tokens.y - state.players[self].tokens.y,
            discardColors: result.choices.discardColors || [] });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => (b.immediateScore || 0) - (a.immediateScore || 0)
        || b.saved - a.saved || b.target.score - a.target.score
        || a.target.id.localeCompare(b.target.id) || actionKey(a.action).localeCompare(actionKey(b.action)));
      const best = candidates[0];
      return { action: best.action, kind: best.immediateScore ? 'zero-progress-score' : 'zero-progress-route', evidence: {
        targetId: best.target.id, targetScore: best.target.score, resourceActionsBefore: best.beforeTurns,
        resourceActionsAfter: best.afterTurns, actionsSaved: best.saved, replayablePlan: best.plan,
        immediateScoreGain: best.immediateScore || 0, reservedCardId: best.action.type === 'reserve' ? best.action.cardId : null,
        goldReceived: best.goldReceived, slotActionCost: best.slotActionCost,
        discardColors: best.discardColors || [],
      } };
    }

    function scoringTactic(observation, state, baseAction, rules) {
      const self = observation.self, player = state.players[self], opponent = state.players[1 - self];
      const diversity = COLORS.filter(color => player.bonuses[color] > 0).length;
      const discounts = COLORS.reduce((sum, color) => sum + player.bonuses[color], 0);
      const mature = discounts >= 4 && diversity >= 3 || (player.cards.length >= 5)
        || player.score >= 7 || opponent.score >= 9;
      const baseResult = simulateSettled(state, baseAction, self, rules, 'legacy');
      const baseGain = baseResult ? baseResult.state.players[self].score - player.score : 0;
      const candidates = [];
      for (const action of visibleLegalActions(state, self, rules).filter(value => value.type === 'buy')) {
        const card = [...[3, 2, 1].flatMap(tier => state.market[tier]), ...player.reserved].find(value => value.id === action.cardId);
        if (!card || card.score <= 0) continue;
        const result = pointsAfter(state, action, self, rules);
        if (!result || result.gained < 2 || result.gained < baseGain + 2) continue;
        if (!mature && result.gained < 4) continue;
        candidates.push({ action, gained: result.gained, cardScore: card.score });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.gained - a.gained || b.cardScore - a.cardScore || actionKey(a.action).localeCompare(actionKey(b.action)));
      return { ...candidates[0], kind: 'score-purchase', evidence: {
        cardScore: candidates[0].cardScore, immediateScoreGain: candidates[0].gained,
        engine: { ownedCards: player.cards.length, discountCount: discounts, discountColors: diversity,
          score: player.score, opponentScore: opponent.score, mature },
        actionCost: 1, baselineImmediateScoreGain: baseGain,
      } };
    }

    function decide(observation, rules, rng = 0) {
      if (!rules?.legalActions || observation?.turn !== observation?.self) throw new TypeError('Hybrid expects a current legal observation and P1 rules');
      const beforeState = stateOf(observation), self = observation.self, legal = visibleLegalActions(beforeState, self, rules);
      const baseline = Legacy.decide(observation, rng), legacyAction = baseline.action;
      let action = legacyAction, override = null, settlementChoices = null, adapterFallback = false;
      const validBase = legacyAction && rules.validateAction(beforeState, legacyAction, self).ok;
      if (!validBase) {
        if (!legal.length) return { strategyId: 'hybrid-v1', action: null, nextRng: baseline.nextRng,
          status: 'blocked_no_legal_action', diagnostics: { legacyAction: legacyAction || null, legalActions: 0, configuration } };
        action = legal[0];adapterFallback = true;
      }
      if (!action) return { strategyId: 'hybrid-v1', action: null, nextRng: baseline.nextRng,
        status: legal.length ? 'legacy_adapter_failure' : 'blocked_no_legal_action',
        diagnostics: { legacyAction: null, legalActions: legal.length, configuration } };

      const tacticalState = beforeState, reserveAudit = Object.fromEntries([
        'calls', 'eligibleDecisions', 'targets', 'candidates', 'rejectedBaseAction', 'rejectedFullSlots',
        'rejectedNoGold', 'rejectedCommitment', 'rejectedZeroNoUnlock', 'rejectedNoDirectPlan',
        'rejectedDirectUnderTwo', 'rejectedReserveSimulation', 'rejectedTargetMissing',
        'rejectedNoPostReservePlan', 'rejectedBeyondTwoActions', 'rejectedNetCost',
        'rejectedPlanReplay', 'rejectedZeroNoScoringUnlock', 'rejectedBaselineSimulation',
        'rejectedBaselineTargetMissing', 'rejectedNoBaselinePlan', 'rejectedBaselinePlanReplay',
        'rejectedImmediateNoTacticalGain',
        'zeroProgressBase', 'zeroProgressAccepted',
      ].map(key => [key, 0]));
      const zeroProgressAudit = { calls: 0, zeroProgressPositions: 0, candidateActions: 0,
        searchedRoutes: 0, verifiedAlternatives: 0 };
      if (!adapterFallback && configuration.terminal) override = terminalTactic(observation, tacticalState, action, rules);
      if (!override && !adapterFallback && configuration.scoring) override = scoringTactic(observation, tacticalState, action, rules);
      if (!override && !adapterFallback && configuration.reservation) override = reserveTactic(observation, tacticalState, action, rules, reserveAudit);
      if (!override && !adapterFallback && configuration.zeroProgressComparison) {
        override = zeroProgressTactic(observation, tacticalState, action, rules, zeroProgressAudit);
      }
      if (override?.evidence?.acceptedByZeroProgressComparison) reserveAudit.zeroProgressAccepted++;
      if (override) action = override.action;
      const settled = simulateSettled(tacticalState, action, self, rules, override ? 'advanced' : 'legacy');
      if (settled) settlementChoices = settled.choices;
      return { strategyId: 'hybrid-v1', action: clone(action), nextRng: baseline.nextRng,
        settlementChoices: settlementChoices || { discardColors: [] },
        status: 'ok', diagnostics: { legacyAction: clone(legacyAction), selectedAction: clone(action),
          override: override ? { kind: override.kind, evidence: override.evidence } : null,
          adapterFallback, legalActionCount: legal.length, configuration,
          ...(configuration.reservation ? { reserveAudit } : {}),
          ...(configuration.zeroProgressComparison ? { zeroProgressAudit } : {}) } };
    }

    return Object.freeze({ strategyId: 'hybrid-v1', configuration, decide,
      discardColors: observation => Legacy.discardColors(observation),
      chooseNoble: (observation, options) => Advanced.chooseNoble(observation, options),
    });
  }

  return Object.freeze({ strategyId: 'hybrid-v1', create });
});
