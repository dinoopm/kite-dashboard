const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// dataHealth builds a Supabase client at import time; the pure helpers under
// test never touch it, but the constructor throws on a missing URL.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { findGaps, checkFreshness, partitionGaps, ACKNOWLEDGED_GAPS } = require('./dataHealth');

// A week of index sessions, Mon-Fri.
const INDEX = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07'];

describe('findGaps', () => {
  test('finds nothing when the table has every session', () => {
    assert.deepEqual(findGaps(INDEX, INDEX), []);
  });

  // The exact failure this module was written for.
  test('reports sessions the index traded but the table never ingested', () => {
    const table = ['2026-07-01', '2026-07-02', '2026-07-07'];
    assert.deepEqual(findGaps(table, INDEX), ['2026-07-03', '2026-07-06']);
  });

  test('does not report the stretch before the table existed', () => {
    const table = ['2026-07-06', '2026-07-07'];
    assert.deepEqual(findGaps(table, INDEX), [], 'earlier sessions predate the feed, not gaps');
  });

  test('honours an explicit start date over the table first row', () => {
    const table = ['2026-07-06', '2026-07-07'];
    assert.deepEqual(findGaps(table, INDEX, '2026-07-02'), ['2026-07-02', '2026-07-03']);
  });

  test('handles an empty table without inventing gaps', () => {
    assert.deepEqual(findGaps([], INDEX), []);
  });

  test('ignores table dates the index never traded', () => {
    const table = [...INDEX, '2026-07-04']; // a Saturday row from a bad import
    assert.deepEqual(findGaps(table, INDEX), []);
  });

  // Bhavcopy lands hours after the close, so the index has today's bar before
  // the price feed does. Without an upper bound this fired a false "missing
  // session" alarm every afternoon.
  test('does not call today missing just because the feed has not landed yet', () => {
    const table = ['2026-07-01', '2026-07-02', '2026-07-03'];
    assert.deepEqual(findGaps(table, INDEX), [], 'the 06th and 07th are simply not in yet');
  });

  test('still reports a hole once the feed has moved past it', () => {
    const table = ['2026-07-01', '2026-07-03', '2026-07-06', '2026-07-07'];
    assert.deepEqual(findGaps(table, INDEX), ['2026-07-02'], 'skipped, then kept going');
  });
});

describe('partitionGaps', () => {
  const known = { dates: ['2026-07-16', '2026-07-17'], reason: 'recorder lost them' };

  test('sets aside the dates already accounted for', () => {
    const out = partitionGaps(['2026-07-16', '2026-07-17'], known);
    assert.deepEqual(out.gaps, []);
    assert.deepEqual(out.acknowledged, ['2026-07-16', '2026-07-17']);
  });

  // The property that keeps this from being a mute button: declaring two dates
  // must not buy silence on a third.
  test('still reports a gap that was never declared', () => {
    const out = partitionGaps(['2026-07-16', '2026-07-20', '2026-07-17'], known);
    assert.deepEqual(out.gaps, ['2026-07-20']);
    assert.deepEqual(out.acknowledged, ['2026-07-16', '2026-07-17']);
  });

  test('passes everything through for a feed with no declaration', () => {
    const out = partitionGaps(['2026-07-16'], undefined);
    assert.deepEqual(out.gaps, ['2026-07-16']);
    assert.deepEqual(out.acknowledged, []);
  });

  test('reports nothing for a feed with no gaps at all', () => {
    assert.deepEqual(partitionGaps([], known), { gaps: [], acknowledged: [] });
  });
});

describe('ACKNOWLEDGED_GAPS', () => {
  // A date silenced without a stated cause is indistinguishable from one
  // silenced because it was inconvenient.
  test('every declared gap carries dates and a reason', () => {
    for (const [table, entry] of Object.entries(ACKNOWLEDGED_GAPS)) {
      assert.ok(entry.dates?.length, `${table} declares no dates`);
      assert.ok(entry.reason?.length > 20, `${table} declares no reason`);
    }
  });
});

describe('checkFreshness', () => {
  test('is current when the feed has the latest session', () => {
    const f = checkFreshness('2026-07-07', INDEX);
    assert.equal(f.sessionsBehind, 0);
    assert.equal(f.stale, false);
  });

  // Counting in sessions, not days: over a weekend a Friday-current feed must
  // not be flagged on Monday morning.
  test('counts lag in sessions, not calendar days', () => {
    const f = checkFreshness('2026-07-03', INDEX);
    assert.equal(f.sessionsBehind, 2, 'two index sessions have printed since');
  });

  test('tolerates being one session behind by default', () => {
    assert.equal(checkFreshness('2026-07-06', INDEX).stale, false, 'today bhavcopy may not have landed');
    assert.equal(checkFreshness('2026-07-03', INDEX).stale, true);
  });

  test('respects a wider grace for feeds that publish late', () => {
    assert.equal(checkFreshness('2026-07-03', INDEX, { graceSessions: 2 }).stale, false);
  });

  test('treats a feed that has never been written as stale', () => {
    const f = checkFreshness(null, INDEX);
    assert.equal(f.stale, true);
    assert.equal(f.sessionsBehind, null);
  });
});

describe('feeds whose write days are not trading days', () => {
  const { FEEDS } = require('./dataHealth');

  // The macro recorder runs on GitHub Actions weekdays plus dailyJobs whenever
  // the server is up, so its write days do not line up with NSE sessions.
  // Gap-checking it would flag every weekend forever and the banner would stop
  // meaning anything — the failure mode ACKNOWLEDGED_GAPS exists to prevent.
  test('the macro regime feed is watched for freshness but not for gaps', () => {
    const macro = FEEDS.find(f => f.table === 'macro_signal_snapshots');
    assert.ok(macro, 'macro_signal_snapshots must be monitored — a stalled sync is otherwise invisible');
    assert.equal(macro.checkGaps, false);
    assert.ok(macro.grace >= 3, 'needs to tolerate a long weekend plus one missed run');
  });

  test('the price feeds are still gap-checked', () => {
    for (const t of ['nse_bhavcopy', 'nse_52_week_high_low']) {
      assert.notEqual(FEEDS.find(f => f.table === t).checkGaps, false, `${t} must keep its gap check`);
    }
  });
});
