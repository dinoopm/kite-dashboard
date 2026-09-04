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
    assert.equal(usSnapshotDue('2026-09-03', '2026-09-02', new Date('2026-09-03T22:30:00Z')), true);
  });
  test('not due while the session is still open', () => {
    assert.equal(usSnapshotDue('2026-09-03', '2026-09-02', new Date('2026-09-03T18:00:00Z')), false);
  });
  // 16:00 EST is 21:00 UTC exactly, so a 21:00 cutoff would fire at the bell
  // with no room for the closing auction to settle.
  test('does not fire at the winter closing bell itself', () => {
    assert.equal(usSnapshotDue('2026-01-14', '2026-01-13', new Date('2026-01-14T21:00:00Z')), false);
    assert.equal(usSnapshotDue('2026-01-14', '2026-01-13', new Date('2026-01-14T22:00:00Z')), true);
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

const { macroRecordDue } = require('./dailyJobs');

// The bug this guards: the macro block used to decide "already done today" from
// the snapshot row and then skip the INGEST as well. The snapshot is written a
// few minutes after 00:00 UTC; the jobs report lands at 12:30 UTC. So on
// 2026-09-04 the panel showed July payrolls all day, and would have until the
// next midnight, with FRED already serving August.
describe('macroRecordDue', () => {
  const scored = ['PAYEMS', 'CPILFESL'];
  const nothing = [{ seriesId: 'PAYEMS', inserted: 0, revised: 0, skipped: 30 }];

  test('due when nothing is recorded for today', () => {
    assert.equal(macroRecordDue(false, nothing, scored).due, true);
  });

  test('not due when today is recorded and the ingest changed nothing', () => {
    assert.equal(macroRecordDue(true, nothing, scored).due, false);
  });

  // The whole point: a release landing after the snapshot must re-record it.
  test('due again when a scored series gains an observation', () => {
    const r = macroRecordDue(true, [{ seriesId: 'PAYEMS', inserted: 1, revised: 0, skipped: 29 }], scored);
    assert.equal(r.due, true);
    assert.deepEqual(r.changed, ['PAYEMS']);
  });

  test('due again on a revision, since revisions move the score too', () => {
    assert.equal(macroRecordDue(true, [{ seriesId: 'PAYEMS', inserted: 0, revised: 2 }], scored).due, true);
  });

  // MICH and the financial series are carried for context and are deliberately
  // not inputs to the composite, so they must not trigger a re-record.
  test('an unscored series changing does not re-record', () => {
    const r = macroRecordDue(true, [{ seriesId: 'MICH', inserted: 1, revised: 0 }], scored);
    assert.equal(r.due, false);
    assert.deepEqual(r.changed, []);
  });

  test('survives an ingest that returned no results at all', () => {
    assert.equal(macroRecordDue(true, [], scored).due, false);
    assert.equal(macroRecordDue(false, [], scored).due, true);
    assert.equal(macroRecordDue(true, null, scored).due, false);
  });
});
