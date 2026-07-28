const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sessionVol, compareGroups, welchT, MIN_N } = require('./expiryStudy');

describe('sessionVol', () => {
  const bars = [
    { date: '2026-07-01', high: 102, low: 98, close: 100 },
    { date: '2026-07-02', high: 108, low: 104, close: 105 },
  ];

  test('measures intraday range against the close', () => {
    const v = sessionVol(bars);
    assert.equal(v[0].rangePct, 4); // (102-98)/100
  });

  // The first bar has nothing to compare against; scoring it as a 0% move
  // would drag the baseline down by one observation.
  test('leaves the first session without a close-to-close move', () => {
    const v = sessionVol(bars);
    assert.equal(v[0].absRetPct, null);
    assert.equal(v[1].absRetPct, 5);
  });

  test('keeps direction separately from magnitude', () => {
    const down = sessionVol([{ date: 'a', high: 1, low: 1, close: 100 }, { date: 'b', high: 1, low: 1, close: 95 }]);
    assert.equal(down[1].absRetPct, 5);
    assert.equal(down[1].retPct, -5);
  });

  test('skips a bar with no usable close', () => {
    assert.equal(sessionVol([{ date: 'a', close: 0 }, { date: 'b', close: null }]).length, 0);
  });
});

describe('welchT', () => {
  test('is near zero for two samples from the same distribution', () => {
    const a = [1, 2, 3, 4, 5], b = [1, 2, 3, 4, 5];
    assert.equal(welchT(a, b), 0);
  });

  test('is large when the means are far apart relative to spread', () => {
    const a = [10, 10.1, 9.9, 10.2, 9.8];
    const b = [1, 1.1, 0.9, 1.2, 0.8];
    assert.ok(welchT(a, b) > 10);
  });

  test('returns null rather than dividing by nothing', () => {
    assert.equal(welchT([1], [1, 2, 3]), null);
    assert.equal(welchT([], []), null);
  });
});

describe('compareGroups', () => {
  const flat = (n, v) => Array.from({ length: n }, () => v);

  test('reports the ratio of medians', () => {
    const c = compareGroups(flat(40, 2), flat(400, 1));
    assert.equal(c.ratio, 2);
    assert.equal(c.medianEvent, 2);
    assert.equal(c.medianBaseline, 1);
  });

  // The rule the study exists to respect: monthly expiries are ~12 a year, so
  // a short history cannot support a claim however big the gap looks.
  test('refuses to call a direction below the sample floor', () => {
    const c = compareGroups(flat(MIN_N - 1, 5), flat(200, 1));
    assert.equal(c.underSampled, true);
    assert.match(c.verdict, /too few to judge/);
  });

  // A large ratio on noisy data is exactly what folklore is made of.
  test('says so when a difference is not distinguishable from noise', () => {
    const noisy = [0.5, 3, 0.2, 4, 1, 2.5, 0.3, 3.5, 0.4, 2, 1.5, 3.2, 0.6, 2.8, 1.1,
                   3.9, 0.8, 2.2, 1.3, 3.1, 0.9, 2.6, 1.7, 3.4, 0.7];
    const base = [1.4, 1.6, 1.5, 1.3, 1.7, 1.45, 1.55, 1.35, 1.65, 1.5,
                  1.42, 1.58, 1.48, 1.52, 1.38, 1.62, 1.44, 1.56, 1.46, 1.54];
    const c = compareGroups(noisy, base);
    assert.ok(Math.abs(c.tStat) < 2, `t=${c.tStat} should be small`);
    assert.match(c.verdict, /not distinguishable from noise/);
  });

  test('calls a real difference once it is both large and significant', () => {
    const c = compareGroups(flat(40, 2).map((v, i) => v + (i % 2 ? 0.05 : -0.05)),
                            flat(400, 1).map((v, i) => v + (i % 2 ? 0.05 : -0.05)));
    assert.ok(Math.abs(c.tStat) > 2);
    assert.match(c.verdict, /100% higher/);
  });

  // A ratio of medians that straddle zero is governed by the denominator's
  // distance from zero, not by the effect: −0.001% against +0.062% reported as
  // "102% lower". Signed measures are compared in percentage points instead.
  test('reports signed measures as a difference, never a ratio', () => {
    const ev = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.05 : -0.05));
    const bs = Array.from({ length: 400 }, (_, i) => (i % 2 ? 0.11 : 0.01));
    const c = compareGroups(ev, bs, { signed: true });
    assert.equal(c.ratio, null, 'no ratio for a signed measure');
    assert.equal(c.diffPp, -0.06);
    assert.match(c.verdict, /−0\.06pp/);
    assert.doesNotMatch(c.verdict, /%\s(higher|lower)/);
  });

  test('suppresses the ratio when the baseline median is zero or negative', () => {
    const c = compareGroups(flat(40, 2), flat(400, 0));
    assert.equal(c.ratio, null);
  });

  test('handles an empty event group', () => {
    const c = compareGroups([], flat(100, 1));
    assert.equal(c.n, 0);
    assert.equal(c.verdict, 'no sessions');
  });

  test('ignores non-finite values on both sides', () => {
    const c = compareGroups([1, null, NaN, 2], [1, undefined, 3]);
    assert.equal(c.n, 2);
    assert.equal(c.nBaseline, 2);
  });
});
