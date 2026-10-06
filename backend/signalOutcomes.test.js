'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { forwardOutcome, scoreSignal } = require('./signalScoring');

const costs = { version: 'test-v1', feeBpsPerSide: 10, slippageBpsPerSide: 5 };
const series = [
  { date: 'a', close: 100, low: 10 }, // This low happened before the observation.
  { date: 'b', close: 101, low: 95 },
  { date: 'c', close: 110, low: 90 },
];

test('measures forward return, adverse move and exact round-trip costs', () => {
  const result = forwardOutcome(series, 0, 2, { costModel: costs });
  assert.ok(Math.abs(result.grossReturnPct - 10) < 1e-10);
  assert.ok(Math.abs(result.maxAdversePct + 10) < 1e-10);
  assert.ok(Math.abs(result.netReturnPct - (110 * 0.9985 / (100 * 1.0015) - 1) * 100) < 1e-10);
  assert.equal(result.outcomeAfterCosts, 'gain');
});

test('a small gross gain becomes a loss after fees and slippage', () => {
  const result = forwardOutcome([{ close: 100 }, { close: 100.1, low: 100 }], 0, 1, { costModel: costs });
  assert.ok(result.grossReturnPct > 0);
  assert.ok(result.netReturnPct < 0);
  assert.equal(result.outcomeAfterCosts, 'loss');
});

test('zero-cost flat outcomes remain flat; adverse moves cannot be positive', () => {
  const result = forwardOutcome([{ close: 100 }, { close: 100, low: 101 }], 0, 1, { costModel: { feeBpsPerSide: 0, slippageBpsPerSide: 0 } });
  assert.equal(result.netReturnPct, 0);
  assert.equal(result.maxAdversePct, 0);
  assert.equal(result.outcomeAfterCosts, 'flat');
});

test('missing interior lows leave adverse moves unresolved without inventing a flat path', () => {
  const bars = [series[0], { date: 'b', close: null, low: null }, series[2]];
  const result = forwardOutcome(bars, 0, 2, { costModel: costs });
  assert.ok(result.grossReturnPct > 0);
  assert.equal(result.maxAdversePct, null);
  const stats = scoreSignal([{ symbol: 'A', date: 'a' }], { A: bars }, { horizons: [2], costModel: costs })['2d'];
  assert.equal(stats.nAdverse, 0);
  assert.equal(stats.adverseUnresolved, 1);
});

test('missing endpoints, insufficient horizon and invalid costs cannot resolve outcomes', () => {
  assert.equal(forwardOutcome(series, 0, 5), null);
  assert.equal(forwardOutcome(series, -1, 1), null);
  assert.equal(forwardOutcome([{ close: 100 }, { close: null }], 0, 1), null);
  assert.equal(forwardOutcome(series, 0, 1, { entryPrice: 0 }), null);
  assert.throws(() => forwardOutcome(series, 0, 1, { costModel: { feeBpsPerSide: -1, slippageBpsPerSide: 0 } }));
});

test('uses each frozen cost model and keeps recent outcomes pending', () => {
  const emissions = [
    { symbol: 'A', date: 'a', costModel: costs },
    { symbol: 'A', date: 'c', costModel: costs },
  ];
  const result = scoreSignal(emissions, { A: series }, { horizons: [2], costModel: { feeBpsPerSide: 0, slippageBpsPerSide: 0 } })['2d'];
  assert.equal(result.n, 1);
  assert.equal(result.unresolved, 1);
  assert.ok(result.medianNetPct < result.medianPct);
  assert.deepEqual(result.outcomesAfterCosts, { gains: 1, losses: 0, flat: 0 });
});
