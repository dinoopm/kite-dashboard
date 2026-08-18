const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { supertrendFlipUp, breakout, volumeThrust, detectAll, PRICE_SIGNALS, signalMeta } = require('./registry');

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
    rsi14: Array.from({ length: bars }, (_, i) => (i < 14 ? null : 60)),
    supertrend: Array.from({ length: bars }, (_, i) => ({ direction: i >= 70 ? 'BULL' : 'BEAR', value: 1 })),
  };

  test('emits each signal once for a single clean event', () => {
    const hits = detectAll(S);
    const byName = {};
    for (const h of hits) (byName[h.signal] = byName[h.signal] || []).push(h.date);
    assert.deepEqual(byName.supertrend_flip_up, ['d070']);
    assert.deepEqual(byName.breakout_20d, ['d070']);
    assert.deepEqual(byName.breakout_55d, ['d070']);
    // The single spike bar is up on 2x its baseline, so it is a thrust, and it
    // drags SMA10 through SMA50 — one buy, confirmed, and nothing in the
    // control group. All three land on the same bar and none repeats.
    assert.deepEqual(byName.volume_thrust, ['d070']);
    assert.deepEqual(byName.ma_cross_up, ['d070']);
    assert.deepEqual(byName.ma_cross_volume, ['d070']);
    assert.equal(byName.ma_cross_quiet, undefined);
  });

  test('fromDate limits a daily run to new bars', () => {
    assert.equal(detectAll(S, { fromDate: 'd071' }).length, 0);
    assert.ok(detectAll(S, { fromDate: 'd070' }).length > 0);
  });

  test('respects each signal minBars warmup', () => {
    const short = { ...S, dates: S.dates.slice(0, 30), highs: S.highs.slice(0, 30), closes: S.closes.slice(0, 30), volumes: S.volumes.slice(0, 30), vol20avg: S.vol20avg.slice(0, 30), rsi14: S.rsi14.slice(0, 30), supertrend: S.supertrend.slice(0, 30) };
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

// A series whose volume is flat at `base` except where `spikes` says otherwise,
// and whose closes rise by default. vol20avg mirrors buildSeries exactly (the
// 20 bars ENDING AT i-1) so these tests exercise the same arithmetic the
// recorder will, not a convenient approximation of it.
const volSeries = (volumes, closes) => {
  const n = volumes.length;
  const vol20avg = new Array(n).fill(null);
  for (let i = 20; i < n; i++) {
    let sum = 0;
    for (let j = i - 20; j < i; j++) sum += volumes[j];
    vol20avg[i] = sum / 20;
  }
  return { volumes, closes, vol20avg };
};

// 40 quiet bars of 1000 lots, closes drifting up a rupee a day.
const quiet = (n = 40) => ({
  volumes: new Array(n).fill(1000),
  closes: Array.from({ length: n }, (_, i) => 100 + i),
});

describe('volumeThrust', () => {
  test('fires on a heavy up day', () => {
    const q = quiet();
    q.volumes[30] = 2500;
    const hit = volumeThrust(volSeries(q.volumes, q.closes), 30);
    assert.ok(hit);
    assert.equal(hit.volRatio, 2.5);
    assert.equal(hit.avgVol, 1000);
  });

  test('ignores heavy volume on a DOWN close — that is distribution, not demand', () => {
    const q = quiet();
    q.volumes[30] = 5000;
    q.closes[30] = q.closes[29] - 5;
    assert.equal(volumeThrust(volSeries(q.volumes, q.closes), 30), null);
  });

  test('an unchanged close is not an up close', () => {
    const q = quiet();
    q.volumes[30] = 5000;
    q.closes[30] = q.closes[29];
    assert.equal(volumeThrust(volSeries(q.volumes, q.closes), 30), null);
  });

  test('does not fire on ordinary volume', () => {
    const q = quiet();
    q.volumes[30] = 1900; // 1.9x — under the bar
    assert.equal(volumeThrust(volSeries(q.volumes, q.closes), 30), null);
  });

  // The rule the whole registry exists to enforce, in its volume form: news
  // keeps a stock heavy for days, and that is one call, not four.
  test('a run of heavy up days is ONE firing', () => {
    const q = quiet();
    q.volumes[30] = 3000;
    q.volumes[31] = 4000;
    q.volumes[32] = 3500;
    const S = volSeries(q.volumes, q.closes);
    assert.ok(volumeThrust(S, 30), 'the first day of the run');
    assert.equal(volumeThrust(S, 31), null);
    assert.equal(volumeThrust(S, 32), null);
  });

  test('a quiet day between two spikes makes the second one a fresh call', () => {
    const q = quiet();
    q.volumes[30] = 3000;
    q.volumes[31] = 1000; // back to normal
    q.volumes[32] = 3000;
    const S = volSeries(q.volumes, q.closes);
    assert.ok(volumeThrust(S, 30));
    assert.ok(volumeThrust(S, 32));
  });

  // A heavy DOWN day does not suppress the next day's thrust, because it was
  // never a firing itself — the guard tracks the signal, not merely the volume.
  test('yesterday being heavy but DOWN does not swallow today', () => {
    const q = quiet();
    q.volumes[30] = 4000;
    q.closes[30] = q.closes[29] - 5;
    q.volumes[31] = 4000;
    q.closes[31] = q.closes[30] + 8;
    assert.ok(volumeThrust(volSeries(q.volumes, q.closes), 31));
  });

  test('says nothing while the 20-day baseline is still warming up', () => {
    const q = quiet();
    q.volumes[10] = 9999;
    assert.equal(volumeThrust(volSeries(q.volumes, q.closes), 10), null);
  });

  test('survives a zero-volume baseline instead of dividing by it', () => {
    const n = 40;
    const volumes = new Array(n).fill(0);
    volumes[30] = 5000;
    const closes = Array.from({ length: n }, (_, i) => 100 + i);
    assert.equal(volumeThrust(volSeries(volumes, closes), 30), null);
  });

  // minBars must be high enough that the run guard can read a real previous
  // bar. At i = 21 the guard's own previous close is index 19 — fine — but at
  // the registry's first evaluated bar everything it touches must exist.
  test('registry minBars leaves the run guard fully warm', () => {
    const meta = signalMeta('volume_thrust');
    assert.ok(meta.minBars >= 22, 'needs 20 baseline + the guard bar + its own previous close');
  });
});

// ─── The chart's Buy rule, and the volume split over it ──────────────────────

const { buildSeries } = require('../backtest/indicators');
const { maCrossUp, maCrossVolume, maCrossQuiet, thrustWithin, CONFIRM_WINDOW } = require('./registry');

/**
 * Bars that sit flat, then ramp hard enough to drag SMA10 through SMA50.
 * Built through buildSeries so the detectors see exactly the series the
 * recorder will hand them — RSI included, since the rule filters on it.
 */
const rampSeries = ({ flat = 80, ramp = 40, step = 2, volumes = null } = {}) => {
  const candles = [];
  // A gentle drift DOWN, not a wiggle: SMA10 has to sit cleanly below SMA50
  // going in, or the fixture manufactures crossovers of its own and the test
  // stops being about the ramp.
  for (let i = 0; i < flat; i++) candles.push({ close: 100 - i * 0.05 });
  const base = 100 - (flat - 1) * 0.05;
  for (let i = 0; i < ramp; i++) candles.push({ close: base + step * (i + 1) });
  return buildSeries(candles.map((c, i) => ({
    date: `d${String(i).padStart(4, '0')}`,
    high: c.close * 1.002, low: c.close * 0.998, close: c.close,
    volume: volumes ? volumes(i) : 1000,
  })));
};

/** The one bar in a series where the golden-cross buy fires, or -1. */
const firstCross = (S) => {
  for (let i = 51; i < S.dates.length; i++) if (maCrossUp(S, i)) return i;
  return -1;
};

describe('maCrossUp', () => {
  test('fires on the crossover bar, and only there', () => {
    const S = rampSeries();
    const i = firstCross(S);
    assert.ok(i > 0, 'the ramp should produce a golden cross');
    // Once the fast SMA is above the slow one it STAYS above for the rest of
    // the ramp. Firing on each of those bars is the mistake this whole registry
    // is built to avoid.
    for (let j = i + 1; j < S.dates.length; j++) assert.equal(maCrossUp(S, j), null, `re-fired at ${j}`);
  });

  test('carries the relative volume of the cross bar on every row', () => {
    const S = rampSeries();
    const hit = maCrossUp(S, firstCross(S));
    assert.ok(hit.volRatio != null);
    assert.equal(typeof hit.confirmed, 'boolean');
  });

  test('excludes the dead-cat bounce the chart already refuses to act on', () => {
    // A sharp drop, then a cross that fires while the close is still under the
    // 20-bar mean: flagged amber in the UI, so it must not be scored as a buy.
    const candles = [];
    for (let i = 0; i < 60; i++) candles.push(100 + i * 0.5);          // uptrend
    for (let i = 0; i < 12; i++) candles.push(130 - i * 2.2);          // sharp drop
    for (let i = 0; i < 8; i++) candles.push(103.6 + i * 0.15);        // limp bounce
    const S = buildSeries(candles.map((c, i) => ({
      date: `d${String(i).padStart(4, '0')}`, high: c * 1.002, low: c * 0.998, close: c, volume: 1000,
    })));
    for (let i = 51; i < S.dates.length; i++) {
      const hit = maCrossUp(S, i);
      if (hit) assert.fail(`scored a dead-cat bounce as a buy at ${i}`);
    }
  });
});

describe('the volume split over the cross', () => {
  // A quiet series: every bar 1000 lots, so nothing can confirm anything.
  const quietS = () => rampSeries();
  // The same series with a 4x day right before the cross.
  const loudS = (offset) => {
    const base = rampSeries();
    const i = firstCross(base);
    return rampSeries({ volumes: (k) => (k === i - offset ? 4000 : 1000) });
  };

  test('confirmed and quiet are disjoint and together are the baseline', () => {
    for (const S of [quietS(), loudS(0), loudS(2)]) {
      const i = firstCross(S);
      const all = maCrossUp(S, i);
      const conf = maCrossVolume(S, i);
      const quiet = maCrossQuiet(S, i);
      assert.ok(all, 'baseline fires');
      assert.ok(!(conf && quiet), 'a firing cannot be in both halves');
      assert.ok(conf || quiet, 'a firing must be in one of them');
    }
  });

  test('a heavy up day inside the window confirms the cross', () => {
    const S = loudS(2);
    const i = firstCross(S);
    assert.ok(maCrossVolume(S, i), 'should be confirmed');
    assert.equal(maCrossQuiet(S, i), null);
    assert.equal(maCrossUp(S, i).confirmedBarsAgo, 2);
  });

  test('a heavy day OUTSIDE the window does not confirm it', () => {
    const S = loudS(CONFIRM_WINDOW + 3);
    const i = firstCross(S);
    assert.equal(maCrossVolume(S, i), null);
    assert.ok(maCrossQuiet(S, i), 'should fall to the control group');
  });

  test('a flat-volume series puts every cross in the control group', () => {
    const S = quietS();
    const i = firstCross(S);
    assert.equal(maCrossVolume(S, i), null);
    assert.ok(maCrossQuiet(S, i));
  });

  // Confirmation asks "was there heavy demand recently", which the second day
  // of a heavy run answers just as well as the first — unlike RECORDING, where
  // the run guard stops one episode becoming four rows.
  test('the second day of a heavy run still confirms', () => {
    const base = rampSeries();
    const i = firstCross(base);
    const S = rampSeries({ volumes: (k) => (k === i - 3 || k === i - 2 ? 4000 : 1000) });
    assert.ok(thrustWithin(S, i) >= 0);
    assert.equal(thrustWithin(S, i), i - 2, 'the most recent heavy bar');
  });
});

// A corpus-level version of the invariant the scorecard depends on. If the two
// halves ever stop summing to the baseline, every comparison drawn between them
// is measuring overlapping sets and the "lift" from volume confirmation becomes
// an artefact of double counting.
describe('the split holds across a random corpus', () => {
  test('confirmed + quiet = all, over 200 random walks', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let all = 0, confirmed = 0, quiet = 0;

    for (let trial = 0; trial < 200; trial++) {
      const n = 120 + Math.floor(rnd() * 60);
      const candles = [];
      let close = 100;
      for (let i = 0; i < n; i++) {
        close = Math.max(1, close * (1 + (rnd() - 0.47) * 0.05));
        candles.push({
          date: `d${String(i).padStart(4, '0')}`,
          high: close * 1.01, low: close * 0.99, close: +close.toFixed(2),
          // Fat-tailed, so heavy days genuinely occur and both halves fill.
          volume: Math.round(1000 * (0.4 + rnd() * 1.2) * (rnd() > 0.9 ? 3 + rnd() * 3 : 1)),
        });
      }
      const S = buildSeries(candles);
      for (const hit of detectAll(S)) {
        if (hit.signal === 'ma_cross_up') all++;
        if (hit.signal === 'ma_cross_volume') confirmed++;
        if (hit.signal === 'ma_cross_quiet') quiet++;
      }
    }

    assert.ok(all > 50, `the corpus should produce crosses, got ${all}`);
    assert.ok(confirmed > 0 && quiet > 0, `both halves should fill (${confirmed}/${quiet})`);
    assert.equal(confirmed + quiet, all);
  });
});
