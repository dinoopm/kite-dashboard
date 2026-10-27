import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateSeverity, severitySegments } from './severityTimeline.js';
test('historical labels match exact dates and never carry over missing or live quote dates', () => {
  const prices = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'].map(date => ({ date, close: 18 }));
  const result = annotateSeverity(prices, { series: [{ date: '2026-10-21', state: 'CAUTION' }, { date: '2026-10-23', state: 'INCOMPLETE' }] });
  assert.deepEqual(result.map(point => point.riskState), ['CAUTION', null, null, null]);
  assert.equal(prices[0].riskState, undefined);
});
test('timeline segments preserve short periods, gaps and mixed states without merging across them', () => {
  const points = ['CAUTION', 'CAUTION', null, 'CAUTION', 'MIXED', 'STRESS', 'CRASH MODE'].map((riskState, i) => ({ date: `day-${i}`, riskState }));
  const segments = severitySegments(points);
  assert.deepEqual(segments.map(s => [s.state, s.first, s.last]), [['CAUTION', 0, 1], ['CAUTION', 3, 3], ['MIXED', 4, 4], ['STRESS', 5, 5], ['CRASH MODE', 6, 6]]);
});
