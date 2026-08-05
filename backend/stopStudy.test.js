const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { replayStop, stopSeries } = require('./stopStudy');

// Bars with a controllable low, so a stop can be tripped deliberately.
const bar = (i, close, low = close * 0.99) => ({
  date: `d${String(i).padStart(3, '0')}`,
  high: close * 1.01, low, close,
});
const flat = (n, price) => Array.from({ length: n }, (_, i) => bar(i, price));

describe('stopSeries', () => {
  test('donchian trails the prior-window low, less an ATR buffer', () => {
    const bars = flat(60, 100);
    const s = stopSeries(bars, { kind: 'donchian', window: 20, atrBuffer: 0.3 });
    assert.equal(s[0], null, 'no opinion during warmup');
    assert.ok(s[40] < 99, `should sit below the 99 low, got ${s[40]}`);
  });

  test('atr trail sits a multiple of ATR below the close', () => {
    const bars = flat(60, 100);
    const near = stopSeries(bars, { kind: 'atr', mult: 2 });
    const far = stopSeries(bars, { kind: 'atr', mult: 4 });
    assert.ok(far[50] < near[50], 'a wider multiple is a looser stop');
  });

  test('supertrend offers no level while the trend is down', () => {
    // Steadily falling series — SuperTrend stays BEAR, so there is nothing to
    // trail and the rule must not invent a level.
    const bars = Array.from({ length: 80 }, (_, i) => bar(i, 200 - i * 1.5));
    const s = stopSeries(bars, { kind: 'supertrend', period: 10, mult: 3 });
    assert.ok(s.slice(40).every(v => v == null), 'no stop level in a downtrend');
  });

  test('fixed is anchored to entry, so it has no bar series', () => {
    assert.equal(stopSeries(flat(30, 100), { kind: 'fixed', pct: 10 }), null);
  });
});

describe('replayStop', () => {
  const rule20 = { kind: 'donchian', window: 20, atrBuffer: 0.3 };

  test('fires when the low breaches a fixed stop', () => {
    const bars = [...flat(10, 100), bar(10, 100, 88), ...flat(5, 100)];
    const r = replayStop(bars, 0, bars.length - 1, { kind: 'fixed', pct: 10 }, 100);
    assert.equal(r.stopped, true);
    assert.equal(r.stopIdx, 10);
    assert.equal(r.stopPrice, 90);
  });

  test('does not fire when price never reaches the level', () => {
    const bars = flat(20, 100);
    const r = replayStop(bars, 0, 19, { kind: 'fixed', pct: 10 }, 100);
    assert.equal(r.stopped, false);
  });

  // Causality: a stop can only act on a level that existed before the bar it is
  // tested against, or it "knows" the low it is about to be compared with.
  test('uses the previous bar level, never the current one', () => {
    const bars = flat(60, 100);
    // Drop the 50th bar hard. The trailing level in force comes from bar 49.
    bars[50] = bar(50, 100, 50);
    const r = replayStop(bars, 30, 59, rule20, 100);
    assert.equal(r.stopped, true);
    assert.equal(r.stopIdx, 50);
    assert.ok(r.stopPrice > 90, 'level came from before the crash bar, not from it');
  });

  test('cannot fire before entry', () => {
    const bars = [...flat(5, 100), bar(5, 100, 10), ...flat(30, 100)];
    // Entry is after the crash bar; the stop must not look back at it.
    const r = replayStop(bars, 10, 34, { kind: 'fixed', pct: 10 }, 100);
    assert.equal(r.stopped, false);
  });

  test('a looser stop fires later than a tighter one, or not at all', () => {
    const bars = [...flat(10, 100), bar(10, 100, 89), ...flat(10, 100)];
    const tight = replayStop(bars, 0, 20, { kind: 'fixed', pct: 8 }, 100);
    const loose = replayStop(bars, 0, 20, { kind: 'fixed', pct: 15 }, 100);
    assert.equal(tight.stopped, true);
    assert.equal(loose.stopped, false);
  });

  test('the trail ratchets up and never loosens', () => {
    // Rising series then a sharp drop: an ATR trail set high must still catch it.
    const rising = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i));
    const bars = [...rising, bar(60, 100, 100)];
    const r = replayStop(bars, 20, 60, { kind: 'atr', mult: 2 }, 120);
    assert.equal(r.stopped, true, 'a ratcheted stop catches the give-back');
    assert.ok(r.stopPrice > 120, 'and does so above the entry price');
  });
});
