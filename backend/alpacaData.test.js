// backend/alpacaData.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fetchBarsMulti, sanitizeBar } = require('./alpacaData');

describe('fetchBarsMulti', () => {
  test('asks for at most 100 symbols per call and merges the pages', async () => {
    const calls = [];
    const get = async (path, params) => {
      calls.push(params.symbols.split(','));
      // second chunk paginates once
      if (params.symbols.startsWith('S100') && !params.page_token) {
        return { bars: { S100: [{ t: '2025-01-02T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: 'p2' };
      }
      const out = {};
      for (const s of params.symbols.split(',')) out[s] = [{ t: '2025-01-03T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.6, v: 11 }];
      return { bars: out, next_page_token: null };
    };
    const symbols = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const bars = await fetchBarsMulti(symbols, new Date('2025-01-01'), { get });
    assert.equal(calls[0].length, 100);
    assert.equal(calls[1].length, 50);
    assert.equal(Object.keys(bars).length, 150);
    assert.equal(bars.S100.length, 2, 'both pages of the paginated chunk are kept');
    assert.equal(bars.S0[0].close, 1.6);
  });
});

describe('sanitizeBar', () => {
  test('clamps an absurd wick to the body', () => {
    const b = sanitizeBar({ open: 10, high: 50, low: 9, close: 11, volume: 1 });
    assert.equal(b.high, 11);
    assert.equal(b.low, 9);
  });
});
