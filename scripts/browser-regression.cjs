'use strict';
require('../tests/helpers/p3-playwright-env.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { ROOT, fixture, expandDecisionInput, startGame, loadGame, plain, giveTokens } = require('../tests/helpers/game-harness.cjs');
const Hybrid = require('../js/hybrid-v1.js');
const HybridCConfig = Object.freeze({ terminal: true, reservation: true, scoring: true,
  reservationRouteFix: true, zeroProgressComparison: true, planNodes: 16 });
const HybridCConfigId = 'b10785820427d5e0cc516c51538ffb9ca019ea5ce9036fadd0aee5b32d392a1c';
const V2CConfigId = '79d417842cf84f158a08d3db4910fd8ffd4d2f5e3c82e6a83df67485fb63d572';
const actionFromReplay = event => event.action.type === 'take' ? { type: 'take', colors: event.action.colors }
  : event.action.type === 'blind_reserve' ? { type: 'blind_reserve', tier: event.action.tier }
    : { type: event.action.type, cardId: event.action.card.id };
const playwright = require(process.env.SPLENDOR_PLAYWRIGHT_MODULE || 'playwright');
const reportDir = process.env.SPLENDOR_BROWSER_REPORT_DIR || path.join(os.tmpdir(), 'splendor-p1-browser-report');
fs.mkdirSync(reportDir, { recursive: true });

const report = { playwright: require(path.join(path.dirname(require.resolve(process.env.SPLENDOR_PLAYWRIGHT_MODULE || 'playwright')), 'package.json')).version,
  platform: process.platform, tests: [], performance: [], limitations: ['Mobile viewports use actual Linux browser engines, not physical iPhone Safari.'] };
const profiles = {
  desktop: { viewport: { width: 1440, height: 900 } },
  portrait: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  smallPortrait: { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const readState = page => page.evaluate(() => JSON.parse(localStorage.getItem('splendor_classic_v4')));
const waitState = (page, predicate) => page.waitForFunction(predicate, undefined, { timeout: 6000 });
const gameplayKeys = ['players', 'bank', 'market', 'deck', 'nobles', 'setup', 'botRng', 'turn', 'round', 'endTrigger', 'over', 'replay'];
const assertGameplay = (actual, expected) => { for (const key of gameplayKeys) assert.deepEqual(actual[key], expected[key], key); };
const clickAction = (page, action, mobile = false) => page.locator(`${mobile ? '.mobile-action-dock' : '.side'} [data-act="${action}"]`).click();
async function takeThree(page, mobile = false, colors = ['w', 'u', 'g']) {
  for (const color of colors) await page.locator(`[data-act="gem"][data-color="${color}"]`).click();
  await clickAction(page, 'take', mobile);
}

function goldPurchaseSave() {
  const { api } = startGame({ baseline: true, mode: 'pvp' }), state = api.getState(), card = state.market[1][0];
  api.reserve(card, 0);
  const tokens = { ...card.cost };tokens[Object.keys(tokens)[0]]--;
  giveTokens(api, 0, tokens);api.afterAction(0);
  const available = api.COLORS.filter(color => state.bank[color] > 0);
  api.take(available.slice(0, 3), 1);api.afterAction(1);
  return { saved: plain(state), id: card.id };
}

async function main() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.endsWith('favicon.ico')) { response.writeHead(204);response.end();return; }
    if (pathname === '/splendor-mobile/' || pathname === '/splendor-mobile/index.html' || pathname === '/baseline.html') {
      const file = pathname === '/baseline.html' ? path.join(ROOT, 'tests/baseline/legacy-v1.html') : path.join(ROOT, 'index.html');
      response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' });response.end(fs.readFileSync(file));
    } else { response.writeHead(404);response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/splendor-mobile/index.html`;
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chromium' } : {}) });
      report[engine] = browser.version();
      const run = async (name, { profile = 'desktop', saved = null, animation = 'off', file = false } = {}, fn) => {
        const started = Date.now(), context = await browser.newContext({ ...profiles[profile], acceptDownloads: true });
        const page = await context.newPage(), errors = [], dialogs = [], requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => requests.push(request.url()));
        page.on('dialog', async dialog => { dialogs.push(dialog.message());await dialog.accept(); });
        await context.addInitScript(({ saved, animation }) => {
          localStorage.setItem('splendor_plus_animation', animation);
          if (saved && !localStorage.getItem('splendor_classic_v4')) localStorage.setItem('splendor_classic_v4', JSON.stringify(saved));
        }, { saved, animation });
        try {
          await page.goto(file ? pathToFileURL(path.join(ROOT, 'index.html')).href : url);
          await fn(page, { dialogs, requests, context });
          assert.deepEqual(errors, [], 'No JavaScript page errors');
          report.tests.push({ engine, name, profile, passed: true, elapsedMs: Date.now() - started });
          console.log(`PASS ${engine}: ${name}`);
        } catch (error) {
          report.tests.push({ engine, name, profile, passed: false, error: error.stack, pageErrors: errors });
          console.error(`FAIL ${engine}: ${name}\n${error.stack}`);
          await page.screenshot({ path: path.join(reportDir, `${engine}-${name.replace(/[^a-z0-9]/gi, '-')}-failure.png`), fullPage: true }).catch(() => {});
        } finally { await context.close(); }
      };
      try {
        await run('difficulty options and PvP visibility', {}, async page => {
          assert.equal(await page.locator('#matchDifficultyRow').isVisible(), true);
          assert.equal(await page.locator('option[value="normal"]').isDisabled(), false);
          assert.equal(await page.locator('option[value="hard"]').isDisabled(), false);
          assert.match(await page.locator('option[value="hard"]').innerText(), /困难（实验版）/);
          await page.locator('input[name="matchMode"][value="pvp"]').check();
          assert.equal(await page.locator('#matchDifficultyRow').isVisible(), false);
          await page.locator('input[name="matchMode"][value="ai"]').check();
          assert.equal(await page.locator('#matchDifficultyRow').isVisible(), true);
          await page.locator('[data-act="match-start"]').click();
          const state = await readState(page);
          assert.equal(state.aiDifficulty, 'easy');assert.equal(state.aiVersion, 'legacy-v1');
          assert.equal(state.matchMode, 'ai');assert.equal(state.rulePhase, 'action');
        });

        await run('normal difficulty executes frozen Hybrid C and persists its configuration', {}, async page => {
          await page.locator('#matchDifficulty').selectOption('normal');
          await page.locator('[data-act="match-start"]').click();
          let state = await readState(page);assert.equal(state.aiDifficulty, 'normal');assert.equal(state.aiVersion, 'hybrid-v1');
          assert.equal(state.aiConfigId, HybridCConfigId);
          await takeThree(page);
          const pending = await readState(page);
          const { create: createRules } = require('../js/rules.js');
          const cards = fixture('classic-data-v1.json').cards;
          const rules = createRules(cards), expected = Hybrid.create(HybridCConfig).decide(rules.observe(pending, 1), rules, pending.botRng);
          await waitState(page, () => { const s = JSON.parse(localStorage.getItem('splendor_classic_v4'));return s.turn === 0 && s.round === 2; });
          state = await readState(page);assert.equal(state.aiDifficulty, 'normal');assert.equal(state.aiVersion, 'hybrid-v1');assert.equal(state.aiConfigId, HybridCConfigId);
          const actual = state.replay.findLast(event => event.actor === 'bot' && ['take', 'buy', 'reserve', 'blind_reserve'].includes(event.action.type));
          assert.deepEqual(actionFromReplay(actual), expected.action, 'The live page dispatcher executes the frozen C policy');
          await page.reload();state = await readState(page);
          assert.equal(state.aiVersion, 'hybrid-v1');assert.equal(state.aiConfigId, HybridCConfigId);
        });

        await run('embedded Hybrid C matches the source module on a fixed public observation', { saved: { ...fixture('save-ai-initial.json'), matchMode: 'pvp' } }, async page => {
          const cards = fixture('classic-data-v1.json').cards, core = require('../js/rules.js').create(cards);
          const sourcePolicy = Hybrid.create(HybridCConfig);
          const samples = [7, 152].map(index => {
            const state = expandDecisionInput(fixture('legacy-decisions-v1.json').cases[index].input);
            state.turn = 1;state.rulePhase = 'action';
            const observation = plain(core.observe(state, 1)), rng = state.botRng || 1;
            return { observation, rng, decision: sourcePolicy.decide(observation, core, rng) };
          });
          assert.equal(samples[0].decision.settlementChoices.nobleId, 1, 'The fixed purchase selects a noble');
          assert.deepEqual(samples[1].decision.settlementChoices.discardColors, ['w'], 'The fixed reserve includes its overflow return');
          const embedded = await page.evaluate(({ cards, samples, config }) => {
            const core = SplendorRules.create(cards), policy = SplendorHybridAI.create(config);
            return samples.map(sample => policy.decide(sample.observation, core, sample.rng));
          }, { cards, samples: samples.map(({ observation, rng }) => ({ observation, rng })), config: HybridCConfig });
          for (const [index, result] of embedded.entries()) {
            assert.deepEqual(result.action, plain(samples[index].decision.action));
            assert.deepEqual(result.settlementChoices, plain(samples[index].decision.settlementChoices));
            assert.equal(result.nextRng, samples[index].decision.nextRng);
          }
        });

        const cSpecificState = expandDecisionInput(fixture('legacy-decisions-v1.json').cases[113].input);
        Object.assign(cSpecificState, { aiDifficulty: 'normal', aiVersion: 'hybrid-v1', aiConfigId: HybridCConfigId,
          matchMode: 'ai', turn: 1, rulePhase: 'action', modal: null });
        await run('normal page dispatch uses C rather than the default A configuration', { saved: cSpecificState }, async page => {
          const cards = fixture('classic-data-v1.json').cards, core = require('../js/rules.js').create(cards);
          const observation = core.observe(cSpecificState, 1);
          const expected = Hybrid.create(HybridCConfig).decide(observation, core, cSpecificState.botRng || 1);
          const defaultA = Hybrid.create().decide(observation, core, cSpecificState.botRng || 1);
          assert.notDeepEqual(expected.action, defaultA.action, 'This state distinguishes C from the module default A');
          await waitState(page, () => { const s = JSON.parse(localStorage.getItem('splendor_classic_v4'));return s.turn === 0 && (s.round > 10 || s.over); });
          const state = await readState(page), actual = state.replay.findLast(event => event.actor === 'bot' && ['take', 'buy', 'reserve', 'blind_reserve'].includes(event.action.type));
          assert.equal(state.aiConfigId, HybridCConfigId);
          assert.deepEqual(actionFromReplay(actual), expected.action);
        });

        await run('historical normal advanced-v1 save remains on advanced-v1', { saved: (() => {
          const value = { ...fixture('save-ai-midgame.json'), aiDifficulty: 'normal', aiVersion: 'advanced-v1',
            matchMode: 'ai', turn: 1, rulePhase: 'action', modal: null, over: false };
          return value;
        })() }, async page => {
          const initial = await readState(page);assert.equal(initial.aiVersion, 'advanced-v1');
          const expected = await page.evaluate(cards => {
            const saved = JSON.parse(localStorage.getItem('splendor_classic_v4'));
            const rules = SplendorRules.create(cards);
            return SplendorAdvancedAI.decide(rules.observe(saved, 1), rules, saved.botRng).action;
          }, fixture('classic-data-v1.json').cards);
          await waitState(page, () => { const s = JSON.parse(localStorage.getItem('splendor_classic_v4'));return s.turn === 0 && s.round > 1; });
          const state = await readState(page);assert.equal(state.aiVersion, 'advanced-v1');
          const actual = state.replay.findLast(event => event.actor === 'bot' && ['take', 'buy', 'reserve', 'blind_reserve'].includes(event.action.type));
          assert.deepEqual(actionFromReplay(actual), expected);
        });

        await run('human vs AI action and legacy equality', { saved: fixture('save-ai-initial.json') }, async page => {
          await takeThree(page);
          const pending = await readState(page);assert.equal(pending.turn, 1);
          const original = loadGame({ baseline: true });original.api.setState(plain(pending));original.api.botTurn();
          await waitState(page, () => { const s = JSON.parse(localStorage.getItem('splendor_classic_v4'));return s.turn === 0 && s.round === 2; });
          const actual = await readState(page), expected = plain(original.api.getState());
          assertGameplay(actual, expected);
          await page.locator('[data-act="history"]').click();
          assert.equal(await page.locator('#actionDrawer.open').isVisible(), true);
          assert.match(await page.locator('#logEntries').innerText(), /拿取/);
          assert.equal(await page.locator('.card.buyable,.card.affordable,.card.can-buy').count(), 0);
        });

        await run('PvP reserve blind reserve and full action log', { saved: { ...fixture('save-ai-initial.json'), matchMode: 'pvp', playerNames: ['甲', '乙'] } }, async page => {
          const first = (await readState(page)).market[1][0].id;
          await page.locator(`.market-panel [data-act="card"][data-id="${first}"]`).click();await clickAction(page, 'reserve');
          assert.equal((await readState(page)).turn, 1);
          assert.equal((await readState(page)).players[0].reserved[0].id, first);
          await page.locator('[data-act="blind"][data-tier="2"]').click();
          const state = await readState(page);assert.equal(state.turn, 0);
          assert.equal(state.players[1].reserved[0].blindReserved, true);
          assert.equal(state.players[0].tokens.y, 1);assert.equal(state.players[1].tokens.y, 1);
          assert.equal(await page.locator('.reserve-pvp .reserve-player').count(), 2);
          assert.equal(await page.locator('.reserve-card-back').count(), 1);
          await page.locator('[data-act="history"]').click();
          assert.match(await page.locator('#logEntries').innerText(), /盲抽预留/);
          assert.match(await page.locator('#logEntries').innerText(), /预留了/);
          assert.match(await page.locator('#logEntries').innerText(), /翻牌/);
          const downloads = page.waitForEvent('download');await page.locator('[data-act="export"]').first().click();
          const download = await downloads, target = path.join(reportDir, `${engine}-review.json`);await download.saveAs(target);
          const review = JSON.parse(fs.readFileSync(target));
          assert.equal(review.format, 'splendor-coach-review-v2');assert.equal(review.moves.length, state.replay.length);
          assert.equal('deck' in review, false);assert.equal('setup' in review, false);
        });

        const purchase = goldPurchaseSave();
        await run('buy reserved card with normal gold payment', { saved: purchase.saved }, async page => {
          const before = await readState(page);
          await page.locator(`.reserve-pvp [data-act="card"][data-id="${purchase.id}"]`).click();await clickAction(page, 'buy');
          const state = await readState(page), buy = state.replay.at(-1).action;
          assert.equal(state.players[0].reserved.length, 0);assert.equal(state.players[0].tokens.y, 0);
          assert.equal(state.bank.y, before.bank.y + 1);assert.equal(buy.type, 'buy');assert.equal(buy.spent.y, 1);
          assert.deepEqual(state.market, before.market);assert.deepEqual(state.deck, before.deck);
        });

        await run('old save restores and reload preserves gameplay', { saved: fixture('save-pvp-midgame.json') }, async page => {
          const original = fixture('save-pvp-midgame.json');assertGameplay(await readState(page), original);
          assert.equal((await readState(page)).aiDifficulty, 'easy');await page.reload();
          assertGameplay(await readState(page), original);
          assert.equal(await page.locator('.reserve-pvp .reserve-player').count(), 2);
        });

        await run('old discard dialog manual returns', { saved: fixture('save-pvp-discard.json') }, async page => {
          const initial = await readState(page), need = initial.modal.need;
          for (let i = 0; i < need; i++) await page.locator('.modalbg [data-act="discard"]').first().click();
          const state = await readState(page);assert.equal(state.turn, 1);assert.equal(state.modal, null);
          assert.equal(Object.values(state.players[0].tokens).reduce((a, b) => a + b, 0), 10);
          assert.equal(state.replay.slice(initial.replay.length).filter(event => event.action.type === 'discard').length, need);
        });

        await run('old multi-noble dialog manual choice', { saved: fixture('save-pvp-noble.json') }, async page => {
          await page.locator('.modalbg [data-act="noble"][data-id="10"]').click();
          const state = await readState(page);assert.equal(state.turn, 1);assert.equal(state.players[0].score, 3);
          assert.deepEqual(state.players[0].nobles.map(noble => noble.id), [10]);
          assert.ok(state.nobles.some(noble => noble.id === 6));
        });

        await run('final responder completes classic end', { saved: fixture('save-pvp-final-response.json') }, async page => {
          await takeThree(page, false, ['r', 'k', 'u']);
          const state = await readState(page);assert.equal(state.over, true);assert.equal(state.modal.winnerSide, 0);
          assert.equal(state.round, 2);assert.match(await page.locator('.end-head').innerText(), /获胜/);
        });

        await run('board import export and malformed import rejection', {}, async (page, { dialogs }) => {
          await page.locator('input[name="matchMode"][value="pvp"]').check();await page.locator('[data-act="match-start"]').click();
          await page.locator('[data-act="seed"]').click();
          await page.locator('#seedFile').setInputFiles(path.join(ROOT, 'tests/fixtures/board-seed-v1.json'));
          await waitState(page, () => JSON.parse(localStorage.getItem('splendor_classic_v4')).setup.boardId === '1C327E6D');
          const restored = await readState(page);assert.deepEqual(restored.setup, fixture('board-seed-v1.json').setup);
          assert.deepEqual(restored.market, fixture('save-ai-initial.json').market);assert.equal(restored.matchMode, 'pvp');
          await page.locator('[data-act="seed"]').click();
          const downloadEvent = page.waitForEvent('download');await page.locator('[data-act="seed-export"]').click();
          const download = await downloadEvent, target = path.join(reportDir, `${engine}-board.json`);await download.saveAs(target);
          const exported = JSON.parse(fs.readFileSync(target));assert.equal(exported.format, 'splendor-board-seed-v1');
          assert.deepEqual(exported.setup, fixture('board-seed-v1.json').setup);
          const before = await readState(page), broken = fixture('board-seed-v1.json');broken.setup.boardId = '00000000';
          const dialogCount = dialogs.length;
          await page.locator('#seedFile').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(broken)) });
          await page.waitForFunction(() => !!document.querySelector('#seedFile') && document.querySelector('#seedFile').value === '');
          // File.text() resolves asynchronously; the dialog event is the rejection signal.
          for (let i = 0; dialogs.length === dialogCount && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
          assert.ok(dialogs.slice(dialogCount).some(text => text.includes('导入失败')));
          assertGameplay(await readState(page), before);
        });

        await run('embedded core rejects all normal gold takes atomically', { saved: fixture('save-ai-initial.json') }, async page => {
          const results = await page.evaluate(({ cards, saved }) => {
            const core = SplendorRules.create(cards), results = [];
            saved.turn = 1;
            for (const colors of [['y', 'y'], ['w', 'u', 'y'], ['y'], ['y', 'y', 'y']]) {
              const before = JSON.stringify(saved), applied = core.executeAction(saved, { type: 'take', colors }, 1);
              results.push({ accepted: applied.ok, unchanged: before === JSON.stringify(saved), eventCount: applied.events.length });
            }
            return results;
          }, { cards: fixture('classic-data-v1.json').cards, saved: fixture('save-ai-initial.json') });
          assert.ok(results.every(result => !result.accepted && result.unchanged && result.eventCount === 0));
        });

        await run('slow animation is visual only and clears normally', { animation: 'on', saved: { ...fixture('save-ai-initial.json'), matchMode: 'pvp' } }, async page => {
          await takeThree(page);
          assert.equal((await readState(page)).turn, 1);
          assert.equal(await page.locator('body').evaluate(body => body.classList.contains('fx-busy')), true);
          assert.ok(await page.locator('.fx-flight').count() > 0);
          await page.waitForFunction(() => !document.body.classList.contains('fx-busy'), undefined, { timeout: 5000 });
          assert.equal(await page.locator('.fx-flight').count(), 0);
          assert.equal((await readState(page)).replay.filter(event => event.action.type === 'take').length, 1);
        });

        for (const profile of ['desktop', 'portrait', 'landscape', 'smallPortrait']) {
          await run(`one-screen layout ${profile}`, { profile, saved: { ...fixture('save-pvp-midgame.json'), turn: 1 } }, async page => {
            const geometry = await page.evaluate(() => {
              const rect = element => { const r = element.getBoundingClientRect();return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
              return { width: innerWidth, height: innerHeight, coarse: matchMedia('(pointer:coarse)').matches,
                scrollWidth: document.documentElement.scrollWidth, dock: rect(document.querySelector('.mobile-action-dock')),
                cards: [...document.querySelectorAll('.market-panel .card,.reserve-pvp .card')].map(rect),
                tierCount: document.querySelectorAll('.market-panel .tier').length,
                reserves: document.querySelectorAll('.reserve-pvp .reserve-player').length };
            });
            assert.equal(geometry.tierCount, 3);assert.equal(geometry.reserves, 2);assert.equal(geometry.cards.length, 14);
            assert.ok(geometry.scrollWidth <= geometry.width + 1, 'No horizontal overflow');
            for (const card of geometry.cards) {
              assert.ok(card.width > 0 && card.height > 0, 'Every card is displayed');
              assert.ok(card.left >= -1 && card.right <= geometry.width + 1, 'Cards stay inside viewport');
              if (profile !== 'desktop') assert.ok(card.bottom <= geometry.dock.top + 1, 'Action dock does not cover reserve or market');
            }
            if (profile !== 'desktop') assert.equal(geometry.coarse, true);
            await page.screenshot({ path: path.join(reportDir, `${engine}-${profile}.png`), fullPage: true });
          });
        }

        await run('mobile rotation and actual dock actions', { profile: 'portrait', saved: { ...fixture('save-ai-initial.json'), matchMode: 'pvp' } }, async page => {
          await takeThree(page, true);const before = await readState(page);
          await page.setViewportSize(profiles.landscape.viewport);
          assertGameplay(await readState(page), before);
          const second = before.market[1][0].id;
          await page.locator(`.market-panel [data-act="card"][data-id="${second}"]`).click();await clickAction(page, 'reserve', true);
          const after = await readState(page);assert.equal(after.turn, 0);assert.equal(after.players[1].reserved[0].id, second);
          await page.setViewportSize(profiles.portrait.viewport);assertGameplay(await readState(page), after);
        });

        await run('local standalone HTML requires no external scripts', { file: true }, async (page, { requests }) => {
          await page.locator('#matchDifficulty').selectOption('normal');
          await page.locator('[data-act="match-start"]').click();
          const initial = await readState(page);
          assert.equal(initial.aiDifficulty, 'normal');assert.equal(initial.aiVersion, 'hybrid-v1');assert.equal(initial.aiConfigId, HybridCConfigId);
          await takeThree(page);
          await waitState(page, () => { const s = JSON.parse(localStorage.getItem('splendor_classic_v4'));return s.turn === 0 && s.round === 2; });
          assert.equal((await readState(page)).aiVersion, 'hybrid-v1');
          assert.equal(await page.locator('script[src]').count(), 0);
          assert.ok(requests.every(request => request.startsWith('file:')), 'No network dependency');
        });

        await run('hard V2 C runs from standalone HTML and survives save restore', { file: true }, async (page, { requests }) => {
          assert.equal(await page.evaluate(() => typeof SplendorV2Search?.create === 'function'), true,
            'The synced standalone page loads the embedded V2 module');
          await page.locator('#matchDifficulty').selectOption('hard');
          await page.locator('[data-act="match-start"]').click();
          let state = await readState(page);
          assert.equal(state.aiDifficulty, 'hard');assert.equal(state.aiVersion, 'v2-search');assert.equal(state.aiConfigId, V2CConfigId);
          assert.equal(await page.locator('script[src]').count(), 0);
          await takeThree(page);
          const pending = await readState(page), cards = fixture('classic-data-v1.json').cards;
          const core = require('../js/rules.js').create(cards);
          await waitState(page, () => { const s = JSON.parse(localStorage.getItem('splendor_classic_v4'));return s.turn === 0 && s.round === 2; });
          state = await readState(page);
          assert.equal(state.aiVersion, 'v2-search');assert.equal(state.aiConfigId, V2CConfigId);
          const actual = state.replay.findLast(event => event.actor === 'bot' && ['take', 'buy', 'reserve', 'blind_reserve'].includes(event.action.type));
          assert.ok(actual, 'The live game records a hard AI turn');
          assert.equal(core.validateAction(pending, actionFromReplay(actual), 1).ok, true, 'The hard action passes core legality checks');
          await page.reload();state = await readState(page);
          assert.equal(state.aiDifficulty, 'hard');assert.equal(state.aiVersion, 'v2-search');assert.equal(state.aiConfigId, V2CConfigId);
          assert.ok(requests.every(request => request.startsWith('file:')), 'The V2 hard game has no network dependency');
        });

        await run('policy and complete action-handler performance', { saved: { ...fixture('save-ai-initial.json'), matchMode: 'pvp' } }, async page => {
          const inputs = fixture('legacy-decisions-v1.json').cases.map(sample => expandDecisionInput(sample.input));
          const timings = await page.evaluate(({ cards, inputs }) => {
            const core = SplendorRules.create(cards), samples = [], decision = state => SplendorLegacyAI.decide(core.observe(state, 1), state.botRng);
            inputs.forEach(decision);
            for (let repeat = 0; repeat < 10; repeat++) for (const state of inputs) { const start = performance.now();decision(state);samples.push(performance.now() - start); }
            samples.sort((a, b) => a - b);
            return { samples: samples.length, p50Ms: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.floor(samples.length * .95)], p99Ms: samples[Math.floor(samples.length * .99)], maxMs: samples.at(-1) };
          }, { cards: fixture('classic-data-v1.json').cards, inputs });
          assert.ok(timings.p95Ms < 20, 'Legacy policy+observation P95 stays below 20ms on this host');
          const hybridTimings = await page.evaluate(({ cards, inputs, config }) => {
            const core = SplendorRules.create(cards), policy = SplendorHybridAI.create(config), samples = [];
            for (const [index, state] of inputs.entries()) {
              const start = performance.now(), observation = core.observe(state, 1);
              const result = policy.decide(observation, core, state.botRng || 1);
              samples.push({ index, round: state.round, score: state.players[1].score, opponentScore: state.players[0].score,
                cards: state.players[1].cards.length, elapsed: performance.now() - start,
                legal: !!result.action && core.validateAction(state, result.action, 1).ok });
            }
            const values = samples.map(sample => sample.elapsed).sort((a, b) => a - b), percentile = p => values[Math.min(values.length - 1, Math.floor(values.length * p))];
            const slowest = samples.reduce((best, sample) => sample.elapsed > best.elapsed ? sample : best);
            return { samples: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: values.at(-1),
              slowest: { index: slowest.index, round: slowest.round, score: slowest.score, opponentScore: slowest.opponentScore, cards: slowest.cards },
              allLegal: samples.every(sample => sample.legal) };
          }, { cards: fixture('classic-data-v1.json').cards, inputs, config: HybridCConfig });
          assert.ok(hybridTimings.allLegal, 'Hybrid C returns a legal action for each live test state');
          const handlerSamples = [];
          for (let repeat = 0; repeat < 12; repeat++) {
            if (repeat) { await page.evaluate(saved => localStorage.setItem('splendor_classic_v4', JSON.stringify(saved)), { ...fixture('save-ai-initial.json'), matchMode: 'pvp' });await page.reload(); }
            const elapsed = await page.evaluate(() => {
              for (const color of ['w', 'u', 'g']) document.querySelector(`[data-act="gem"][data-color="${color}"]`).click();
              const start = performance.now();document.querySelector('.side [data-act="take"]').click();return performance.now() - start;
            });
            assert.equal((await readState(page)).turn, 1);handlerSamples.push(elapsed);
          }
          handlerSamples.sort((a, b) => a - b);
          const baselineHandlerSamples = [];
          for (let repeat = 0; repeat < 12; repeat++) {
            await page.evaluate(saved => localStorage.setItem('splendor_classic_v4', JSON.stringify(saved)), { ...fixture('save-ai-initial.json'), matchMode: 'pvp' });
            await page.goto(url.replace('/splendor-mobile/index.html', '/baseline.html'));
            const elapsed = await page.evaluate(() => {
              for (const color of ['w', 'u', 'g']) document.querySelector(`[data-act="gem"][data-color="${color}"]`).click();
              const start = performance.now();document.querySelector('.side [data-act="take"]').click();return performance.now() - start;
            });
            assert.equal((await readState(page)).turn, 1);baselineHandlerSamples.push(elapsed);
          }
          baselineHandlerSamples.sort((a, b) => a - b);
          report.performance.push({ engine, profile: 'desktop-host', legacyPolicy: timings, hybridCPolicy: hybridTimings,
            actionHandler: { samples: handlerSamples.length, p50Ms: handlerSamples[6], p95Ms: handlerSamples[11], maxMs: handlerSamples.at(-1) },
            baselineActionHandler: { samples: baselineHandlerSamples.length, p50Ms: baselineHandlerSamples[6], p95Ms: baselineHandlerSamples[11], maxMs: baselineHandlerSamples.at(-1) } });
        });

        await run('Hybrid C mobile viewport decision performance', { profile: 'portrait', saved: { ...fixture('save-ai-initial.json'), matchMode: 'pvp' } }, async page => {
          const inputs = fixture('legacy-decisions-v1.json').cases.map(sample => expandDecisionInput(sample.input));
          const timings = await page.evaluate(({ cards, inputs, config }) => {
            const core = SplendorRules.create(cards), policy = SplendorHybridAI.create(config), values = [];
            for (const [index, state] of inputs.entries()) {
              const start = performance.now(), observation = core.observe(state, 1);
              const result = policy.decide(observation, core, state.botRng || 1);
              values.push({ index, round: state.round, score: state.players[1].score, opponentScore: state.players[0].score,
                cards: state.players[1].cards.length, elapsed: performance.now() - start,
                legal: !!result.action && core.validateAction(state, result.action, 1).ok });
            }
            values.sort((a, b) => a.elapsed - b.elapsed);
            const percentile = p => values[Math.min(values.length - 1, Math.floor(values.length * p))].elapsed;
            return { samples: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
              maxMs: values.at(-1).elapsed, slowest: { index: values.at(-1).index, round: values.at(-1).round,
                score: values.at(-1).score, opponentScore: values.at(-1).opponentScore, cards: values.at(-1).cards },
              allLegal: values.every(value => value.legal) };
          }, { cards: fixture('classic-data-v1.json').cards, inputs, config: HybridCConfig });
          assert.ok(timings.allLegal, 'Hybrid C returns legal moves in a mobile viewport');
          report.performance.push({ engine, profile: 'mobile-portrait-emulation', hybridCPolicy: timings });
        });
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}

main().catch(error => { report.fatal = error.stack;console.error(error);process.exitCode = 1; }).finally(() => {
  report.passed = report.tests.filter(test => test.passed).length;
  report.failed = report.tests.filter(test => !test.passed).length;
  if (report.failed || report.fatal) process.exitCode = 1;
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, fatal: !!report.fatal, performance: report.performance, reportDir }, null, 2));
});
