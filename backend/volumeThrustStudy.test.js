const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { findEvents, welchT, tAgainstZero } = require('./volumeThrustStudy');

// The network half of the study cannot be tested here, and does not need to be:
// what decides whether the result is trustworthy is the event set and the
// statistic, both of which are pure.

const bars = ({ flat = 80, ramp = 40, step = 2, volumeAt = null } = {}) => {
  const closes = [];
  for (let i = 0; i < flat; i++) closes.push(100 - i * 0.05); // drift down
  const base = 100 - (flat - 1) * 0.05;
  for (let i = 0; i < ramp; i++) closes.push(base + step * (i + 1));
  return closes.map((c, i) => ({
    date: `2020-01-${String((i % 28) + 1).padStart(2, '0')}`,
    high: c * 1.002, low: c * 0.998, close: c,
    volume: volumeAt && volumeAt(i) ? volumeAt(i) : 1000,
  }));
};

describe('findEvents', () => {
  test('finds the golden cross once and splits it into exactly one half', () => {
    const { crosses } = findEvents(bars());
    assert.equal(crosses.length, 1);
    assert.equal(crosses[0].confirmed, false, 'flat volume cannot confirm anything');
  });

  test('a heavy up day inside the window moves the cross to the confirmed half', () => {
    const at = findEvents(bars()).crosses[0].index;
    const { crosses } = findEvents(bars({ volumeAt: (i) => (i === at - 2 ? 4000 : 0) }), { mult: 2, window: 5 });
    assert.equal(crosses.length, 1);
    assert.equal(crosses[0].confirmed, true);
    assert.equal(crosses[0].barsAgo, 2);
  });

  // The sweep has to actually change the answer, or reporting a grid is theatre.
  // A gentler ramp is used here so the cross lands several bars INTO the rise:
  // with a steep ramp SMA10 clears SMA50 within three bars and there is no room
  // between a 3-session and a 5-session window. That lag is the same reason
  // CONFIRM_WINDOW is not zero in the first place.
  test('the window setting decides which half a firing lands in', () => {
    const at = findEvents(bars({ step: 0.3 })).crosses[0].index;
    const b = bars({ step: 0.3, volumeAt: (i) => (i === at - 4 ? 4000 : 0) });
    assert.equal(findEvents(b, { mult: 2, window: 5 }).crosses[0].confirmed, true);
    assert.equal(findEvents(b, { mult: 2, window: 3 }).crosses[0].confirmed, false);
  });

  test('the multiple setting does too', () => {
    const at = findEvents(bars()).crosses[0].index;
    const b = bars({ volumeAt: (i) => (i === at - 1 ? 2200 : 0) }); // 2.2x
    assert.equal(findEvents(b, { mult: 2, window: 5 }).crosses[0].confirmed, true);
    assert.equal(findEvents(b, { mult: 2.5, window: 5 }).crosses[0].confirmed, false);
  });

  test('thrusts are collected independently of any cross', () => {
    const b = bars({ volumeAt: (i) => (i === 30 ? 5000 : 0) });
    const { thrusts } = findEvents(b);
    // Bar 30 is in the drifting-DOWN stretch, so it is heavy but not an up
    // close — volume without direction is not a demand thrust.
    assert.equal(thrusts.length, 0);
    const up = findEvents(bars({ volumeAt: (i) => (i === 100 ? 5000 : 0) })).thrusts;
    assert.equal(up.length, 1);
    assert.equal(up[0].index, 100);
  });
});

describe('welchT', () => {
  test('is near zero for two samples drawn from the same place', () => {
    const a = Array.from({ length: 60 }, (_, i) => (i % 2 ? 1 : -1));
    const b = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1 : -1));
    assert.ok(Math.abs(welchT(a, b)) < 0.001);
  });

  test('grows when one sample sits consistently above the other', () => {
    const a = Array.from({ length: 60 }, (_, i) => 2 + (i % 2 ? 0.2 : -0.2));
    const b = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.2 : -0.2));
    assert.ok(welchT(a, b) > 10);
  });

  // Unequal spread is the case Welch exists for: a noisy confirmed set should
  // NOT read as significant just because its mean is higher.
  test('a higher mean with a much wider spread is not significant', () => {
    const a = Array.from({ length: 40 }, (_, i) => 1 + (i % 2 ? 30 : -30));
    const b = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.5 : -0.5));
    assert.ok(Math.abs(welchT(a, b)) < 2);
  });

  test('refuses to speak with fewer than two observations', () => {
    assert.equal(welchT([1], [1, 2, 3]), null);
    assert.equal(welchT([], []), null);
  });

  test('returns null rather than dividing by a zero spread', () => {
    assert.equal(welchT([2, 2, 2], [1, 1, 1]), null);
  });
});

describe('tAgainstZero', () => {
  test('is near zero for a sample centred on zero', () => {
    assert.ok(Math.abs(tAgainstZero([-1, 1, -1, 1, -1, 1])) < 0.001);
  });

  test('returns null rather than dividing by zero spread', () => {
    assert.equal(tAgainstZero([3, 3, 3]), null);
  });
});

