const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { headline, present, MIN_N } = require('./scorecard');

const rows = (over) => present({ '5d': { n: 0, unresolved: 0 }, '10d': { n: 0, unresolved: 0 }, ...over });

describe('present', () => {
  test('converts rates to percentages and rounds returns', () => {
    const [r] = present({ '10d': { n: 30, unresolved: 4, hitRate: 0.4567, medianPct: 1.23456, medianExcessPct: -0.98765, hitRateExcess: 0.4 } });
    assert.equal(r.hitRatePct, 45.7);
    assert.equal(r.medianPct, 1.23);
    assert.equal(r.medianExcessPct, -0.99);
    assert.equal(r.hitRateExcessPct, 40);
  });

  test('flags a thin sample', () => {
    const [r] = present({ '10d': { n: MIN_N - 1, unresolved: 0, medianExcessPct: 5 } });
    assert.equal(r.underSampled, true);
    assert.match(r.verdict, /too few/);
  });
});

describe('headline', () => {
  test('refuses to speak for a signal that cannot be scored', () => {
    const h = headline([], { blockedReason: 'needs a 200-day SMA' });
    assert.equal(h.state, 'unscoreable');
    assert.match(h.detail, /200-day SMA/);
  });

  test('says so when nothing has resolved', () => {
    assert.equal(headline(rows()).state, 'no-data');
  });

  // A signal is not allowed to look validated on a handful of firings.
  test('will not call a direction below the sample floor', () => {
    const h = headline(rows({ '10d': { n: 5, unresolved: 0, medianExcessPct: 9.9 } }));
    assert.equal(h.state, 'thin');
    assert.match(h.text, /too few/);
  });

  test('reports a positive edge once the sample is adequate', () => {
    const h = headline(rows({ '10d': { n: 60, unresolved: 3, medianExcessPct: 1.4 } }));
    assert.equal(h.state, 'positive');
    assert.match(h.text, /\+1\.4% vs NIFTY over 10d \(n=60\)/);
  });

  test('reports a negative edge just as plainly', () => {
    const h = headline(rows({ '10d': { n: 60, unresolved: 3, medianExcessPct: -1.4 } }));
    assert.equal(h.state, 'negative');
    assert.match(h.detail, /lagged the index by 1\.4%/);
  });

  test('marks a reconstructed sample as such', () => {
    const h = headline(rows({ '10d': { n: 60, unresolved: 0, medianExcessPct: 0.5 } }), { source: 'reconstructed' });
    assert.match(h.detail, /reconstructed from stored prices/);
  });

  // A warning is vindicated by the OPPOSITE arithmetic to a buy, and the badge
  // colours follow `state`, so getting this backwards would paint a correct
  // warning in the colour this app uses for "beat the index".
  test('a bearish signal that lagged the index is the claim HOLDING', () => {
    const h = headline(rows({ '10d': { n: 60, unresolved: 0, medianExcessPct: -1.4 } }), { direction: 'bearish' });
    assert.equal(h.state, 'held');
    assert.match(h.text, /warning held/);
    assert.ok(!/positive|negative/.test(h.state), 'must not borrow the bullish states');
  });

  test('a bearish signal that BEAT the index is the claim refuted', () => {
    const h = headline(rows({ '10d': { n: 60, unresolved: 0, medianExcessPct: 1.4 } }), { direction: 'bearish' });
    assert.equal(h.state, 'refuted');
    assert.match(h.text, /warning did not hold/);
    assert.match(h.detail, /evidence against acting on the warning/);
  });

  test('direction does not let a thin sample speak either way', () => {
    const h = headline(rows({ '10d': { n: 4, unresolved: 0, medianExcessPct: -9 } }), { direction: 'bearish' });
    assert.equal(h.state, 'thin');
  });

  test('degrades to raw return when there is no benchmark', () => {
    const h = headline(rows({ '10d': { n: 60, unresolved: 0, medianPct: 2, medianExcessPct: null } }));
    assert.equal(h.state, 'no-benchmark');
    assert.match(h.detail, /mostly reflects the market/);
  });
});
