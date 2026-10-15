'use strict';

// Test-only adapter. The original IIFE is evaluated in an isolated VM; production
// code does not gain a debug API, a DOM dependency or a new runtime script.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const BASELINE = path.join(ROOT, 'tests/baseline/legacy-v1.html');
const COLORS = ['w', 'u', 'g', 'r', 'k'];
const ALL = [...COLORS, 'y'];
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures', name), 'utf8'));

function expandDecisionInput(input) {
  const state = plain(input), data = fixture('classic-data-v1.json');
  const byId = new Map(data.cards.map(card => [card.id, card]));
  const nobleById = new Map(data.nobles.map(noble => [noble.id, noble]));
  const card = value => {
    if (typeof value === 'string') return plain(byId.get(value));
    // A compact object retains flags such as blindReserved on owned cards.
    return { ...plain(byId.get(value.id)), ...value };
  };
  const noble = value => typeof value === 'number' ? plain(nobleById.get(value)) : value;
  for (const tier of [1, 2, 3]) {
    state.market[tier] = state.market[tier].map(card);
    state.deck[tier] = state.deck[tier].map(card);
  }
  state.nobles = state.nobles.map(noble);
  for (const player of state.players) {
    player.cards = player.cards.map(card);
    player.reserved = player.reserved.map(card);
    player.nobles = player.nobles.map(noble);
  }
  return state;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function loadGame({ baseline = false, saved = null, shuffleSeed = 1 } = {}) {
  const html = fs.readFileSync(baseline ? BASELINE : path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1, 'Game must retain inline scripts for standalone use');
  const mainIndex = scripts.findIndex(script => script[1].includes("(()=>{'use strict';"));
  assert.ok(mainIndex >= 0, 'Cannot find game IIFE');
  const main = scripts[mainIndex][1];
  const marker = "try{const saved=JSON.parse(localStorage.getItem('splendor_classic_v4')";
  const offset = main.indexOf(marker);
  assert.ok(offset >= 0, 'Cannot find saved-game initialization; update the test adapter explicitly');
  const effects = { renders: 0, landings: 0, writes: [], downloads: [], timers: new Map(), nextTimer: 1 };
  const storage = new Map([['splendor_plus_animation', 'off']]);
  if (saved) storage.set('splendor_classic_v4', JSON.stringify(saved));
  const classList = { toggle() {}, add() {}, remove() {} };
  const math = Object.create(Math);
  math.random = seededRandom(shuffleSeed);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-14T00:00:00.000Z'])); }
    static now() { return new Date('2026-10-14T00:00:00.000Z').getTime(); }
  }
  const context = {
    Math: math, Date: FixedDate, Blob, console, effects,
    document: {
      body: { classList, appendChild() {} },
      querySelectorAll: () => [], querySelector: () => null,
      getElementById: () => null, addEventListener() {},
      createElement: () => ({ click() {}, remove() {} }),
    },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) {
        storage.set(key, String(value));
        effects.writes.push({ key, value: String(value) });
      },
    },
    URL: {
      createObjectURL(blob) { effects.downloads.push(blob); return 'blob:test-only'; },
      revokeObjectURL() {},
    },
    setTimeout(callback, delay) {
      const id = effects.nextTimer++;
      effects.timers.set(id, { callback: () => { effects.timers.delete(id);callback(); }, delay });
      return id;
    },
    clearTimeout: id => effects.timers.delete(id),
    confirm: () => true,
    alert: message => { throw new Error('Unexpected alert: ' + message); },
  };
  const bridge = `
// Injected only inside the test VM. Keep rules, logs, save/load and RNG original.
render=()=>{effects.renders++};
renderLanding=()=>{effects.landings++};
captureActionFX=()=>{};
globalThis.game={
  CARD_ROWS,NOBLE_ROWS,CARD_POOL,NOBLES,COLORS,ALL,
  mkPlayer,newGame,validateBoardSetup,setupFingerprint,downloadBoardSetup,
  getBoardHistory,rememberSetup,publicSnapshot,exportReplay,save,
  price,canBuy,canTake,owned,marketOf,findCard,getMarketCards,allOptions,
  pay,take,reserve,blindReserve,eligible,gainNoble,autoDiscard,
  afterAction,goNext,gameOver,playerBuy,playerReserve,playerBlind,playerTake,
  selectGem,selectCard,setTokenMode,endModalChoice,discardOne,
  weightedColor,lookAhead,usefulTake,botRandom,botTurn,
  matchMode,isHumanTurn,viewWho,makeMatchSetupHTML,dispatch,
  scheduleBot:typeof scheduleBot==='undefined'?null:scheduleBot,
  rules:typeof Rules==='undefined'?null:Rules,
  legacy:typeof Legacy==='undefined'?null:Legacy,
  advanced:typeof Advanced==='undefined'?null:Advanced,
  hybrid:typeof HybridC==='undefined'?null:HybridC,
  hybridConfig:typeof HYBRID_C_CONFIG==='undefined'?null:HYBRID_C_CONFIG,
  hybridConfigId:typeof HYBRID_C_CONFIG_ID==='undefined'?null:HYBRID_C_CONFIG_ID,
  policyForState:typeof policyForState==='undefined'?null:policyForState,
  observation:who=>typeof Rules==='undefined'?null:Rules.observe(S,who),
  getState:()=>S,setState:value=>{S=value}
};
`;
  const source = main.slice(0, offset) + bridge + main.slice(offset);
  vm.createContext(context);
  for (let i = 0; i < mainIndex; i++) vm.runInContext(scripts[i][1], context, { timeout: 5000 });
  vm.runInContext(source, context, { filename: baseline ? 'legacy-v1.html' : 'index.html', timeout: 5000 });
  return { api: context.game, effects, storage };
}

