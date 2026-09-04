const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { snapshotIsDue } = require('./dailyJobs');

describe('snapshotIsDue', () => {
  test('is due when prices are newer than the last snapshot', () => {
    assert.equal(snapshotIsDue('2026-07-24', '2026-07-23'), true);
  });

  test('is not due once the snapshot has caught up', () => {
    assert.equal(snapshotIsDue('2026-07-24', '2026-07-24'), false);
  });

  // Bhavcopy is the trigger rather than the clock, so weekends and holidays
  // need no special handling: no new prices means no new snapshot is owed.
  test('is not due on a day with no new prices', () => {
    assert.equal(snapshotIsDue('2026-07-24', '2026-07-24'), false, 'Saturday: bhavcopy still Friday');
  });

  test('is due when nothing has ever been snapshotted', () => {
    assert.equal(snapshotIsDue('2026-07-24', null), true);
  });

  test('is not due when there are no prices at all', () => {
    assert.equal(snapshotIsDue(null, null), false);
    assert.equal(snapshotIsDue(null, '2026-07-24'), false);
  });

  // The old code set "tried today" before knowing the write worked, so one
  // failure lost the day. Being due is a function of stored state only, which
  // is what makes the retry on the next tick actually retry.
  test('stays due after a failed attempt, since nothing was written', () => {
    const before = snapshotIsDue('2026-07-24', '2026-07-23');
    const afterFailedRun = snapshotIsDue('2026-07-24', '2026-07-23');
    assert.equal(before, true);
    assert.equal(afterFailedRun, true);
  });
});

const { usSnapshotDue } = require('./dailyJobs');

describe('usSnapshotDue', () => {
  test('due once the SPY session has closed and nothing is recorded for it', () => {
    assert.equal(usSnapshotDue('2026-09-03', '2026-09-02', new Date('2026-09-03T21:30:00Z')), true);
  });
  test('not due while the session is still open', () => {
    assert.equal(usSnapshotDue('2026-09-03', '2026-09-02', new Date('2026-09-03T18:00:00Z')), false);
  });
  test('a bar from a previous day is closed regardless of the clock', () => {
    assert.equal(usSnapshotDue('2026-09-02', '2026-09-01', new Date('2026-09-03T10:00:00Z')), true);
  });
  test('not due when already recorded', () => {
    assert.equal(usSnapshotDue('2026-09-03', '2026-09-03', new Date('2026-09-03T23:00:00Z')), false);
  });
  test('not due with no SPY bar', () => {
    assert.equal(usSnapshotDue(null, null), false);
  });
});
