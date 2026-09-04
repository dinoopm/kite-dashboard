// backend/usPicks/engine.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildUniverseFrom, rankUniverse, percentileRanks, DEFAULT_WEIGHTS, BACKTEST_WEIGHTS } = require('./engine');

const day = (i) => { const d = new Date(Date.UTC(2024, 0, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const bars = (n, from, step, vol = 1e6) => Array.from({ length: n }, (_, i) => {
  const c = from + i * step;
  return { date: day(i), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: vol };
});
const inputs = (over = {}) => ({
  members: [{ symbol: 'UP', name: 'Up Co', sector: 'Tech' }, { symbol: 'DOWN', name: 'Down Co', sector: 'Energy' }, { symbol: 'THIN', name: 'Thin Co', sector: 'Tech' }],
  barsBySymbol: { UP: bars(300, 100, 0.5), DOWN: bars(300, 200, -0.3), THIN: bars(300, 1, 0.001, 100) },
  spyBars: bars(300, 400, 0.1),
  earningsBySymbol: new Map(),
  revisionsBySymbol: new Map([['UP', 0.8]]),
  revisionsMissing: 2,
  macroLabel: 'neutral',
  ...over,
});

describe('percentileRanks', () => {
  test('nulls sit at exactly 50, others rank among themselves', () => {
    assert.deepEqual(percentileRanks([1, null, 3]), [25, 50, 75]);
  });
  test('ties share the middle of their block', () => {
    assert.deepEqual(percentileRanks([0, 0, 0, 5]), [37.5, 37.5, 37.5, 87.5]);
  });
});

describe('buildUniverseFrom', () => {
  test('ranks the trend leader above the laggard and drops the illiquid name', () => {
    const u = buildUniverseFrom(inputs());
    const syms = u.stocks.map(s => s.symbol);
    assert.ok(syms.includes('UP') && syms.includes('DOWN'));
    assert.ok(!syms.includes('THIN'), 'below the $10M floor');
    assert.equal(u.excludedCount, 1);
    assert.match(u.excludedSample[0], /THIN/);
    const up = u.stocks.find(s => s.symbol === 'UP');
    assert.ok(up.factors.momentumRaw > 0);
    assert.ok(up.factors.relStrengthRaw > 0);
    assert.equal(up.factors.revisionsRaw, 0.8);
    assert.equal(u.stocks.find(s => s.symbol === 'DOWN').factors.revisionsRaw, null);
  });

  test('excludes a name reporting within 5 sessions', () => {
    const u = buildUniverseFrom(inputs({ earningsBySymbol: new Map([['UP', day(301)]]) }));
    assert.ok(!u.stocks.some(s => s.symbol === 'UP'));
    assert.ok(u.excludedSample.some(x => /earnings/.test(x)));
  });

  test('keeps a name reporting 10 sessions out, with the date attached', () => {
    const u = buildUniverseFrom(inputs({ earningsBySymbol: new Map([['UP', day(315)]]) }));
    assert.equal(u.stocks.find(s => s.symbol === 'UP').earningsDate, day(315));
  });

  test('asOf evaluates at the last bar on or before that date, and only sees earlier bars', () => {
    const full = buildUniverseFrom(inputs(), { asOf: day(250) });
    assert.equal(full.period.snapshotDate, day(250));
    const trimmed = buildUniverseFrom(inputs({ barsBySymbol: { UP: bars(251, 100, 0.5), DOWN: bars(251, 200, -0.3), THIN: bars(251, 1, 0.001, 100) }, spyBars: bars(251, 400, 0.1) }));
    assert.equal(full.stocks.find(s => s.symbol === 'UP').factors.momentumRaw, trimmed.stocks.find(s => s.symbol === 'UP').factors.momentumRaw);
  });

  test('regime carries breadth and the macro label', () => {
    const u = buildUniverseFrom(inputs());
    assert.equal(u.regime.macro, 'neutral');
    assert.ok(['risk-on', 'risk-off', 'mixed'].includes(u.regime.breadth.label));
    assert.match(u.regime.label, /Breadth/);
  });
});

describe('rankUniverse', () => {
  test('weights sum to 100 and the backtest zeroes revisions', () => {
    assert.equal(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0), 100);
    assert.equal(BACKTEST_WEIGHTS.revisions, 0);
  });
  test('excludes traps by default and ranks 1..n', () => {
    const stocks = [
      { symbol: 'A', factors: { momentumRaw: 0.2, volumeRaw: 1, fiftyTwoRaw: 1, relStrengthRaw: 5, revisionsRaw: 0.5, trapRisk: false } },
      { symbol: 'B', factors: { momentumRaw: 0.1, volumeRaw: 0, fiftyTwoRaw: 0, relStrengthRaw: 0, revisionsRaw: null, trapRisk: false } },
      { symbol: 'T', factors: { momentumRaw: 0.9, volumeRaw: 9, fiftyTwoRaw: 1, relStrengthRaw: 9, revisionsRaw: 1, trapRisk: true } },
    ];
    const r = rankUniverse(stocks);
    assert.deepEqual(r.map(x => x.symbol), ['A', 'B']);
    assert.deepEqual(r.map(x => x.rank), [1, 2]);
    assert.equal(rankUniverse(stocks, DEFAULT_WEIGHTS, { excludeTraps: false })[0].symbol, 'T');
  });
});
