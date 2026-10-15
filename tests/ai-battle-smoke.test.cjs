'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSmoke } = require('./helpers/ai-battles.cjs');

test('V1 vs frozen legacy smoke: 20 random boards, both seat orders, legal and conserved through game end',
  { timeout: 240_000 }, t => {
    const result = runSmoke({ boardCount: 20 });
    assert.equal(result.gameCount, 40);
    assert.equal(result.summary.v1.played, 40);assert.equal(result.summary.simple.played, 40);
    assert.equal(result.summary.v1.firstSeat, 20);assert.equal(result.summary.simple.firstSeat, 20);
    assert.ok(result.v1DecisionMs.samples > 0);
    t.diagnostic(JSON.stringify(result));
  });
