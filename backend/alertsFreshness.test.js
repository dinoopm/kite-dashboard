'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAlertsFreshness } = require('./alertsFreshness');

test('reports the oldest covered candle instead of the HTTP response time', () => {
  const freshness = buildAlertsFreshness({
    holdings: [{}, {}],
    checkedAt: '2026-10-03T10:00:00.000Z',
    refreshResults: [
      { symbol: 'A', status: 'success', attempted: true, candleAsOf: '2026-10-02T00:00:00+05:30', lastSuccessAt: '2026-10-03T09:59:00.000Z' },
      { symbol: 'B', status: 'cooldown', attempted: false, candleAsOf: '2026-10-02T00:00:00+05:30', lastSuccessAt: '2026-10-03T09:58:00.000Z' },
    ],
  });
  assert.equal(freshness.checkedAt, '2026-10-03T10:00:00.000Z');
  assert.equal(freshness.candleAsOf, '2026-10-02');
  assert.equal(freshness.status, 'complete');
  assert.equal(freshness.failedRefreshCount, 0);
});

test('keeps cached candle coverage visible when refresh fails', () => {
  const freshness = buildAlertsFreshness({
    holdings: [{}, {}],
    refreshResults: [
      { symbol: 'A', status: 'failed', attempted: true, candleAsOf: '2026-10-01', lastSuccessAt: '2026-10-01T12:00:00.000Z' },
      { symbol: 'B', status: 'success', attempted: true, candleAsOf: '2026-10-02', lastSuccessAt: '2026-10-03T09:59:00.000Z' },
    ],
  });
  assert.equal(freshness.coveragePct, 100);
  assert.equal(freshness.failedRefreshCount, 1);
  assert.equal(freshness.candleAsOf, '2026-10-01');
  assert.equal(freshness.status, 'partial');
  assert.deepEqual(freshness.issues, [
    { symbol: 'A', candleAsOf: '2026-10-01', reason: 'failed' },
  ]);
});

test('reports missing cached candles as incomplete coverage', () => {
  const freshness = buildAlertsFreshness({
    holdings: [{}, {}, {}],
    refreshResults: [
      { symbol: 'A', status: 'success', attempted: true, candleAsOf: '2026-10-02' },
      { symbol: 'B', status: 'no-cache', attempted: true, candleAsOf: null },
      { symbol: 'C', status: 'cooldown', attempted: false, candleAsOf: '2026-10-02' },
    ],
  });
  assert.equal(freshness.coveredHoldings, 2);
  assert.ok(Math.abs(freshness.coveragePct - (200 / 3)) < 1e-9);
  assert.equal(freshness.status, 'partial');
  assert.equal(freshness.issues[0].symbol, 'B');
});
