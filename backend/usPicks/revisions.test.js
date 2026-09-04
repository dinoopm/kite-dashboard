// backend/usPicks/revisions.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { revisionsRawFrom, fetchRevisions, _resetCache } = require('./revisions');

const et = (o) => ({ trend: [{ period: '0y', epsRevisions: { upLast30days: o.up, downLast30days: o.down }, epsTrend: { current: o.now, '30daysAgo': o.ago } }] });

describe('revisionsRawFrom', () => {
  test('all upgrades and a rising estimate is +1', () => {
    assert.ok(Math.abs(revisionsRawFrom(et({ up: 5, down: 0, now: 1.2, ago: 1.0 })) - 1) < 1e-9);
  });
  test('all downgrades and a falling estimate is −1', () => {
    assert.ok(Math.abs(revisionsRawFrom(et({ up: 0, down: 4, now: 0.8, ago: 1.0 })) - (-1)) < 1e-9);
  });
  test('the trend change is clamped at ±20%', () => {
    const a = revisionsRawFrom(et({ up: 0, down: 0, now: 3, ago: 1 }));
    const b = revisionsRawFrom(et({ up: 0, down: 0, now: 1.2, ago: 1 }));
    assert.ok(Math.abs(a - b) < 1e-9, 'a 200% jump scores the same as 20%');
  });
  test('no revisions but a trend uses the trend alone', () => {
    assert.ok(Math.abs(revisionsRawFrom(et({ up: 0, down: 0, now: 1.1, ago: 1.0 })) - 0.5) < 1e-9);
  });
  test('nothing usable is null, not zero', () => {
    assert.equal(revisionsRawFrom(null), null);
    assert.equal(revisionsRawFrom({ trend: [] }), null);
    assert.equal(revisionsRawFrom(et({ up: 0, down: 0, now: null, ago: null })), null);
  });
});

describe('fetchRevisions', () => {
  test('caches per symbol and counts misses', async () => {
    _resetCache();
    let calls = 0;
    const fetchOne = async (sym) => { calls++; return sym === 'BAD' ? null : et({ up: 1, down: 0, now: 1, ago: 1 }); };
    const r1 = await fetchRevisions(['AAA', 'BAD'], { fetchOne, gapMs: 0 });
    assert.equal(r1.bySymbol.get('AAA'), 0.5);
    assert.equal(r1.bySymbol.get('BAD'), null);
    assert.equal(r1.missing, 1);
    await fetchRevisions(['AAA', 'BAD'], { fetchOne, gapMs: 0 });
    assert.equal(calls, 2, 'second call served from cache');
  });
});
