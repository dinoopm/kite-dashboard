'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregatePortfolio,
  createPortfolioRiskService,
  normalizeAndGroupHoldings,
} = require('./portfolioRisk');

test('normalizes numeric input, includes T1, and groups duplicate ISIN holdings', () => {
  const grouped = normalizeAndGroupHoldings([
    { tradingsymbol: 'AAA', exchange: 'NSE', isin: 'INE001', quantity: '2', t1_quantity: '3', last_price: '100', instrument_token: 11 },
    { tradingsymbol: 'AAA-BE', exchange: 'NSE', isin: 'INE001', quantity: 1, t1_quantity: 0, last_price: 100, instrument_token: 12 },
    { tradingsymbol: 'ZERO', quantity: 0, t1_quantity: 0, last_price: 50 },
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].quantity, 6);
  assert.equal(grouped[0].currentValue, 600);
  assert.equal(grouped[0].instrumentToken, '11');
});

test('reports invalid prices separately and keeps Unknown in the valued denominator', () => {
  const grouped = normalizeAndGroupHoldings([
    { tradingsymbol: 'KNOWN', quantity: 1, last_price: 75 },
    { tradingsymbol: 'MYSTERY', quantity: 1, last_price: 25 },
    { tradingsymbol: 'NOPRICE', quantity: 2, last_price: null },
  ]).map(item => ({
    ...item,
    sector: item.symbol === 'KNOWN' ? 'Energy' : 'Unknown',
  }));
  const result = aggregatePortfolio(grouped);

  assert.equal(result.summary.coveredValue, 100);
  assert.equal(result.coverage.unpricedHoldingCount, 1);
  assert.equal(result.coverage.classificationCoveragePct, 75);
  assert.equal(result.sectors.reduce((sum, item) => sum + item.weightPct, 0), 100);
});

test('top-five allocation works for portfolios with fewer than five positions', () => {
  const result = aggregatePortfolio([
    { symbol: 'A', key: 'A', exchange: 'NSE', quantity: 1, currentValue: 60, priced: true, sector: 'Energy' },
    { symbol: 'B', key: 'B', exchange: 'NSE', quantity: 1, currentValue: 40, priced: true, sector: 'Finance' },
  ]);
  assert.equal(result.summary.topFiveWeightPct, 100);
  assert.equal(result.summary.largestPosition.symbol, 'A');
});

test('service handles zero holdings and returns an ISO retrieval timestamp', async () => {
  const service = createPortfolioRiskService({
    fetchHoldings: async () => ({ rows: [], fetchedAt: 0 }),
    resolveSector: async () => 'Energy',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  const result = await service();
  assert.deepEqual(result.positions, []);
  assert.equal(result.summary.coveredValue, 0);
  assert.equal(result.holdingsFetchedAt, '1970-01-01T00:00:00.000Z');
});

test('service preserves upstream failures and rate-limit metadata', async () => {
  const upstream = new Error('rate_limited');
  upstream.statusCode = 429;
  upstream.retryAfter = 7;
  const service = createPortfolioRiskService({
    fetchHoldings: async () => { throw upstream; },
    resolveSector: async () => 'Energy',
  });
  await assert.rejects(service(), error => error === upstream && error.retryAfter === 7);
});

test('service does not turn a generic upstream failure into an empty portfolio', async () => {
  const upstream = new Error('broker unavailable');
  upstream.statusCode = 502;
  const service = createPortfolioRiskService({
    fetchHoldings: async () => { throw upstream; },
    resolveSector: async () => 'Energy',
  });
  await assert.rejects(service(), error => error === upstream && error.statusCode === 502);
});

test('service rejects malformed holdings responses', async () => {
  const service = createPortfolioRiskService({
    fetchHoldings: async () => ({ rows: { bad: true } }),
    resolveSector: async () => 'Energy',
  });
  await assert.rejects(service(), error => error.statusCode === 502);
});

test('sector timeouts degrade to Unknown without failing the response', async () => {
  const service = createPortfolioRiskService({
    fetchHoldings: async () => [{ tradingsymbol: 'SLOW', quantity: 1, last_price: 100 }],
    resolveSector: async () => new Promise(() => {}),
    timeoutMs: 10,
    concurrency: 3,
  });
  const result = await service();
  assert.equal(result.positions[0].sector, 'Unknown');
  assert.equal(result.coverage.classificationCoveragePct, 0);
});
