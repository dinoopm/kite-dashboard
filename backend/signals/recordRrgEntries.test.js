const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { recordRrgEntries } = require('./record');

function database() {
  const rows = [];
  const db = { from: () => ({ upsert: added => ({ select: async () => {
    const fresh = added.filter(row => !rows.some(r => r.signal === row.signal && r.symbol === row.symbol && r.snap_date === row.snap_date));
    rows.push(...fresh); return { data: fresh, error: null };
  } }) }) };
  return { db, rows };
}
const week = '2026-11-13';
const entries = [
  { symbol: 'XLE', date: week, from: 'Improving', to: 'Leading', rsRatio: 100.4, rsMomentum: 101.2, prev: { date: '2026-11-06', rsRatio: 99.8, rsMomentum: 101 } },
  { symbol: 'SMH', date: week, from: 'Weakening', to: 'Lagging', rsRatio: 99.1, rsMomentum: 92 },
];
const opts = (db, at) => ({ week, ruleVersion: 'rrg-test', deadline: '2026-11-16T13:30:00.000Z', db, now: () => new Date(at) });

test('writes one row per entry, keyed on the week, and a re-run changes nothing', async () => {
  const { db, rows } = database();
  assert.equal((await recordRrgEntries(entries, opts(db, '2026-11-14T02:00:00Z'))).saved, 2);
  assert.equal((await recordRrgEntries(entries, opts(db, '2026-11-15T02:00:00Z'))).saved, 0);
  assert.deepEqual(rows.map(r => [r.signal, r.symbol, r.snap_date, r.source]), [
    ['us_rrg_enter_leading@rrg-test', 'XLE', week, 'recorded'],
    ['us_rrg_enter_lagging@rrg-test', 'SMH', week, 'recorded'],
  ]);
  assert.equal(rows[0].meta.capturedAt, '2026-11-14T02:00:00.000Z');
  assert.equal(rows[0].meta.inputs.previousWeek.rsRatio, 99.8);
});

// Past the next open the week has started to resolve; a row written then would
// be called recorded while knowing part of its own answer.
test('writes nothing once the next week has opened', async () => {
  const { db, rows } = database();
  const r = await recordRrgEntries(entries, opts(db, '2026-11-16T14:00:00Z'));
  assert.equal(r.saved, 0);
  assert.match(r.skipped, /left to the reconstruction/);
  assert.equal(rows.length, 0);
});

test('ignores entries from any other week, and an empty week is not an error', async () => {
  const { db, rows } = database();
  const r = await recordRrgEntries([{ ...entries[0], date: '2026-11-06' }], opts(db, '2026-11-14T02:00:00Z'));
  assert.deepEqual([r.saved, r.entries], [0, 0]);
  assert.equal(rows.length, 0);
});
