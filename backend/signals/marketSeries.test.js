const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { mergeCalendars, alignToCalendar } = require('./marketSeries');

describe('mergeCalendars', () => {
  // The exact defect this exists for: bhavcopy dropped three sessions the
  // index traded, so bar-counted horizons spanned more real days than claimed.
  test('fills sessions the price table is missing', () => {
    const bhav = ['2026-07-01', '2026-07-02', '2026-07-08'];
    const bench = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08'];
    assert.deepEqual(mergeCalendars(bhav, bench, '2026-07-01'), bench);
  });

  test('keeps sessions only the price table has', () => {
    const bhav = ['2026-07-01', '2026-07-24'];
    const bench = ['2026-07-01'];
    assert.deepEqual(mergeCalendars(bhav, bench, '2026-07-01'), ['2026-07-01', '2026-07-24']);
  });

  test('drops everything before the start date', () => {
    const all = ['2026-06-30', '2026-07-01'];
    assert.deepEqual(mergeCalendars(all, all, '2026-07-01'), ['2026-07-01']);
  });

  test('deduplicates and sorts', () => {
    const out = mergeCalendars(['2026-07-02', '2026-07-01'], ['2026-07-01'], '2026-07-01');
    assert.deepEqual(out, ['2026-07-01', '2026-07-02']);
  });

  test('survives a missing benchmark', () => {
    assert.deepEqual(mergeCalendars(['2026-07-01'], null, '2026-07-01'), ['2026-07-01']);
  });
});

describe('alignToCalendar', () => {
  const cal = ['2026-07-01', '2026-07-02', '2026-07-03'];

  test('places closes on their own dates', () => {
    const m = new Map([['2026-07-01', 10], ['2026-07-03', 12]]);
    assert.deepEqual(alignToCalendar(cal, m), [
      { date: '2026-07-01', close: 10 },
      { date: '2026-07-02', close: null },
      { date: '2026-07-03', close: 12 },
    ]);
  });

  // Why nulls rather than dropping the bar: a dropped bar would shift every
  // later index and silently change what "5 days later" means.
  test('keeps a bar for a session it has no price for', () => {
    assert.equal(alignToCalendar(cal, new Map()).length, 3);
  });

  test('handles a symbol with no data at all', () => {
    assert.deepEqual(alignToCalendar(cal, undefined).map(b => b.close), [null, null, null]);
  });
});
