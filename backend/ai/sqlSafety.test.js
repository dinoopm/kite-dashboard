const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeSQL } = require('./sqlSafety');
const { PRIVATE_TABLES } = require('../auth/database');
test('SQL agent rejects all account tables, including quoted identifiers and CTEs', () => {
  for (const table of [...PRIVATE_TABLES, 'app_users', 'signal_emissions']) {
    for (const sql of [`SELECT * FROM public.${table}`, `WITH t AS (SELECT * FROM "${table}") SELECT * FROM t`]) assert.throws(() => assertSafeSQL(sql), /Personal workspace tables/);
  }
  assert.doesNotThrow(() => assertSafeSQL('SELECT symbol FROM nse_bhavcopy LIMIT 5'));
  assert.throws(() => assertSafeSQL('SELECT 1; SELECT 2'), /Multi-statement/);
  assert.throws(() => assertSafeSQL('WITH deleted AS (DELETE FROM nse_bhavcopy RETURNING *) SELECT * FROM deleted'), /forbidden/);
});
