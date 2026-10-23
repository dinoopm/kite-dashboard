import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurementPrice, measurementAxisValue, measurementTime } from './rechartsMeasurement.js';
import { priceMeasurement, measurementDate } from './priceMeasurement.js';

test('comparison-mode measurements use original prices, not percentage-axis differences', () => {
  const start = measurementPrice(-10, 100), end = measurementPrice(10, 100);
  assert.equal(start, 90);
  assert.ok(Math.abs(end - 110) < 1e-10);
  assert.ok(Math.abs(priceMeasurement({ price: start }, { price: end }).percent - 22.2222222222) < 1e-8);
  assert.ok(Math.abs(measurementAxisValue(end, 100) - 10) < 1e-10);
  assert.equal(measurementPrice(123, null), 123);
  assert.equal(measurementAxisValue(123, null), 123);
});
test('Indian daily bars retain their market date instead of shifting to the previous UTC date', () => {
  const point = measurementTime({ timestamp: '2026-10-21T00:00:00+05:30', date: 'Oct 21, 2026' });
  assert.equal(measurementDate(point.time), '21 Oct 2026');
  const us = measurementTime({ date: '2026-10-21T04:00:00Z' });
  assert.equal(measurementDate(us.time), '21 Oct 2026');
});
test('intraday points carry a real timestamp and local trading-session clock', () => {
  const point = measurementTime({ timestamp: '2026-10-21T09:15:00+05:30', date: '09:15' }, true, 'Asia/Kolkata');
  assert.equal(point.time, Date.parse('2026-10-21T09:15:00+05:30') / 1000);
  assert.match(point.label, /21 Oct.*09:15/);
});
