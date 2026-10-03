'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SMA, RSI, ATR } = require('technicalindicators');
const { prepareAlertCandles } = require('./alertCandles');

function history(date = '2026-10-02T00:00:00+05:30') {
  return Array.from({ length: 30 }, (_, i) => ({
    date: i === 29 ? date : `2026-09-${String(i + 1).padStart(2, '0')}`,
    open: 100 + i, high: 103 + i, low: 98 + i, close: 101 + i, volume: 1000 + i,
  }));
}

function indicators(candles) {
  const close = candles.map(c => c.close);
  return {
    sma: SMA.calculate({ values: close, period: 20 }),
    rsi: RSI.calculate({ values: close, period: 14 }),
    atr: ATR.calculate({ close, high: candles.map(c => c.high), low: candles.map(c => c.low), period: 14 }),
  };
}

for (const [label, now] of [
  ['Saturday', '2026-10-03T10:00:00Z'],
  ['Sunday', '2026-10-04T10:00:00Z'],
  ['weekday with no broker candle', '2026-10-05T10:00:00Z'],
]) {
  test(`${label} preserves the last real bar and indicator values`, () => {
    const candles = history();
    const result = prepareAlertCandles(candles, 180, now);
    assert.deepEqual(result, candles);
    assert.equal(result.length, 30);
    assert.deepEqual(indicators(result), indicators(candles));
  });
}

test('updates an existing current-session candle without changing volume, open or cached bars', () => {
  const candles = history('2026-10-05T00:00:00+05:30');
  const original = structuredClone(candles);
  for (const price of [150, 90]) {
    const result = prepareAlertCandles(candles, price, '2026-10-05T05:00:00Z');
    assert.equal(result.length, candles.length);
    assert.equal(result.at(-1).close, price);
    assert.equal(result.at(-1).high, Math.max(original.at(-1).high, price));
    assert.equal(result.at(-1).low, Math.min(original.at(-1).low, price));
    assert.equal(result.at(-1).volume, original.at(-1).volume);
    assert.equal(result.at(-1).open, original.at(-1).open);
    assert.equal(result.at(-1).date, original.at(-1).date);
    assert.deepEqual(candles, original);
  }
});

test('uses India session dates across the UTC midnight boundary', () => {
  for (const date of ['2026-10-05', '2026-10-05T00:00:00+05:30']) {
    const result = prepareAlertCandles(history(date), '150', '2026-10-04T20:00:00Z');
    assert.equal(result.at(-1).close, 150);
  }
  // Both UTC timestamps are Sunday, but the quote check is already Monday in India.
  const candles = history('2026-10-04T00:00:00+05:30');
  assert.deepEqual(prepareAlertCandles(candles, 150, '2026-10-04T20:00:00Z'), candles);
});

test('invalid prices and invalid candle dates leave broker history untouched', () => {
  const candles = history('2026-10-05');
  for (const price of [null, undefined, '', 0, -1, NaN, Infinity, 'invalid']) {
    assert.deepEqual(prepareAlertCandles(candles, price, '2026-10-05T05:00:00Z'), candles);
  }
  const invalid = history('invalid');
  assert.deepEqual(prepareAlertCandles(invalid, 150, '2026-10-05T05:00:00Z'), invalid);
  assert.deepEqual(prepareAlertCandles([], 150), []);
});
