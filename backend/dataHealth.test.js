const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// dataHealth builds a Supabase client at import time; the pure helpers under
// test never touch it, but the constructor throws on a missing URL.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { findGaps, checkFreshness } = require('./dataHealth');

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
