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

  test('a thrown fetch is not cached, but a genuinely empty one is', async () => {
    _resetCache();
    const calls = { GOOD: 0, ERR: 0, EMPTY: 0 };
    const failingFetchOne = async (sym) => {
      calls[sym] = (calls[sym] || 0) + 1;
      if (sym === 'ERR') throw new Error('rate limited');
      if (sym === 'EMPTY') return null;
      return et({ up: 1, down: 0, now: 1, ago: 1 });
    };
    const r1 = await fetchRevisions(['GOOD', 'ERR', 'EMPTY'], { fetchOne: failingFetchOne, gapMs: 0 });
    assert.equal(r1.bySymbol.get('ERR'), null, 'a thrown fetch still reports null so callers rank it neutral');
    assert.equal(r1.bySymbol.get('EMPTY'), null);
    assert.equal(r1.bySymbol.get('GOOD'), 0.5);
    assert.equal(r1.failed, 1);
    assert.equal(r1.missing, 1, 'EMPTY is a genuine absence; ERR is a failure and must not double-count as one');

    // ERR now works. GOOD and EMPTY should be served from the 24h cache
    // (fetchOne not called again for them); ERR must be refetched because a
    // thrown fetch is never written to the cache.
    const recoveredFetchOne = async (sym) => {
      calls[sym] = (calls[sym] || 0) + 1;
      if (sym === 'ERR') return et({ up: 0, down: 3, now: 0.9, ago: 1 });
      if (sym === 'EMPTY') return null;
      return et({ up: 1, down: 0, now: 1, ago: 1 });
    };
    const r2 = await fetchRevisions(['GOOD', 'ERR', 'EMPTY'], { fetchOne: recoveredFetchOne, gapMs: 0 });
    assert.equal(calls.ERR, 2, 'the thrown fetch was not cached, so it is retried');
    assert.equal(calls.GOOD, 1, 'the successful fetch was cached');
    assert.equal(calls.EMPTY, 1, 'the empty-but-successful fetch was cached too — real information');
    assert.ok(r2.bySymbol.get('ERR') < 0, 'ERR now resolves to a real (downgraded) score');
    assert.equal(r2.bySymbol.get('GOOD'), 0.5);
    assert.equal(r2.failed, 0);
  });
});
