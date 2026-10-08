const test = require('node:test');
const assert = require('node:assert/strict');
const { scopeDatabase, PRIVATE_TABLES } = require('./database');
function fixture(identity = () => ({ appUserId: 'owner-a', kiteUserId: 'GEK191' })) {
  const calls = [];
  const raw = { from: table => new Proxy({}, { get: (_, op) => (...args) => { calls.push([table, op, ...args]); return raw.from(table); } }) };
  return { calls, db: scopeDatabase(raw, identity) };
}

test('every private table is filtered for reads, updates, deletes, counts and aggregate chains', () => {
  for (const table of PRIVATE_TABLES) {
    const { calls, db } = fixture();
    db.from(table).select('*', { count: 'exact', head: true }).eq('id', 'guessed-id').or('name.eq.test');
    db.from(table).update({ name: 'Changed', user_id: 'owner-b' }).eq('id', 'guessed-id');
    db.from(table).delete().eq('id', 'guessed-id');
    assert.equal(calls.filter(row => row[1] === 'eq' && row[2] === 'user_id' && row[3] === 'owner-a').length, 3, table);
    assert.deepEqual(calls.find(row => row[1] === 'update')[2], { name: 'Changed' });
  }
});
test('inserts override supplied ownership and upserts target per-owner conflicts', () => {
  const { calls, db } = fixture();
  db.from('trade_log').upsert([{ trade_id: 't', user_id: 'owner-b' }], { onConflict: 'trade_id', ignoreDuplicates: true });
  assert.deepEqual(calls[0], ['trade_log', 'upsert', [{ trade_id: 't', user_id: 'owner-a' }], { onConflict: 'user_id,trade_id', ignoreDuplicates: true }]);
  db.from('portfolios').upsert({ id: 'other-id', name: 'Cannot claim this' });
  assert.equal(calls[1][3].onConflict, 'user_id,id');
  db.from('instrument_notes').upsert({ symbol: 'TEST', note: 'Note' });
  assert.equal(calls[2][3].onConflict, 'user_id,symbol');
  db.from('themes').insert({ name: 'Basket' });
  assert.equal(calls[3][2].user_id, 'owner-a');
});
test('unverified workers cannot access private tables; public data excludes legacy account inputs', () => {
  const { db, calls } = fixture(() => null);
  for (const table of PRIVATE_TABLES) for (const op of ['select', 'insert', 'update', 'delete', 'upsert']) assert.throws(() => db.from(table)[op]({}), { statusCode: 401 });
  db.from('nse_bhavcopy').select('*');
  assert.deepEqual(calls, [['nse_bhavcopy', 'select', '*']]);
  db.from('signal_emissions').select('*');
  assert.deepEqual(calls.at(-1), ['signal_emissions', 'not', 'signal', 'like', 'technical_alert/%']);
  assert.throws(() => db.from('signal_emissions').upsert({ signal: 'technical_alert/buy' }), /must use user_signal_emissions/);
});
