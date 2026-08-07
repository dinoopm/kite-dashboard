const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { pickEvalDates } = require('./backtest');

// The calendar in every case below is the merged one: 07-03/06/07 are sessions
// NIFTY traded and nse_bhavcopy skipped. `priced` is what bhavcopy actually has.
const CAL = [
  '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07',
  '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13', '2026-07-14',
];
const PRICED = CAL.filter(d => !['2026-07-03', '2026-07-06', '2026-07-07'].includes(d));

describe('pickEvalDates', () => {
  // The defect this whole change is for: on the bhavcopy-only calendar 07-02
  // and 07-08 are adjacent, so "+1 bar" spans four real sessions. Stepping on
  // the merged calendar makes a bar a bar again.
  test('counts steps in merged bars, not bhavcopy rows', () => {
    const out = pickEvalDates(CAL, PRICED, { step: 5, minHorizon: 1, floor: '2026-07-01' });
    assert.deepEqual(out, ['2026-07-01', '2026-07-08']);
  });

  // A gap date has no closes to rank or enter on, so it can never be an entry —
  // but it still consumes a bar, which is the point of merging.
  test('skips a step that lands on a session bhavcopy is missing', () => {
    const out = pickEvalDates(CAL, PRICED, { step: 3, minHorizon: 1, floor: '2026-07-01' });
    assert.deepEqual(out, ['2026-07-01', '2026-07-09']); // 07-06 (i=3) dropped
  });

  test('starts no earlier than the feed floor', () => {
    const out = pickEvalDates(CAL, PRICED, { step: 1, minHorizon: 1, floor: '2026-07-09' });
    assert.deepEqual(out, ['2026-07-09', '2026-07-10', '2026-07-13']);
  });

  // Room for the shortest horizon is measured on the merged calendar too, so
  // the tail that can't resolve is dropped rather than scored short.
  test('leaves room for the shortest horizon', () => {
    const out = pickEvalDates(CAL, PRICED, { step: 1, minHorizon: 5, floor: '2026-07-01' });
    assert.deepEqual(out, ['2026-07-01', '2026-07-02']);
  });

  test('is empty when nothing clears the floor', () => {
    assert.deepEqual(pickEvalDates(CAL, PRICED, { step: 1, minHorizon: 1, floor: '2027-01-01' }), []);
  });
});
