const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(path.join(__dirname, '../migrate_kite_users.sql'), 'utf8');
const ddlFiles = ['portfolios', 'themes', 'screens', 'us_tables', 'notes', 'backtests',
  'trade_log', 'user_events', 'holding_snapshots', 'stop_proposals', 'signal_emissions'];
const ownedTables = ['portfolios', 'portfolio_holdings', 'themes', 'theme_instruments',
  'saved_screens', 'us_baskets', 'us_virtual_portfolios', 'us_screens', 'instrument_notes',
  'backtest_runs', 'trade_log', 'user_events', 'holding_state_snapshots', 'stop_proposals'];
const portfolio = '11111111-1111-4111-8111-111111111111';
const theme = '22222222-2222-4222-8222-222222222222';
const screen = '33333333-3333-4333-8333-333333333333';

async function fixture(t, { optional = true } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE readonly_user; CREATE ROLE service_role BYPASSRLS;');
  for (const name of ddlFiles) {
    if (!optional && !['portfolios', 'themes', 'screens', 'us_tables'].includes(name)) continue;
    // Read only the DDL expression from the existing schema sources. Never run
    // their main functions: tests cannot access dotenv, Supabase or the broker.
    const source = fs.readFileSync(path.join(__dirname, `../migrate_${name}.js`), 'utf8');
    const expression = source.match(/const DDL = ([\s\S]*?);\s*\nasync function main/)[1];
    await db.exec(vm.runInNewContext(expression, {}, { timeout: 1000 }));
  }
  await db.exec(`
    INSERT INTO portfolios(id,name) VALUES('${portfolio}','Legacy portfolio');
    INSERT INTO portfolio_holdings(portfolio_id,symbol,quantity,avg_cost) VALUES('${portfolio}','TEST',7,123.45);
    INSERT INTO themes(id,name) VALUES('${theme}','Legacy basket');
    INSERT INTO theme_instruments(theme_id,symbol) VALUES('${theme}','TEST');
    INSERT INTO saved_screens(id,name,rules,universe) VALUES('${screen}','Legacy screen','{"conditions":[{"field":"rsi","op":">","value":50}]}','{"type":"theme","themeId":"${theme}"}');
    INSERT INTO us_baskets(name,symbols) VALUES('US basket','["TEST"]');
    INSERT INTO us_virtual_portfolios(name,holdings) VALUES('US portfolio','[{"symbol":"TEST","quantity":3,"avgCost":50}]');
    INSERT INTO us_screens(name,scope,conditions) VALUES('US screen','{"type":"basket"}','[{"field":"rsi","op":">","value":50}]');
  `);
  if (optional) await db.exec(`
    INSERT INTO instrument_notes(symbol,note) VALUES('TEST','Keep this note');
    INSERT INTO trade_log(trade_id,symbol,side,qty,price,trade_ts) VALUES('trade-1','TEST','BUY',7,123.45,'2026-10-01T10:00:00Z');
    INSERT INTO user_events(symbol,event_date,title) VALUES('TEST','2026-10-09','Saved event');
    INSERT INTO holding_state_snapshots(snap_date,symbol,score) VALUES('2026-10-01','TEST',75);
    INSERT INTO stop_proposals(proposed_on,symbol,quantity,rule) VALUES('2026-10-01','TEST',7,'test-rule');
    INSERT INTO backtest_runs(kind,label,strategy_id,params,metrics,result) VALUES('single','Saved run','test-rule','{}','{}','{"trades":[1]}');
    INSERT INTO signal_emissions(signal,snap_date,symbol,source,meta) VALUES
      ('technical_alert/buy','2026-10-01','TEST','recorded','{"quantity":7,"ruleVersion":"test-v1"}'),
      ('market/breakout','2026-10-01','TEST','recorded','{"price":123.45}');
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated, readonly_user;
    ALTER TABLE signal_emissions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY public_market_read ON signal_emissions FOR SELECT USING(true);
  `);
  return db;
}
async function snapshot(db, tables) {
  const data = {};
  for (const table of tables) data[table] = (await db.query(`SELECT to_jsonb(t)-'user_id' AS payload FROM ${table} t ORDER BY (to_jsonb(t)-'user_id')::text`)).rows;
  return data;
}
async function ownerId(db, kiteId = 'GEK191') {
  return (await db.query('SELECT id FROM app_users WHERE kite_user_id=$1', [kiteId])).rows[0].id;
}

