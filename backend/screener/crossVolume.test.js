const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeScreenerRow, SCREENER_FIELDS } = require('./engine');
const { buildSeries } = require('../backtest/indicators');
const { maCrossUp, smaSeries, CONFIRM_WINDOW } = require('../signals/registry');

// A slow drift down then a rally, which puts a 10/50 golden cross at bar 79 of
// 95 with RSI well over 50. Volume is flat at 1000 unless `spikes` says
// otherwise, so the ONLY thing separating the confirmed and quiet fixtures is
// volume — which is what makes them a test of the confirmation rule rather than
// of the price path.
const CROSS_BAR = 79;
function series(spikes = {}) {
  const bars = [];
  let p = 200;
  const push = (c, i) => bars.push({
    date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
    open: c, high: c * 1.01, low: c * 0.99, close: c, volume: spikes[i] || 1000,
  });
  for (let i = 0; i < 70; i++) { p *= 0.997; push(p, i); }
  for (let i = 70; i < 95; i++) { p *= 1.012; push(p, i); }
  return bars;
}

describe('the fixture itself', () => {
  // If the cross moves, every assertion below is measuring something else.
  test('puts one golden cross at the expected bar', () => {
    const S = buildSeries(series());
    const fired = [];
    for (let i = 1; i < S.closes.length; i++) if (maCrossUp(S, i)) fired.push(i);
    assert.deepEqual(fired, [CROSS_BAR]);
  });
});

describe('crossVolConfirmed', () => {
  test('is YES when a thrust lands inside the confirmation window', () => {
    // Bar 77 is two sessions before the cross, inside the 5-bar window, on an
    // up close, at 3x the trailing average.
    const r = computeScreenerRow(series({ 77: 3000 }));
    assert.equal(r.signal1050, 'BUY');
    assert.equal(r.crossVolConfirmed, 'YES');
  });

  test('is NO on the identical price path with flat volume', () => {
    const r = computeScreenerRow(series());
    assert.equal(r.signal1050, 'BUY');
    assert.equal(r.crossVolConfirmed, 'NO');
  });

  // The window is what makes the field mean anything: a 50-bar SMA turns days
  // after the buying that moved it, so the thrust need not land on the cross
  // bar — but it cannot be arbitrarily old either.
  test('ignores a thrust that lands before the window opens', () => {
    const tooEarly = CROSS_BAR - CONFIRM_WINDOW - 1;
    assert.equal(computeScreenerRow(series({ [tooEarly]: 3000 })).crossVolConfirmed, 'NO');
    assert.equal(computeScreenerRow(series({ [tooEarly + 1]: 3000 })).crossVolConfirmed, 'YES');
  });

  // Volume with no direction is not demand. The registry only counts a thrust
  // on an up close, and the screener must inherit that rather than counting any
  // heavy day.
  test('does not count a heavy day that closed down', () => {
    const bars = series({ 77: 3000 });
    // Force bar 77 to close below bar 76 without touching its volume.
    bars[77] = { ...bars[77], close: bars[76].close * 0.97 };
    const S = buildSeries(bars);
    const hit = maCrossUp(S, CROSS_BAR);
    assert.ok(hit, 'the cross must still fire, or this tests nothing');
    assert.equal(hit.confirmed, false);
  });
});

describe('crossVolRatio', () => {
  test('reports volume at the cross bar, not the confirming bar', () => {
    const r = computeScreenerRow(series({ 77: 3000 }));
    assert.equal(r.crossVolConfirmed, 'YES');
    // The 3x thrust was bar 77; the cross bar traded 1000 like every other day.
    // It reads 0.91 rather than 1.00 because vol20avg[79] averages bars 59-78,
    // which contains the spike — the baseline excludes the bar being measured
    // but not earlier ones, so a thrust lifts the denominator for 20 sessions
    // after it. Pinned because it is the kind of arithmetic that looks like a
    // bug later and gets "fixed" into double-counting the spike.
    assert.equal(r.crossVolRatio, 0.91);
    // Whatever the figure, it must be the one recorded with the emission.
    const S = buildSeries(series({ 77: 3000 }));
    assert.equal(r.crossVolRatio, maCrossUp(S, CROSS_BAR).volRatio);
  });

  // The distinction that makes this a separate field from volSurge. A stock can
  // have crossed weeks ago on heavy volume and be quiet today — volSurge would
  // miss it entirely.
  test('is independent of volSurge, which describes today', () => {
    const r = computeScreenerRow(series({ 77: 3000 }));
    assert.ok(r.volSurge < 1, `today is not a volume day (volSurge ${r.volSurge})`);
    assert.equal(r.crossVolConfirmed, 'YES', 'but the buy still had demand behind it');
  });
});

