const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { changedIndexKeys } = require('./membership');

const m = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)]));

describe('changedIndexKeys', () => {
  // The reason this exists: a daily write of both markets is ~940 rows a day
  // and 340,000 a year, to record perhaps twenty real changes. Membership as of
  // a date is "the latest snapshot at or before it", so an unchanged day adds
  // nothing an existing row does not already answer.
  test('an unchanged index is not rewritten', () => {
    const cur = m({ 'NIFTY BANK': ['HDFCBANK', 'ICICIBANK'] });
    const prev = m({ 'NIFTY BANK': ['ICICIBANK', 'HDFCBANK'] });   // order is irrelevant
    assert.deepEqual(changedIndexKeys(cur, prev), []);
  });

  test('an added constituent counts', () => {
    const cur = m({ X: ['A', 'B', 'C'] });
    assert.deepEqual(changedIndexKeys(cur, m({ X: ['A', 'B'] })), ['X']);
  });

  test('a removed constituent counts', () => {
    const cur = m({ X: ['A'] });
    assert.deepEqual(changedIndexKeys(cur, m({ X: ['A', 'B'] })), ['X']);
  });

  // Same size, different members — the case a naive length check waves through,
  // and the one that matters most: a swap IS the event being recorded.
  test('a one-for-one swap counts, though the count is unchanged', () => {
    const cur = m({ X: ['A', 'C'] });
    assert.deepEqual(changedIndexKeys(cur, m({ X: ['A', 'B'] })), ['X']);
  });

  test('an index never snapshotted before always writes', () => {
    assert.deepEqual(changedIndexKeys(m({ NEW: ['A'] }), new Map()), ['NEW']);
  });

  test('only the indexes that moved are returned, not all of them', () => {
    const cur = m({ SAME: ['A'], MOVED: ['A', 'B'] });
    const prev = m({ SAME: ['A'], MOVED: ['A'] });
    assert.deepEqual(changedIndexKeys(cur, prev), ['MOVED']);
  });
});