test('ownership migration preserves existing IDs, payloads and signal evidence; rerunning is safe', async t => {
  const db = await fixture(t);
  const before = await snapshot(db, [...ownedTables, 'signal_emissions']);
  await db.exec(migration);
  assert.deepEqual(await snapshot(db, [...ownedTables, 'signal_emissions']), before);
  const legacyOwner = await ownerId(db);
  for (const table of ownedTables) {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id IS DISTINCT FROM $1`, [legacyOwner])).rows[0].n, 0, table);
  }
  const copied = (await db.query('SELECT signal,meta,user_id FROM user_signal_emissions')).rows;
  assert.equal(copied.length, 1);
  assert.equal(copied[0].user_id, legacyOwner);
  assert.deepEqual(copied[0].meta, { quantity: 7, ruleVersion: 'test-v1' });
  await db.exec("INSERT INTO app_users(kite_user_id) VALUES('ABC123');");
  const otherOwner = await ownerId(db, 'ABC123');
  for (const table of ownedTables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [otherOwner])).rows[0].n, 0);
  await db.query("INSERT INTO portfolios(user_id,name) VALUES($1,'Other account')", [otherOwner]);
  await db.exec(migration);
  assert.equal(await ownerId(db), legacyOwner);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM user_signal_emissions')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM portfolios WHERE user_id=$1', [otherOwner])).rows[0].n, 1);
});

test('owners can save identical natural keys; cross-owner children and missing owners are rejected', async t => {
  const db = await fixture(t);
  await db.exec(migration);
  await db.exec("INSERT INTO app_users(kite_user_id) VALUES('ABC123');");
  const other = await ownerId(db, 'ABC123');
  await db.query("INSERT INTO instrument_notes(user_id,symbol,note) VALUES($1,'TEST','Private note') ON CONFLICT(user_id,symbol) DO UPDATE SET note=excluded.note", [other]);
  await db.query("INSERT INTO holding_state_snapshots(user_id,snap_date,symbol,score) VALUES($1,'2026-10-01','TEST',20)", [other]);
  await db.query("INSERT INTO trade_log(user_id,trade_id,symbol,side,qty,price,trade_ts) VALUES($1,'trade-1','TEST','BUY',1,10,'2026-10-01T10:00:00Z')", [other]);
  await db.query("INSERT INTO stop_proposals(user_id,proposed_on,symbol,quantity,rule) VALUES($1,'2026-10-01','TEST',1,'other')", [other]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM instrument_notes WHERE symbol='TEST'")).rows[0].n, 2);
  await assert.rejects(db.query("INSERT INTO portfolio_holdings(user_id,portfolio_id,symbol) VALUES($1,$2,'OTHER')", [other, portfolio]), /foreign key/);
  await assert.rejects(db.query("INSERT INTO theme_instruments(user_id,theme_id,symbol) VALUES($1,$2,'OTHER')", [other, theme]), /foreign key/);
  await assert.rejects(db.query("UPDATE portfolios SET user_id=$1 WHERE id=$2", [other, portfolio]), /foreign key/);
  await assert.rejects(db.exec("INSERT INTO portfolios(name) VALUES('Unowned')"), /not-null/);
  await assert.rejects(db.query("INSERT INTO portfolios(id,user_id,name) VALUES($1,$2,'Cannot take ownership') ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name", [portfolio, other]), /duplicate key/);
});

test('anonymous, Supabase-authenticated and readonly roles cannot access private data', async t => {
  const db = await fixture(t);
  await db.exec(migration);
  await db.exec('SET ROLE service_role');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM portfolios')).rows[0].n, 1);
  await db.exec('RESET ROLE');
  for (const role of ['anon', 'authenticated', 'readonly_user']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      for (const table of [...ownedTables, 'app_users', 'user_signal_emissions']) {
        await assert.rejects(db.query(`SELECT * FROM ${table}`), /permission denied/, `${role}:${table}`);
      }
      assert.deepEqual((await db.query('SELECT signal FROM signal_emissions')).rows, [{ signal: 'market/breakout' }]);
    } finally { await db.exec('RESET ROLE'); }
  }
});

test('optional tables are skipped; missing required tables abort the entire migration', async t => {
  const db = await fixture(t, { optional: false });
  await db.exec(migration);
  assert.ok(await ownerId(db));
  await db.exec('DROP TABLE us_screens CASCADE');
  await assert.rejects(db.exec(migration), /Required workspace table us_screens is missing/);
  await db.exec('ROLLBACK');
  assert.ok(await ownerId(db));
  // On a fresh incompatible schema, even the seed identity must roll back.
  const empty = new PGlite();
  t.after(() => empty.close());
  await empty.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  await assert.rejects(empty.exec(migration), /Required workspace table portfolios is missing/);
  await empty.exec('ROLLBACK');
  assert.equal((await empty.query("SELECT to_regclass('public.app_users') AS t")).rows[0].t, null);
});
