'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, BASELINE, loadGame, fixture, plain } = require('./helpers/game-harness.cjs');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/baseline/manifest.json'), 'utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

test('legacy-v1 archive is byte-for-byte frozen at its recorded SHA-256', () => {
  assert.equal(manifest.strategyId, 'legacy-v1');
  assert.equal(manifest.sourceCommit, '34468c5');
  assert.equal(sha256(fs.readFileSync(BASELINE)), manifest.sourceSha256);
});

for (const [name, digest] of Object.entries(manifest.fixtureHashes)) {
  test(`frozen fixture integrity: ${name}`, () => {
    assert.equal(sha256(fs.readFileSync(path.join(ROOT, 'tests/fixtures', name))), digest);
  });
}

test('production card and noble rows, generated IDs and costs match the frozen data', () => {
  const { api } = loadGame();
  const data = fixture('classic-data-v1.json');
  assert.deepEqual(plain(api.CARD_ROWS), data.cardRows);
  assert.deepEqual(plain(api.NOBLE_ROWS), data.nobleRows);
  assert.deepEqual(plain(api.CARD_POOL), data.cards);
  assert.deepEqual(plain(api.NOBLES), data.nobles);
  assert.deepEqual([1, 2, 3].map(tier => api.CARD_POOL.filter(card => card.tier === tier).length), [40, 30, 20]);
  assert.equal(new Set(api.CARD_POOL.map(card => card.id)).size, 90);
});

test('decision corpus count and named fallback cases are fixed', () => {
  const corpus = fixture('legacy-decisions-v1.json');
  assert.equal(corpus.strategyId, manifest.strategyId);
  assert.equal(corpus.cases.length, manifest.decisionCaseCount);
  assert.equal(new Set(corpus.cases.map(sample => sample.name)).size, corpus.cases.length);
  for (const name of ['opening-take', 'full-hand-purchase', 'developed-discounts', 'own-reserved-and-gold',
    'bank-empty-purchase', 'bank-empty-reserve-scoring-card', 'synthetic-bank-empty-purchase-no-gold',
    'synthetic-bank-empty-reserve-first-card', 'synthetic-bank-empty-reserve-no-gold',
    'synthetic-no-options', 'synthetic-buy-only']) {
    assert.ok(corpus.cases.some(sample => sample.name === name), name);
  }
});
