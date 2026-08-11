const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  bollinger, bandwidthSeries, squeezeMask, squeezeStarts, squeezeState,
  BB_PERIOD, SQUEEZE_LOOKBACK, MIN_BARS,
} = require('./squeeze');

/** A flat series, then a chosen amplitude of alternation. */
const series = (n, level = 100, amp = 0) =>
  Array.from({ length: n }, (_, i) => level + (amp ? (i % 2 ? amp : -amp) : 0));

// Building a fixture for this is harder than it looks, and both easy attempts
// are wrong:
//   · a regular alternation has CONSTANT bandwidth, so every bar ties for the
//     window minimum and everything reads as squeezed;
//   · a monotonic decay sets a NEW low every bar, so everything reads as
//     squeezed too — correctly, a steadily tightening stock is at a new low
//     daily.
// Bandwidth has to fall, rise, then fall again for any bar to be clearly not
// at a low. Amplitude ramps linearly between the given points.
function ramp(level, points) {
  const out = [];
  for (let s = 0; s < points.length - 1; s++) {
    const [n, from] = points[s];
    const to = points[s + 1][1];
    for (let i = 0; i < n; i++) {
      const amp = from + (to - from) * (i / n);
      out.push(level + (out.length % 2 ? amp : -amp));
    }
  }
  return out;
}
// tight -> wide -> tight. ~bar 85 sits in the widening leg; the tail is tight.
const vShape = () => ramp(100, [[40, 6], [50, 0.2], [40, 8], [0, 0.2]]);

describe('bollinger', () => {
  test('is null through the warmup and defined after it', () => {
    const bb = bollinger(series(25));
    for (let i = 0; i < BB_PERIOD - 1; i++) assert.equal(bb.middle[i], null, `bar ${i} should still be warming up`);
    assert.equal(bb.middle[BB_PERIOD - 1], 100);
  });

  test('a flat series has zero width', () => {
    const bb = bollinger(series(30));
    const i = 29;
    assert.equal(bb.upper[i], 100);
    assert.equal(bb.lower[i], 100);
  });

  // Population sd, not sample — matches the chart and most platforms. For a
  // ±1 alternation the population sd is exactly 1, so the bands sit at ±2.
  test('uses population standard deviation', () => {
    const bb = bollinger(series(30, 100, 1));
    const i = 29;
    assert.ok(Math.abs(bb.upper[i] - 102) < 1e-9, `upper was ${bb.upper[i]}`);
    assert.ok(Math.abs(bb.lower[i] - 98) < 1e-9, `lower was ${bb.lower[i]}`);
  });

  test('bandwidth is the band spread as a percent of the middle', () => {
    const bbw = bandwidthSeries(series(30, 100, 1));
    assert.ok(Math.abs(bbw[29] - 4) < 1e-9, `expected 4%, got ${bbw[29]}`);
  });
});

describe('squeezeMask', () => {
  // Without a full-window requirement the first bar past warmup is trivially
  // its own minimum, so every symbol "squeezes" on bar 20 — an artifact of the
  // warmup, not a volatility reading.
  test('refuses to judge until a whole lookback exists', () => {
    const bbw = bandwidthSeries(series(BB_PERIOD + 5, 100, 1));
    assert.equal(squeezeMask(bbw).some(Boolean), false, 'nothing may fire before a full window');
  });

  test('fires on the tight tail and not while volatility is expanding', () => {
    const closes = vShape();
    const mask = squeezeMask(bandwidthSeries(closes));
    assert.ok(mask[closes.length - 1], 'the quiet tail should read as squeezed');
    assert.ok(!mask[85], 'a bar in the widening leg is at a window high, not a low');
  });

  // Worth pinning because both look like bugs and neither is: at a window
  // minimum every bar qualifies, and a series that only ever tightens is
  // genuinely at a new low each day.
  test('a constant-bandwidth series is squeezed throughout, by definition', () => {
    assert.ok(squeezeMask(bandwidthSeries(series(120, 100, 3)))[119]);
  });

  // Worth pinning, because it looks like a bug and is not: if bandwidth never
  // varies, every bar IS its window minimum and all of them qualify.
  test('a constant-bandwidth series is squeezed throughout, by definition', () => {
    const mask = squeezeMask(bandwidthSeries(series(120, 100, 3)));
    assert.ok(mask[119], 'nothing is lower than a value that never changes');
  });

  test('the tolerance admits bars near the low, not only the exact minimum', () => {
    const closes = vShape();
    const bbw = bandwidthSeries(closes);
    const strict = squeezeMask(bbw, { tol: 1.0 });
    const loose = squeezeMask(bbw, { tol: 1.5 });
    assert.ok(loose.filter(Boolean).length >= strict.filter(Boolean).length);
  });

  // The whole module is only usable if bar i cannot see bar i+1.
  test('is causal — appending later bars never changes an earlier verdict', () => {
    const closes = vShape();
    const short = squeezeMask(bandwidthSeries(closes));
    const long = squeezeMask(bandwidthSeries([...closes, ...series(30, 100, 8)]));
    for (let i = 0; i < closes.length; i++) {
      assert.equal(long[i], short[i], `bar ${i} changed when future bars were added`);
    }
  });
});

describe('squeezeStarts', () => {
  // The rule that keeps n honest: a squeeze lasting twenty bars is ONE call.
  test('fires on the transition, not on every bar of the state', () => {
    const mask = [false, false, true, true, true, false, true, true];
    assert.deepEqual(squeezeStarts(mask), [2, 6]);
  });

  test('a state that never ends still fires once', () => {
    assert.deepEqual(squeezeStarts([false, true, true, true, true]), [1]);
  });

  test('never fires on bar zero, where there is no prior bar to transition from', () => {
    assert.deepEqual(squeezeStarts([true, true]), []);
  });
});

describe('squeezeState', () => {
  const closes = vShape();

  test('reports the current bandwidth and how long the squeeze has run', () => {
    const s = squeezeState(closes);
    assert.equal(s.squeezed, true);
    assert.ok(s.barsInSqueeze >= 1);
    assert.equal(typeof s.startedAt, 'number');
    // Relative, not an absolute threshold: what matters is that the tail is
    // compressed COMPARED WITH the widening leg, which is the comparison the
    // signal itself makes. An absolute cutoff would only be pinning the
    // fixture's arithmetic.
    const bbw = bandwidthSeries(closes);
    assert.ok(s.bandwidth < bbw[85], `tail ${s.bandwidth} should be tighter than the wide leg ${bbw[85]}`);
  });

  test('says nothing rather than guessing when history is too short', () => {
    const s = squeezeState(series(10));
    assert.equal(s.bandwidth, null);
    assert.equal(s.squeezed, null);
  });

  test('a stock with no squeeze reports zero bars, not null', () => {
    const s = squeezeState(series(120, 100, 3).map((v, i) => v + i));  // steady drift, no compression
    assert.equal(s.squeezed, false);
    assert.equal(s.barsInSqueeze, 0);
  });

  test('MIN_BARS covers the warmup plus a full lookback', () => {
    assert.equal(MIN_BARS, BB_PERIOD + SQUEEZE_LOOKBACK);
  });
});
