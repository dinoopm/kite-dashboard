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
