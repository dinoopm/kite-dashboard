const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { findFirings, rsiSeries, tAgainstZero, BASE_BARS } = require('./baseBreakoutStudy');

const bar = (c) => ({ date: 'd', high: c * 1.005, low: c * 0.995, close: c });
// A tight base of `n` bars, then a clean ramp that drags SMA10 through SMA50.
const baseThenRamp = (n = BASE_BARS + 5, level = 100, rampBars = 60, step = 1.5) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(bar(level + (i % 5) * 0.2));   // ~1% band
  for (let i = 0; i < rampBars; i++) out.push(bar(level + step * (i + 1)));
  return out.map((b, i) => ({ ...b, date: `d${String(i).padStart(4, '0')}` }));
};

describe('rsiSeries', () => {
  test('is 100 when every bar rises', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    assert.equal(rsiSeries(closes)[39], 100);
  });

  test('is null during the warmup', () => {
    const r = rsiSeries(Array.from({ length: 40 }, (_, i) => 100 + i));
    assert.equal(r[0], null);
    assert.equal(r[13], null);
    assert.ok(r[14] != null);
  });
});

describe('tAgainstZero', () => {
  test('is near zero for a sample centred on zero', () => {
    const xs = [-1, 1, -1, 1, -1, 1, -1, 1];
    assert.ok(Math.abs(tAgainstZero(xs)) < 0.001);
  });

  test('grows with a consistent offset', () => {
    const xs = Array.from({ length: 100 }, (_, i) => 1 + (i % 2 ? 0.1 : -0.1));
    assert.ok(tAgainstZero(xs) > 10);
  });

  test('returns null rather than dividing by zero spread', () => {
    assert.equal(tAgainstZero([2, 2, 2, 2]), null);
    assert.equal(tAgainstZero([1]), null);
  });
});

describe('findFirings', () => {
  const loose = { maxRangePct: 45, maxAbsRet1Y: 20 };

  test('fires once on the crossover after a tight base', () => {
    const hits = findFirings(baseThenRamp(), loose);
    assert.equal(hits.length, 1, `expected a single firing, got ${hits.length}`);
    assert.ok(hits[0].rangePct < 45);
  });

  // The rule that stops one setup becoming forty rows.
  test('does not fire again while the fast SMA stays above the slow one', () => {
    const hits = findFirings(baseThenRamp(BASE_BARS + 5, 100, 150), loose);
    assert.equal(hits.length, 1, 'a long ramp is still one crossover');
  });

  test('rejects a base that is too wide', () => {
    const wide = [];
    for (let i = 0; i < BASE_BARS + 5; i++) wide.push(bar(100 + 60 * Math.sin(i / 7)));
    for (let i = 0; i < 60; i++) wide.push(bar(160 + 1.5 * i));
    const bars = wide.map((b, i) => ({ ...b, date: `d${i}` }));
    assert.equal(findFirings(bars, { maxRangePct: 45, maxAbsRet1Y: 200 }).length, 0);
  });

  // A stock can drift steadily upward inside a technically narrow band; that is
  // a trend, not a base, and the return bound is what excludes it.
  test('rejects a stock that trended through its base window', () => {
    const drift = [];
    for (let i = 0; i < BASE_BARS + 5; i++) drift.push(bar(100 * Math.pow(1.0015, i)));
    for (let i = 0; i < 60; i++) drift.push(bar(150 + 1.5 * i));
    const bars = drift.map((b, i) => ({ ...b, date: `d${i}` }));
    const strict = findFirings(bars, { maxRangePct: 200, maxAbsRet1Y: 20 });
    assert.equal(strict.length, 0, 'a 45% one-year gain is not a base');
  });

  test('needs a full base before it will fire at all', () => {
    const short = baseThenRamp(30, 100, 40);
    assert.equal(findFirings(short, loose).length, 0);
  });

  test('measures the base on bars strictly before the firing', () => {
    const hits = findFirings(baseThenRamp(), loose);
    // The ramp lifts price well outside the base band; if the breakout bar were
    // included in the range, rangePct would balloon past the 45% cap and the
    // firing would be filtered out entirely.
    assert.equal(hits.length, 1);
    assert.ok(hits[0].rangePct < 5, `base should stay tight, got ${hits[0].rangePct}`);
  });
});