// ─── The RSI gate sweep ─────────────────────────────────────────────────────
//
// Synthetic events rather than price paths: the sweep's job is the partition
// and the statistic, and building fixtures that cross at a chosen RSI is
// laborious enough to obscure what is being asserted. findEvents' own tests
// above cover the fact that `rsi` on a cross is the detector's figure.
describe('rsiSweep', () => {
  const { rsiSweep, RSI_GATES, HORIZONS } = require('./volumeThrustStudy');

  // excess is constant per event so the arithmetic is checkable by hand.
  const ev = (rsi, confirmed, ex) => ({
    symbol: `S${rsi}`, rsi, confirmed,
    excess: Object.fromEntries(HORIZONS.map(h => [h, ex])),
    raw: Object.fromEntries(HORIZONS.map(h => [h, ex])),
  });

  test('splits into kept and dropped at each gate, losing nothing', () => {
    const events = [ev(52, true, 1), ev(58, true, 2), ev(62, false, 3), ev(68, true, 4)];
    const s = rsiSweep(events, [60]);
    const g = s.allCrosses[0];
    assert.equal(g.kept.firings, 2, 'RSI 62 and 68');
    assert.equal(g.dropped.firings, 2, 'RSI 52 and 58');
    assert.equal(g.kept.firings + g.dropped.firings, events.length);
  });

  // The gate is strict: an event exactly ON the boundary is discarded, matching
  // the screener's `crossRsi > 60` rather than >=.
  test('a firing exactly at the gate is dropped, not kept', () => {
    const s = rsiSweep([ev(60, true, 1), ev(60.1, true, 1)], [60]);
    assert.equal(s.allCrosses[0].kept.firings, 1);
    assert.equal(s.allCrosses[0].dropped.firings, 1);
  });

  // The property that makes this a sweep rather than four separate studies: the
  // kept sets are nested, so kept counts fall monotonically as the gate rises.
  // If this ever fails the partition has been written the wrong way round.
  test('kept sets are nested, so kept counts only fall as the gate rises', () => {
    const events = [];
    for (let r = 51; r <= 79; r++) events.push(ev(r, r % 2 === 0, r / 10));
    const s = rsiSweep(events, RSI_GATES);
    const counts = s.allCrosses.map(g => g.kept.firings);
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] <= counts[i - 1], `gate ${RSI_GATES[i]} kept more than ${RSI_GATES[i - 1]}`);
    }
    assert.ok(counts[0] > counts[counts.length - 1], 'the sweep must actually narrow');
  });

  // The confirmedOnly column is what the shipped preset does. It must be a
  // subset of the all-crosses column, never a separate population.
  test('confirmedOnly is a subset of allCrosses at every gate', () => {
    const events = [];
    for (let r = 51; r <= 79; r++) events.push(ev(r, r % 3 === 0, 1));
    const s = rsiSweep(events, RSI_GATES);
    s.allCrosses.forEach((g, i) => {
      assert.ok(s.confirmedOnly[i].kept.firings <= g.kept.firings);
    });
    assert.equal(s.baseline.confirmedOnly.firings, events.filter(e => e.confirmed).length);
    assert.equal(s.baseline.allCrosses.firings, events.length);
  });

  // A gate that separates nothing must say so rather than reporting a
  // difference. This is the verdict that stops a useless gate looking useful.
  test('calls a gate useless when both halves perform identically', () => {
    // Both halves must clear MIN_N or the verdict is "too few to judge" and the
    // test would pass for the wrong reason, so 40 events sit on each side. They
    // also need non-zero spread: with a constant excess the standard error is
    // zero, welchT returns null, and the "no difference" verdict would be
    // reached without the statistic ever being computed.
    const spread = (i) => (i % 5) - 2;   // -2..2, mean 0
    const events = [];
    for (let i = 0; i < 40; i++) events.push(ev(51 + i * 0.2, true, 1.5 + spread(i)));
    for (let i = 0; i < 40; i++) events.push(ev(61 + i * 0.2, true, 1.5 + spread(i)));
    const g = rsiSweep(events, [60]).allCrosses[0];
    assert.equal(g.kept.firings, 40);
    assert.equal(g.dropped.firings, 40);
    const l = g.lift.find(x => x.horizon === '10d');
    assert.equal(l.meanDiffPct, 0);
    assert.match(l.verdict, /discard firings for nothing/);
  });

  // ...and the converse: a gate that does separate the two halves reports the
  // difference rather than hiding it.
  test('reports the difference when the kept half genuinely does better', () => {
    const spread = (i) => ((i % 5) - 2) * 0.2;   // small, so the gap dominates
    const events = [];
    for (let i = 0; i < 40; i++) events.push(ev(51 + i * 0.2, true, 0 + spread(i)));
    for (let i = 0; i < 40; i++) events.push(ev(61 + i * 0.2, true, 3 + spread(i)));
    const l = rsiSweep(events, [60]).allCrosses[0].lift.find(x => x.horizon === '10d');
    assert.equal(l.meanDiffPct, 3);
    assert.ok(l.tStat > 2, `t should clear the bar, got ${l.tStat}`);
    assert.match(l.verdict, /\+3\.00pp for kept firings/);
  });

  test('refuses to judge a gate that leaves too few on either side', () => {
    const events = [ev(55, true, 1), ev(65, true, 9)];
    const l = rsiSweep(events, [60]).allCrosses[0].lift.find(x => x.horizon === '10d');
    assert.match(l.verdict, /too few to judge/);
  });
});
