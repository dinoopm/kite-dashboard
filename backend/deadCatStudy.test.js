const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildSeries } = require('./backtest/indicators');
const { firingsFor, twoSampleT, tAgainstZero } = require('./deadCatStudy');

/** Flat, a hard fall, then whatever `after` supplies. */
const dropped = (after, { flat = 40, from = 100, to = 82, legs = 8 } = {}) => {
  const closes = [];
  for (let i = 0; i < flat; i++) closes.push(from);
  for (let i = 1; i <= legs; i++) closes.push(from - ((from - to) * i) / legs);
  closes.push(...after);
  return buildSeries(closes.map((c, i) => ({
    date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    high: c * 1.002, low: c * 0.998, close: c, volume: 1000,
  })));
};

const SHIPPED = { dropPct: 0.10, lookback: 10, midPeriod: 20 };

describe('firingsFor', () => {
  test('the signal and its control group are disjoint', () => {
    const S = dropped([83, 82, 84, 88, 93, 98, 103, 108]);
    const { signal, control } = firingsFor(S, SHIPPED);
    const inSignal = new Set(signal);
    for (const i of control) assert.equal(inSignal.has(i), false, `bar ${i} is in both sets`);
  });

  // The point of the control group: it is the SAME event minus the one clause
  // being tested, so a bounce the clause excludes has to land in it rather than
  // vanish. Getting there takes an unusual shape — a spike out of a depressed
  // base, then a fall back that is 10% off the 10-bar peak while still ABOVE
  // the 20-bar mean — which is itself worth knowing: the control is rare, so
  // the lift figure will stay under-sampled far longer than the signal does.
  test('a bounce that is above the mean lands in the control, not nowhere', () => {
    const closes = [];
    for (let i = 0; i < 30; i++) closes.push(70);           // a long depressed base
    for (let i = 0; i < 5; i++) closes.push(70 + 6 * (i + 1)); // spike to 100
    closes.push(94, 88, 86, 89, 92);                        // fall back, then up days
    const S = buildSeries(closes.map((c, i) => ({
      date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      high: c * 1.002, low: c * 0.998, close: c, volume: 1000,
    })));
    const { signal, control } = firingsFor(S, SHIPPED);
    assert.equal(signal.length, 0, 'nothing here is below the mean');
    assert.ok(control.length >= 1, 'an above-the-mean bounce must be kept as control');
  });

  test('a shallow dip produces neither', () => {
    const S = dropped([97, 98, 99], { to: 96 });
    const { signal, control } = firingsFor(S, SHIPPED);
    assert.equal(signal.length, 0);
    assert.equal(control.length, 0);
  });

  test('a looser drop threshold cannot fire less often than a tighter one', () => {
    const S = dropped([83, 82, 84, 86]);
    const loose = firingsFor(S, { ...SHIPPED, dropPct: 0.05 }).signal.length;
    const tight = firingsFor(S, { ...SHIPPED, dropPct: 0.15 }).signal.length;
    assert.ok(loose >= tight, `loose ${loose} < tight ${tight}`);
  });

  // Causality, the property that makes the whole study meaningful: a firing at
  // bar i must not depend on anything after i.
  test('a firing is unchanged by bars that come after it', () => {
    const S = dropped([83, 84]);
    const truncated = buildSeries(S.candles.slice(0, S.candles.length - 1));
    const full = firingsFor(S, SHIPPED).signal;
    const cut = firingsFor(truncated, SHIPPED).signal;
    assert.deepEqual(cut, full.filter(i => i < truncated.dates.length));
  });
});

describe('the statistics', () => {
  test('t against zero is null on a sample too small to have a spread', () => {
    assert.equal(tAgainstZero([]), null);
    assert.equal(tAgainstZero([1]), null);
  });

  test('a constant sample has no dispersion and so no t', () => {
    assert.equal(tAgainstZero([2, 2, 2, 2]), null);
  });

  test('twoSampleT is signed from the first sample', () => {
    const lower = [-3, -2, -4, -3, -2];
    const higher = [3, 2, 4, 3, 2];
    assert.ok(twoSampleT(lower, higher) < 0);
    assert.ok(twoSampleT(higher, lower) > 0);
  });

  test('identical samples give a t of zero, not a spurious edge', () => {
    const a = [1, -1, 2, -2, 0.5];
    assert.equal(twoSampleT(a, [...a]), 0);
  });
});
