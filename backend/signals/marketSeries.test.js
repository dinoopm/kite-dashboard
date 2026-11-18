const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { mergeCalendars, alignToCalendar, findCalendarGaps } = require('./marketSeries');

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

describe('findCalendarGaps', () => {
  const cal = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08'];

  test('names the sessions the price table skipped', () => {
    const bhav = ['2026-07-01', '2026-07-02', '2026-07-08'];
    assert.deepEqual(findCalendarGaps(bhav, cal), ['2026-07-03', '2026-07-06', '2026-07-07']);
  });

  // The false alarm this bound exists for: the index prints today's close hours
  // before bhavcopy does, so an unbounded diff reports today as a hole every
  // afternoon. Not-yet-published is staleness, not a gap.
  test('ignores sessions after the table\'s last row', () => {
    assert.deepEqual(findCalendarGaps(['2026-07-01', '2026-07-02'], cal), []);
  });

  test('is empty when the table has every session', () => {
    assert.deepEqual(findCalendarGaps(cal, cal), []);
  });

  test('handles an empty table', () => {
    assert.deepEqual(findCalendarGaps([], cal), []);
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

describe('keyed paging', () => {
  const { keysetAfter, fetchAllKeyset } = require('./marketSeries');

  test('"after this key" covers every later row and quotes reserved characters', () => {
    const f = keysetAfter(['signal', 'snap_date', 'symbol'], { signal: 'us_x@v1/triggered', snap_date: '2026-07-10', symbol: 'M&M' });
    assert.equal(f, 'signal.gt."us_x@v1/triggered",and(signal.eq."us_x@v1/triggered",snap_date.gt."2026-07-10"),and(signal.eq."us_x@v1/triggered",snap_date.eq."2026-07-10",symbol.gt."M&M")');
    assert.match(keysetAfter(['a'], { a: 'say "hi", (ok)' }), /a\.gt\."say \\"hi\\", \(ok\)"/);
  });

  // A fake table: honours the `or` only by handing back the next slice, which
  // is what the real filter does — the point here is that paging terminates,
  // asks for the right key each time, and neither drops nor repeats a row.
  test('reads every row once, in pages, and stops', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ signal: 's', snap_date: `d${String(i).padStart(5, '0')}`, symbol: 'X' }));
    const asked = [];
    const client = { from: () => {
      let after = null;
      const q = {
        select: () => q, order: () => q,
        or: (f) => { asked.push(f); after = f.match(/snap_date\.gt\."(d\d+)"/)[1]; return q; },
        limit: async (n) => ({ data: all.filter(r => !after || r.snap_date > after).slice(0, n), error: null }),
      };
      return q;
    } };
    const out = await fetchAllKeyset('t', 'signal,snap_date,symbol', ['signal', 'snap_date', 'symbol'], null, { client });
    assert.equal(out.length, 2500);
    assert.equal(new Set(out.map(r => r.snap_date)).size, 2500);
    assert.equal(asked.length, 2); // pages 2 and 3; the third is short, so it stops
  });
});