function startGame(options = {}) {
  const harness = loadGame(options);
  harness.api.newGame('restore', fixture('board-seed-v1.json'), {
    mode: options.mode || 'ai', names: ['玩家1', options.mode === 'pvp' ? '玩家2' : 'AI'],
  });
  return harness;
}

function acquireCard(api, who, id) {
  // Build focused legal states without fabricating cards or losing pile entries.
  const state = api.getState();
  let card;
  for (const tier of [1, 2, 3]) {
    const marketIndex = state.market[tier].findIndex(value => value.id === id);
    if (marketIndex >= 0) {
      card = state.market[tier][marketIndex];
      const replacement = state.deck[tier].pop();
      if (replacement) state.market[tier][marketIndex] = replacement;
      else state.market[tier].splice(marketIndex, 1);
      break;
    }
    const deckIndex = state.deck[tier].findIndex(value => value.id === id);
    if (deckIndex >= 0) { card = state.deck[tier].splice(deckIndex, 1)[0]; break; }
  }
  assert.ok(card, `Card ${id} is not in the market or deck`);
  state.players[who].cards.push(card);
  state.players[who].bonuses[card.color]++;
  state.players[who].score += card.score;
  return card;
}

function giveTokens(api, who, counts) {
  const state = api.getState();
  for (const [color, count] of Object.entries(counts)) {
    assert.ok(ALL.includes(color) && Number.isInteger(count) && count >= 0);
    assert.ok(state.bank[color] >= count, `Insufficient bank ${color}`);
    state.bank[color] -= count;
    state.players[who].tokens[color] += count;
  }
}

function assertInvariants(api, { settled = false } = {}) {
  const state = api.getState();
  for (const color of ALL) {
    const values = [state.bank[color], ...state.players.map(player => player.tokens[color])];
    for (const value of values) assert.ok(Number.isInteger(value) && value >= 0, `Invalid ${color} token count`);
    assert.equal(values.reduce((a, b) => a + b, 0), color === 'y' ? 5 : 4, `${color} conservation`);
  }
  const cards = [1, 2, 3].flatMap(tier => [...state.deck[tier], ...state.market[tier]])
    .concat(state.players.flatMap(player => [...player.cards, ...player.reserved]));
  assert.equal(cards.length, 90, 'Card conservation');
  assert.equal(new Set(cards.map(card => card.id)).size, 90, 'Card identity conservation');
  for (const player of state.players) {
    assert.equal(player.score, player.cards.reduce((sum, card) => sum + card.score, 0) + 3 * player.nobles.length);
    for (const color of ALL) assert.equal(player.bonuses[color], player.cards.filter(card => card.color === color).length);
    assert.ok(player.reserved.length <= 3);
    if (settled) assert.ok(ALL.reduce((sum, color) => sum + player.tokens[color], 0) <= 10);
  }
  const nobleIds = [...state.nobles, ...state.players.flatMap(player => player.nobles)].map(noble => noble.id);
  assert.deepEqual([...nobleIds].sort((a, b) => a - b), [...state.setup.nobleIds].sort((a, b) => a - b));
  assert.equal(new Set(nobleIds).size, 3, 'Noble conservation');
}

module.exports = { ROOT, BASELINE, COLORS, ALL, plain, fixture, expandDecisionInput, seededRandom, loadGame, startGame, acquireCard, giveTokens, assertInvariants };