describe('absence is null, never NO', () => {
  // A null field never matches a condition, so `crossVolConfirmed is NO` cannot
  // sweep in stocks that simply have no buy to ask the question about. Encoding
  // those as 'NO' would quietly pad any screen for unconfirmed crosses.
  test('null when the latest signal is not a BUY', () => {
    const bars = [];
    let p = 200;
    for (let i = 0; i < 95; i++) { p *= 0.995; bars.push({
      date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
      open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000 }); }
    const r = computeScreenerRow(bars);
    assert.notEqual(r.signal1050, 'BUY');
    assert.equal(r.crossVolConfirmed, null);
    assert.equal(r.crossVolRatio, null);
  });

  test('null when there is not enough history to cross at all', () => {
    const r = computeScreenerRow(series().slice(0, 40));
    assert.equal(r.signal1050, 'NONE');
    assert.equal(r.crossVolConfirmed, null);
  });
});

describe('the fields are declared to the UI and to validation', () => {
  for (const [key, type] of [['crossVolConfirmed', 'enum'], ['crossVolRatio', 'number']]) {
    test(`${key} is in the catalog as ${type}`, () => {
      const f = SCREENER_FIELDS.find(x => x.key === key);
      assert.ok(f, `${key} missing from SCREENER_FIELDS — the condition builder cannot offer it`);
      assert.equal(f.type, type);
    });
  }
});

// ─── The anti-drift contract ────────────────────────────────────────────────
//
// engine.js used to carry its own copy of the buy rule and it had already
// drifted from the registry's: the registry drops a cross firing below the
// 20-bar mean right after a sharp fall (the chart's hollow DC marker) and the
// copy did not. It never showed up in practice — a golden cross almost never
// fires with price under its own 20-bar mean — which is exactly why it survived.
//
// The screener now calls maCrossUp directly, so the rules cannot differ. This
// sweep is what stops a future edit from reintroducing a second copy: it walks
// fat-tailed random walks, where sharp drops actually occur, and demands the
// screener's BUY be the registry's last firing, bar for bar.
describe('screener BUY is the registry signal, not a second copy of it', () => {
  const rng = (a) => () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  test('agrees with ma_cross_up across 120 fat-tailed walks', () => {
    let checked = 0, buys = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = rng(seed);
      const bars = [];
      let p = 100;
      for (let i = 0; i < 260; i++) {
        // A 4% chance of a large one-day shock, so dead-cat geometry is
        // reachable rather than smoothed away by a gentle walk.
        const shock = rnd() < 0.04 ? (rnd() - 0.7) * 0.14 : (rnd() - 0.49) * 0.03;
        p = Math.max(1, p * (1 + shock));
        bars.push({ date: new Date(2024, 0, 1 + i).toISOString().slice(0, 10),
          open: p, high: p * 1.012, low: p * 0.988, close: p, volume: 1000 + Math.floor(rnd() * 3000) });
      }
      const row = computeScreenerRow(bars);
      const S = buildSeries(bars);
      let lastFire = null;
      for (let i = 1; i < bars.length; i++) if (maCrossUp(S, i)) lastFire = i;

      if (row.signal1050 === 'BUY') {
        buys++;
        assert.equal(lastFire != null, true, `seed ${seed}: screener says BUY, registry never fired`);
        assert.equal(row.signal1050Age, bars.length - 1 - lastFire, `seed ${seed}: buy age disagrees`);
        assert.equal(row.crossVolConfirmed, maCrossUp(S, lastFire).confirmed ? 'YES' : 'NO', `seed ${seed}`);
      }
      checked++;
    }
    assert.equal(checked, 120);
    // If the sweep stopped producing buys it would pass vacuously.
    assert.ok(buys > 20, `only ${buys} buys in the sweep — too few to be a real check`);
  });
});
