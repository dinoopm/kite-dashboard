const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { supertrendFlipUp, breakout, detectAll, PRICE_SIGNALS, signalMeta } = require('./registry');

const st = (dirs) => ({ supertrend: dirs.map(d => (d ? { direction: d, value: 1 } : null)), closes: dirs.map(() => 100) });

describe('supertrendFlipUp', () => {
  test('fires on the bar the trend turns bullish', () => {
    const S = st(['BEAR', 'BEAR', 'BULL']);
    assert.ok(supertrendFlipUp(S, 2));
  });

  // The rule the whole registry exists to enforce.
  test('does not fire again while the trend stays bullish', () => {
    const S = st(['BEAR', 'BULL', 'BULL', 'BULL']);
    assert.ok(supertrendFlipUp(S, 1), 'the flip itself');
    assert.equal(supertrendFlipUp(S, 2), null);
    assert.equal(supertrendFlipUp(S, 3), null);
  });

  test('does not fire on a flip down', () => {
    assert.equal(supertrendFlipUp(st(['BULL', 'BEAR']), 1), null);
  });

  test('does not fire on the seed bar with no prior direction', () => {
    assert.equal(supertrendFlipUp(st([null, 'BULL']), 1), null);
  });
});

describe('breakout', () => {
  // 30 bars flat at 100, then a push through.
  const flat = (n, v) => Array.from({ length: n }, () => v);
  const mk = (highs, closes) => ({
    highs, closes,
    volumes: highs.map(() => 1000),
    vol20avg: highs.map(() => 500),
  });

  test('fires when the close clears the prior 20-bar high', () => {
    const highs = [...flat(25, 100), 105];
    const closes = [...flat(25, 99), 104];
    const hit = breakout(20)(mk(highs, closes), 25);
    assert.ok(hit);
    assert.equal(hit.priorHigh, 100);
    assert.equal(hit.volRatio, 2);
  });

  test('does not fire on a stock already above the window', () => {
    // Broke out yesterday and kept going: only the first day should count.
    const highs = [...flat(25, 100), 105, 110];
    const closes = [...flat(25, 99), 104, 109];
    const S = mk(highs, closes);
    assert.ok(breakout(20)(S, 25), 'the breakout day');
    assert.equal(breakout(20)(S, 26), null, 'the follow-through day is not a new signal');
  });

  test('stays silent below the prior high', () => {
    const highs = [...flat(25, 100), 99];
    const closes = [...flat(25, 98), 98];
    assert.equal(breakout(20)(mk(highs, closes), 25), null);
  });

  test('returns null before a full window exists', () => {
    const highs = flat(5, 100), closes = flat(5, 101);
    assert.equal(breakout(20)(mk(highs, closes), 4), null);
  });
});

describe('detectAll', () => {
  const bars = 80;
  const S = {
    dates: Array.from({ length: bars }, (_, i) => `d${String(i).padStart(3, '0')}`),
    highs: Array.from({ length: bars }, (_, i) => (i === 70 ? 200 : 100)),
    closes: Array.from({ length: bars }, (_, i) => (i === 70 ? 199 : 99)),
    volumes: Array.from({ length: bars }, () => 1000),
    vol20avg: Array.from({ length: bars }, () => 500),
    supertrend: Array.from({ length: bars }, (_, i) => ({ direction: i >= 70 ? 'BULL' : 'BEAR', value: 1 })),
  };

  test('emits each signal once for a single clean event', () => {
    const hits = detectAll(S);
    const byName = {};
    for (const h of hits) (byName[h.signal] = byName[h.signal] || []).push(h.date);
    assert.deepEqual(byName.supertrend_flip_up, ['d070']);
    assert.deepEqual(byName.breakout_20d, ['d070']);
    assert.deepEqual(byName.breakout_55d, ['d070']);
  });

  test('fromDate limits a daily run to new bars', () => {
    assert.equal(detectAll(S, { fromDate: 'd071' }).length, 0);
    assert.ok(detectAll(S, { fromDate: 'd070' }).length > 0);
  });

  test('respects each signal minBars warmup', () => {
    const short = { ...S, dates: S.dates.slice(0, 30), highs: S.highs.slice(0, 30), closes: S.closes.slice(0, 30), volumes: S.volumes.slice(0, 30), vol20avg: S.vol20avg.slice(0, 30), supertrend: S.supertrend.slice(0, 30) };
    const names = new Set(detectAll(short).map(h => h.signal));
    assert.equal(names.has('breakout_55d'), false, '55-day window cannot exist in 30 bars');
  });
});

describe('registry', () => {
  test('every price signal declares what makes it fire', () => {
    for (const s of PRICE_SIGNALS) {
      assert.ok(s.description, `${s.name} needs a description`);
      assert.ok(s.minBars > 0, `${s.name} needs a warmup`);
      assert.equal(typeof s.detect, 'function');
    }
  });

  test('a signal that cannot be scored says why', () => {
    const vcp = signalMeta('vcp_setup');
    assert.ok(vcp, 'VCP is registered even though it cannot be scored yet');
    assert.match(vcp.blockedReason, /200-day SMA/);
  });
});
