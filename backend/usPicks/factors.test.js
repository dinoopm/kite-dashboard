// backend/usPicks/factors.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const F = require('./factors');

const flat = (n, v) => Array.from({ length: n }, () => v);
const ramp = (n, from, step) => Array.from({ length: n }, (_, i) => from + i * step);

describe('momentumAt', () => {
  test('is the 20-session return ending 5 sessions ago', () => {
    const closes = ramp(40, 100, 1); // close[i] = 100 + i
    const i = 39;
    // close[34] / close[14] - 1 = 134/114 - 1
    assert.ok(Math.abs(F.momentumAt(closes, i) - (134 / 114 - 1)) < 1e-12);
  });
  test('is null before the window is warm', () => {
    assert.equal(F.momentumAt(ramp(20, 100, 1), 19), null);
  });
  test('accepts a different window for the backtest sweep', () => {
    const closes = ramp(100, 100, 1);
    assert.ok(Math.abs(F.momentumAt(closes, 99, { window: 60, skip: 5 }) - (194 / 134 - 1)) < 1e-12);
  });
});

describe('volumeAt', () => {
  test('a heavy up week with a price move is authentic', () => {
    const closes = [...flat(20, 100), 102, 104, 106, 108, 110];
    const volumes = [...flat(20, 1000), 3000, 3000, 3000, 3000, 3000];
    const v = F.volumeAt(closes, volumes, 24);
    assert.ok(Math.abs(v.surge - 2) < 1e-9, 'volume tripled');
    assert.equal(v.persistence, 1);
    assert.ok(v.authenticity > 0.6);
    assert.equal(v.trapRisk, false);
    assert.ok(v.volumeRaw > 0);
  });
  test('a heavy week with a flat price is a trap', () => {
    const closes = [...flat(20, 100), 100.1, 100, 100.2, 100.1, 100];
    const volumes = [...flat(20, 1000), 4000, 4000, 4000, 4000, 4000];
    const v = F.volumeAt(closes, volumes, 24);
    assert.equal(v.trapRisk, true);
    assert.match(v.trapReason, /flat/);
  });
  test('no surge means no trap and zero raw', () => {
    const v = F.volumeAt(flat(30, 100), flat(30, 1000), 29);
    assert.equal(v.trapRisk, false);
    assert.equal(v.volumeRaw, 0);
  });
  test('is unwarm before 20 sessions', () => {
    assert.equal(F.volumeAt(flat(10, 1), flat(10, 1), 9).surge, null);
  });
});

describe('fiftyTwoAt', () => {
  test('a fresh 252-session high scores +1 plus proximity', () => {
    const closes = [...flat(260, 100), 101, 102, 103, 104, 105];
    const f = F.fiftyTwoAt(closes, closes.length - 1);
    assert.equal(f.newHigh5, true);
    assert.equal(f.newLow5, false);
    assert.ok(Math.abs(f.fiftyTwoRaw - (1 + (1 - 0.8))) < 1e-9);
  });
  test('a fresh low scores −1', () => {
    const closes = [...flat(260, 100), 99, 98, 97, 96, 95];
    const f = F.fiftyTwoAt(closes, closes.length - 1);
    assert.equal(f.newLow5, true);
    assert.ok(f.fiftyTwoRaw < 0);
  });
  test('null before 252 sessions', () => {
    assert.equal(F.fiftyTwoAt(flat(100, 1), 99), null);
  });
});

describe('relStrengthAt', () => {
  test('is the stock return minus the SPY return, in points', () => {
    const closes = [...flat(63, 100), 110];
    const spy = [...flat(63, 400), 420];
    assert.ok(Math.abs(F.relStrengthAt(closes, spy, 63) - (10 - 5)) < 1e-9);
  });
  test('null when either leg is unwarm', () => {
    assert.equal(F.relStrengthAt(flat(10, 1), flat(10, 1), 9), null);
  });
});

describe('breadth', () => {
  test('labels by both SMA readings', () => {
    const on = Array.from({ length: 10 }, () => ({ aboveSma50: true, aboveSma200: true, momentumRaw: 0.1 }));
    assert.equal(F.breadth(on).label, 'risk-on');
    const off = on.map(() => ({ aboveSma50: false, aboveSma200: false, momentumRaw: -0.1 }));
    assert.equal(F.breadth(off).label, 'risk-off');
    const mixed = [...on.slice(0, 5), ...off.slice(0, 5)];
    assert.equal(F.breadth(mixed).label, 'mixed');
    assert.equal(F.breadth(mixed).pctAbove50, 50);
  });
});

describe('factorRowAt', () => {
  test('carries every factor and the SMA flags', () => {
    const closes = ramp(300, 100, 0.1);
    const volumes = flat(300, 1e6);
    const spy = ramp(300, 400, 0.1);
    const row = F.factorRowAt({ closes, volumes, spyCloses: spy }, 299);
    for (const k of ['momentumRaw', 'volumeRaw', 'fiftyTwoRaw', 'relStrengthRaw']) assert.equal(typeof row[k], 'number', k);
    assert.equal(row.aboveSma50, true);
    assert.equal(row.aboveSma200, true);
  });
});
