const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { runBackup, backupDue, readManifest, privateRoot, TABLES, PRIVATE } = require('./backup');
const { verifyAll, restorePlan, compare } = require('./verify');

// A fake database: one personal table and one public table.
const db = {
  trade_log: [
    { trade_id: 't1', symbol: 'INFY', qty: 1, created_at: '2026-11-17T10:00:00Z' },
    { trade_id: 't2', symbol: 'TCS', qty: 2, created_at: '2026-11-18T10:00:00Z' },
  ],
  fii_dii_activity: [{ id: 1, trade_date: '2026-11-18', fii_net: 10, created_at: '2026-11-18T21:00:00Z' }],
};
const fetchRows = async (spec, { since }) => (db[spec.table] || []).filter(r => !since || r.created_at > since);
const dbKeys = async (spec) => (db[spec.table] || []).map(r => Object.fromEntries([...spec.key, 'created_at'].map(k => [k, r[k]])));

// trade_log is personal, so it is copied by the account's own session into its
// own folder; fii_dii_activity is public and copied by the gateway.
const MINE = privateRoot(7);
const pub = { scope: 'public', only: ['fii_dii_activity'] };
const mine = { scope: 'private', root: MINE, only: ['trade_log'] };

describe('runBackup + verify', () => {
  test('each scope copies only its own tables, into its own folder', async () => {
    const r = await runBackup({ fetchRows, now: new Date('2026-11-18T23:30:00Z'), scope: 'public' });
    const m = readManifest();
    assert.ok(m.tables.fii_dii_activity);
    assert.equal(m.tables.trade_log, undefined, 'a personal table never lands in the public backup');
    assert.equal(r.failed.length, 0);
    await runBackup({ fetchRows, now: new Date('2026-11-18T23:30:00Z'), ...mine });
    assert.equal(readManifest(MINE).tables.trade_log.parts[0].rows, 2);
    assert.match(MINE, /backups?-[^/]+\/users\/7$|\/users\/7$/);
  });

  test('a later run copies only rows created since, and every row reads back', async () => {
    db.trade_log.push({ trade_id: 't3', symbol: 'HDFC', qty: 3, created_at: '2026-11-19T10:00:00Z' });
    await runBackup({ fetchRows, now: new Date('2026-11-19T23:30:00Z'), ...mine });
    const m = readManifest(MINE);
    assert.equal(m.tables.trade_log.parts.length, 2);
    assert.equal(m.tables.trade_log.parts[1].rows, 1, 'second run copies only the new trade');
    assert.equal(m.tables.trade_log.cursor, '2026-11-19T10:00:00Z');
    const v = await verifyAll({ dbKeys, ...mine });
    assert.equal(v.ok, true, JSON.stringify(v.tables));
    assert.equal(v.tables[0].onDisk, 3);
    assert.equal((await verifyAll({ dbKeys, ...pub })).ok, true);
  });

  test('a row in the database but not on disk is reported as missing', async () => {
    db.trade_log.push({ trade_id: 't0', symbol: 'ITC', qty: 9, created_at: '2026-11-16T09:00:00Z' }); // older than the cursor, never copied
    const v = await verifyAll({ dbKeys, ...mine });
    assert.deepEqual([v.ok, v.tables[0].missing], [false, 1]);
    db.trade_log.pop();
  });

  test('a tampered file fails its checksum', async () => {
    const f = path.join(MINE, readManifest(MINE).tables.trade_log.parts[0].file);
    const saved = fs.readFileSync(f);
    fs.writeFileSync(f, Buffer.concat([saved, Buffer.from('x')]));
    assert.match((await verifyAll({ dbKeys, ...mine })).tables[0].error, /checksum mismatch/);
    fs.writeFileSync(f, saved);
  });

  // The dry run of a restore: what would be inserted if the live table lost rows.
  test('restorePlan lists exactly the backed-up rows the live table no longer has', async () => {
    const lost = db.trade_log.splice(1, 1)[0];
    const p = await restorePlan('trade_log', { dbKeys, root: MINE });
    assert.deepEqual([p.wouldInsert, p.rows[0].trade_id], [1, lost.trade_id]);
    db.trade_log.splice(1, 0, lost);
  });

  test('a table that fails to copy is reported, and does not stop the others', async () => {
    const r = await runBackup({
      fetchRows: async (spec) => { if (spec.table === 'participant_oi') throw new Error('relation does not exist'); return fetchRows(spec, {}); },
      now: new Date('2026-11-20T23:30:00Z'), scope: 'public', only: ['participant_oi', 'fii_dii_activity'],
    });
    assert.deepEqual(r.failed.map(f => [f.table, f.error]), [['participant_oi', 'relation does not exist']]);
    assert.deepEqual(readManifest().lastFailed, ['participant_oi']);
    assert.ok(readManifest().tables.fii_dii_activity.parts.length >= 2);
  });
});

test('compare: a full copy is judged only against rows that existed when it was taken', () => {
  const spec = { mode: 'full', key: ['id'] };
  const entry = { parts: [{ at: '2026-11-18T2330Z', takenAt: '2026-11-18T23:30:00.000Z' }] };
  const r = compare(spec, entry, new Map([['1', {}]]), [{ id: 1, created_at: '2026-11-18T21:00:00Z' }, { id: 2, created_at: '2026-11-19T08:00:00Z' }]);
  assert.deepEqual([r.ok, r.inDb, r.missing], [true, 1, 0]);
});

test('backupDue: once a UTC day after 23:00, or catching up a missed day', () => {
  assert.equal(backupDue(new Date('2026-11-19T22:00:00Z'), { lastRunDate: '2026-11-18' }), false);
  assert.equal(backupDue(new Date('2026-11-19T23:10:00Z'), { lastRunDate: '2026-11-18' }), true);
  assert.equal(backupDue(new Date('2026-11-19T23:40:00Z'), { lastRunDate: '2026-11-19' }), false);
  assert.equal(backupDue(new Date('2026-11-19T08:00:00Z'), { lastRunDate: '2026-11-17' }), true);
  assert.equal(backupDue(new Date('2026-11-19T08:00:00Z'), {}), true);
});

test('every table has a key; the irreplaceable ones are included; bhavcopy is not', () => {
  for (const t of TABLES) assert.ok(t.key?.length, t.name);
  for (const must of ['trade_log', 'fii_dii_activity', 'stock_pick_snapshots', 'signal_emissions.recorded']) assert.ok(TABLES.some(t => t.name === must), must);
  assert.ok(!TABLES.some(t => t.table === 'nse_bhavcopy'), 'bhavcopy is re-downloadable and deliberately excluded');
});

// The database layer decides which tables need a signed-in account. If the two
// lists drift, a personal table would be tried from the gateway and fail every
// night, or a public one would only ever be copied by signed-in sessions.
test('the private list matches the database layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'auth', 'database.js'), 'utf8');
  const block = src.slice(src.indexOf('PRIVATE_TABLES = new Set(['), src.indexOf(']);', src.indexOf('PRIVATE_TABLES = new Set([')));
  const names = [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual([...PRIVATE].sort(), names);
});

test('compare: rows on disk checked against no database rows is a failure, not a pass', () => {
  const r = compare({ mode: 'full', key: ['id'] }, { parts: [{ takenAt: '2026-11-18T23:30:00.000Z' }] }, new Map([['1', {}]]), []);
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing in the database to compare/);
});
