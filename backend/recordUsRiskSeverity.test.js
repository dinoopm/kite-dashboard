const { test } = require('node:test');
const assert = require('node:assert/strict');
// No network calls: all persistence operations use this in-memory builder.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { recordUsRiskSeverity, recordUsRiskFlags } = require('./signals/record');
function database() {
  const rows = [];
  const db = { from: () => {
    const filters = [];
    const query = { select: () => query, eq: (key, value) => { filters.push([key, value]); return query; }, order: () => query,
      limit: async () => ({ data: rows.filter(r => filters.every(([k, v]) => (k.startsWith('meta->>') ? r.meta?.[k.slice(7)] : r[k]) === v)).slice(-1).reverse(), error: null }),
      upsert: added => ({ select: async () => { const fresh = added.filter(row => !rows.some(r => r.signal === row.signal && r.symbol === row.symbol && r.snap_date === row.snap_date)); rows.push(...fresh); return { data: fresh, error: null }; } }),
    }; return query;
  } };
  return { db, rows };
}
test('severity emissions retain capture time and exact inputs; repeated state is not another firing', async () => {
  const { db, rows } = database();
  const snapshot = { state: 'CAUTION', ruleVersion: 'test-v1', asOf: '2026-10-23', metrics: { vix: 19.45 }, inputs: { spyClose: 760 }, rules: { rotationSessions: 21 } };
  const now = () => new Date('2026-10-27T01:00:00Z');
  assert.equal((await recordUsRiskSeverity(snapshot, { db, now })).saved, 1);
  assert.equal(rows[0].snap_date, '2026-10-27'); assert.equal(rows[0].source, 'recorded');
  assert.equal(rows[0].meta.asOf, '2026-10-23'); assert.equal(rows[0].meta.inputs.availableAt, now().toISOString());
  snapshot.metrics.vix = 99; assert.equal(rows[0].meta.inputs.metrics.vix, 19.45);
  assert.equal((await recordUsRiskSeverity(snapshot, { db, now })).skipped, 'same tier; no transition');
  assert.equal(rows.length, 1);
});
test('incomplete assessments are not persisted as neutral, and transitions are saved on later dates', async () => {
  const { db, rows } = database();
  assert.equal((await recordUsRiskSeverity({ state: 'INCOMPLETE' }, { db })).skipped, 'incomplete inputs');
  const base = { state: 'CAUTION', ruleVersion: 'test-v1', asOf: '2026-10-23', metrics: {}, inputs: {}, rules: {} };
  await recordUsRiskSeverity(base, { db, now: () => new Date('2026-10-27T01:00:00Z') });
  await recordUsRiskSeverity({ ...base, state: 'STRESS', asOf: '2026-10-27' }, { db, now: () => new Date('2026-10-28T01:00:00Z') });
  assert.equal(rows.length, 2); assert.equal(rows[1].meta.priorTier, 'CAUTION');
});

test('independent flags record trigger/clear transitions with snapshots, never unknown or initial false', async () => {
  const { db, rows } = database();
  const base = { state: 'NEUTRAL', ruleVersion: 'flags-v1', asOf: '2026-10-23', metrics: { creditChange21: 25 }, rules: {}, vintages: [{ source: 'unit' }], flags: [{ id: 'divergence', signal: 'us_credit_divergence', triggered: false, checks: [] }, { id: 'ccc', signal: 'us_ccc_leadership', triggered: null }] };
  const opts = { db, now: () => new Date('2026-10-27T01:00:00Z') };
  assert.equal((await recordUsRiskFlags(base, opts)).saved, 0);
  base.flags[0].triggered = true;
  assert.equal((await recordUsRiskFlags(base, opts)).saved, 1);
  assert.equal((await recordUsRiskFlags(base, opts)).saved, 0);
  assert.equal(rows[0].meta.signal, 'us_credit_divergence'); assert.equal(rows[0].meta.inputs.vintages[0].source, 'unit');
  assert.equal(rows[0].snap_date, '2026-10-27'); assert.equal(rows[0].meta.asOf, '2026-10-23');
  base.flags[0].triggered = false;
  assert.equal((await recordUsRiskFlags({ ...base, asOf: '2026-10-22' }, opts)).saved, 0);
  assert.equal((await recordUsRiskFlags(base, opts)).saved, 1);
  assert.equal(rows[1].meta.event, 'cleared'); assert.equal(rows[1].meta.signal, rows[0].meta.signal);
  assert.equal((await recordUsRiskFlags(base, opts)).saved, 0);
  assert.equal((await recordUsRiskFlags({ ...base, state: 'INCOMPLETE' }, opts)).saved, 0);
});
