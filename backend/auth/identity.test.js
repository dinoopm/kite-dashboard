const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityManager, profileIdentity } = require('./identity');
const profile = id => ({ content: [{ text: JSON.stringify({ data: { user_id: id } }) }] });
function database(existing = null) {
  const rows = new Map(existing ? [[existing.kite_user_id, existing]] : []);
  const calls = [];
  return { rows, calls, from(table) {
    assert.equal(table, 'app_users');
    return {
      select() { return { eq(column, value) {
        assert.equal(column, 'kite_user_id'); calls.push(value);
        return { maybeSingle: async () => ({ data: rows.get(value) || null }), single: async () => ({ data: rows.get(value) || null }) };
      } }; },
      async upsert(row) { rows.set(row.kite_user_id, { id: `uuid-${row.kite_user_id}`, ...row }); return {}; },
    };
  } };
}

test('only a valid authenticated broker profile is accepted', () => {
  assert.equal(profileIdentity(profile(' GEK191 ')), 'GEK191');
  for (const invalid of [null, {}, { isError: true, ...profile('GEK191') }, { content: [{ text: 'not JSON' }] }, profile('bad-user!'), profile(null)]) assert.equal(profileIdentity(invalid), null);
});
test('existing identity is reused and a new Kite user receives a new app identity', async () => {
  const db = database({ id: 'legacy-uuid', kite_user_id: 'GEK191' });
  const old = createIdentityManager();
  assert.deepEqual(await old.bindKiteIdentity(db, profile('GEK191')), { appUserId: 'legacy-uuid', kiteUserId: 'GEK191' });
  const fresh = createIdentityManager();
  assert.deepEqual(await fresh.bindKiteIdentity(db, profile('ABC123')), { appUserId: 'uuid-ABC123', kiteUserId: 'ABC123' });
  assert.equal(db.rows.size, 2);
  await old.bindKiteIdentity(db, profile('GEK191'));
  await assert.rejects(old.bindKiteIdentity(db, profile('ABC123')), { statusCode: 401 });
  assert.equal(old.getIdentity(), null);
  await assert.rejects(old.bindKiteIdentity(db, profile('GEK191')), { statusCode: 401 });
});
test('unavailable schema and expired broker profiles fail closed', async () => {
  const manager = createIdentityManager();
  await assert.rejects(manager.bindKiteIdentity(null, profile('GEK191')), { statusCode: 503 });
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ error: { message: 'missing table' } }) }) }) }) };
  await assert.rejects(manager.bindKiteIdentity(db, profile('GEK191')), /migration is required/);
  assert.equal(manager.getIdentity(), null);
  manager.setIdentity({ appUserId: 'uuid', kiteUserId: 'GEK191' });
  await assert.rejects(manager.bindKiteIdentity(db, { isError: true }), { statusCode: 401 });
  assert.equal(manager.getIdentity(), null);
});
