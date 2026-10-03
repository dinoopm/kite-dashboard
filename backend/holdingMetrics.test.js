'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { holdingMetrics, buildHoldingSummary } = require('./holdingMetrics');

test('T1-only and mixed holdings use total quantity for value, P&L and daily impact', () => {
  for (const [quantity, t1_quantity] of [[0, 5], [3, 2], ['3', '2']]) {
    const result = holdingMetrics({ quantity, t1_quantity, last_price: '110', average_price: '100', day_change: '2', pnl: 30 });
    assert.equal(result.quantity, 5);
    assert.equal(result.currentValue, 550);
    assert.equal(result.invested, 500);
    // Broker P&L may reflect only settled shares; derive it using total shares.
    assert.equal(result.pnl, 50);
    assert.equal(result.pnlPct, 10);
    assert.equal(result.dayChangeRupee, 10);
  }
});

test('summary covers holdings with short, absent or sufficient history and no signals', () => {
  const holdings = [
    { quantity: 2, t1_quantity: 3, average_price: 100, last_price: 110, day_change: 2, candles: Array(200).fill({}) },
    { quantity: 0, t1_quantity: 4, average_price: 50, last_price: 45, day_change: -1, candles: [{}] },
    { quantity: 2, average_price: 200, last_price: 220, day_change: 3 },
  ];
  const result = buildHoldingSummary(holdings);
  assert.equal(result.totalHoldings, 3);
  assert.equal(result.totalInvested, 1100);
  assert.equal(result.totalCurrentValue, 1170);
  assert.equal(result.totalPnlRupee, 70);
  assert.equal(result.totalPnlPct, 6.36);
  assert.equal(result.todayPnlRupee, 12);
  assert.deepEqual(result.financialCoverage, {
    totalPositions: 3, investedPositions: 3, valuedPositions: 3, pnlPositions: 3, dailyPnlPositions: 3,
  });
  const withoutHistory = holdings.map(({ candles, ...holding }) => holding);
  assert.deepEqual(buildHoldingSummary(withoutHistory), result);
});

test('daily change falls back to broker previous close and preserves explicit zero', () => {
  const holding = { quantity: 3, t1_quantity: 2, last_price: 110, close_price: 108 };
  assert.equal(holdingMetrics(holding).dayChangeRupee, 10);
  assert.equal(holdingMetrics({ ...holding, day_change: 0 }).dayChangeRupee, 0);
});

test('missing prices and costs report coverage without diluting the P&L percentage', () => {
  const result = buildHoldingSummary([
    { quantity: 2, average_price: 100, last_price: 110, day_change: 1 },
    { quantity: 3, average_price: 100, last_price: 'invalid' },
    { quantity: 4, average_price: null, last_price: 50, day_change: 2 },
  ]);
  assert.equal(result.totalInvested, 500);
  assert.equal(result.totalCurrentValue, 420);
  assert.equal(result.totalPnlRupee, 20);
  assert.equal(result.totalPnlPct, 10);
  assert.equal(result.todayPnlRupee, 10);
  assert.deepEqual(result.financialCoverage, {
    totalPositions: 3, investedPositions: 2, valuedPositions: 2, pnlPositions: 1, dailyPnlPositions: 2,
  });
});

test('empty and zero-quantity holdings yield zero totals and no percentage', () => {
  for (const holdings of [[], [{ quantity: 0, t1_quantity: 0, average_price: 100, last_price: 110, day_change: 2 }]]) {
    const result = buildHoldingSummary(holdings);
    assert.equal(result.totalHoldings, holdings.length);
    assert.equal(result.totalInvested, 0);
    assert.equal(result.totalCurrentValue, 0);
    assert.equal(result.totalPnlRupee, 0);
    assert.equal(result.todayPnlRupee, 0);
    assert.equal(result.totalPnlPct, null);
    assert.equal(result.financialCoverage.totalPositions, 0);
  }
});

test('aggregates unrounded row values before rounding totals', () => {
  const holdings = Array.from({ length: 3 }, () => ({ quantity: 1, average_price: 1, last_price: 1.004, day_change: 0.004 }));
  assert.equal(buildHoldingSummary(holdings).totalPnlRupee, 0.01);
  assert.equal(buildHoldingSummary(holdings).todayPnlRupee, 0.01);
});
