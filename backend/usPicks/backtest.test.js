// backend/usPicks/backtest.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAt, evalIndices } = require('./backtest');

const day = (i) => { const d = new Date(Date.UTC(2020, 0, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const bars = (n, from, step) => Array.from({ length: n }, (_, i) => { const c = from + i * step; return { date: day(i), open: c, high: c, low: c, close: c, volume: 1e6 }; });
const inputs = () => ({
  members: Array.from({ length: 60 }, (_, k) => ({ symbol: `S${k}`, name: `S${k}`, sector: null })),
  // S0 climbs fastest, S59 slowest — momentum should order them.
  barsBySymbol: Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`S${k}`, bars(400, 100, 0.5 - k * 0.005)])),
  spyBars: bars(400, 400, 0.1),
  earningsBySymbol: new Map(), revisionsBySymbol: new Map(), revisionsMissing: 0, macroLabel: null,
});

describe('evalIndices', () => {
  test('steps along the SPY calendar and leaves room for the horizon', () => {
    const idx = evalIndices(bars(30, 1, 1), { from: day(0), step: 5, minWarm: 10, maxHorizon: 5 });
    assert.deepEqual(idx, [10, 15, 20]);
  });
});

describe('evaluateAt', () => {
  test('scores the top picks against the universe median and SPY, causally', () => {
    const r = evaluateAt(inputs(), { asOf: day(300), horizons: [5, 10], topN: 10 });
    assert.equal(r.evalDate, day(300));
    assert.ok(r.horizons[10].scored >= 50);
    assert.ok(r.horizons[10].excessVsMedian > 0, 'fastest climbers rank first and beat the median');
    assert.equal(typeof r.horizons[10].excessVsSpy, 'number');
    assert.equal(r.horizons[10].quintiles.length, 5);
    assert.ok(r.icComposite > 0.9);
  });
  test('a later bar cannot change an earlier evaluation', () => {
    const a = evaluateAt(inputs(), { asOf: day(300), horizons: [5], topN: 10 });
    const inp = inputs();
    for (const k of Object.keys(inp.barsBySymbol)) inp.barsBySymbol[k] = inp.barsBySymbol[k].slice(0, 306);
    inp.spyBars = inp.spyBars.slice(0, 306);
    const b = evaluateAt(inp, { asOf: day(300), horizons: [5], topN: 10 });
    assert.deepEqual(a.top.map(t => t.symbol), b.top.map(t => t.symbol));
  });
});
