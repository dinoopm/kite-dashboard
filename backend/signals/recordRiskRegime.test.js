const { test } = require('node:test');
const assert = require('node:assert/strict');
// No network: persistence goes to an in-memory stand-in for signal_emissions.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { recordRiskRegime } = require('./record');

function database() {
  const rows = [];
  const db = { from: () => {
    const filters = [];
    const query = {
      select: () => query, eq: (k, v) => { filters.push([k, v]); return query; }, order: () => query,
      limit: async () => ({ data: rows.filter(r => filters.every(([k, v]) => r[k] === v)).sort((a, b) => b.snap_date.localeCompare(a.snap_date)).slice(0, 1), error: null }),
      upsert: added => ({ select: async () => {
        const fresh = added.filter(row => !rows.some(r => r.signal === row.signal && r.symbol === row.symbol && r.snap_date === row.snap_date));
        rows.push(...fresh); return { data: fresh, error: null };
      } }),
    };
    return query;
  } };
  return { db, rows };
}

const read = (label, sessionDate, extra = {}) => ({
  verdict: { label }, score: label === 'RISK-OFF' ? -2 : 0, sessionDate, sessionComplete: true, ruleVersion: 'risk-regime-test',
  gauges: [{ id: 'yield', raw: -0.09, score: -1 }], yield: { now: 5.1 }, rules: { windowSessions: 21 }, source: 'test', ...extra,
});
const now = () => new Date('2026-11-13T22:10:00Z');

test('records the first verdict, then only changes', async () => {
  const { db, rows } = database();
  assert.equal((await recordRiskRegime(read('RISK-OFF', '2026-11-12'), { db, now })).saved, 1);
  assert.equal((await recordRiskRegime(read('RISK-OFF', '2026-11-12'), { db, now })).skipped, 'same verdict; no transition');
  const r = await recordRiskRegime(read('NEUTRAL', '2026-11-13'), { db, now });
  assert.equal(r.saved, 1);
  assert.equal(r.priorVerdict, 'RISK-OFF');
  assert.equal(rows.length, 2);
  const last = rows.at(-1);
  assert.equal(last.signal, 'risk_regime@risk-regime-test');
  assert.equal(last.snap_date, '2026-11-13');
  assert.equal(last.source, 'recorded');
  assert.equal(last.meta.verdict, 'NEUTRAL');
  assert.equal(last.meta.capturedAt, now().toISOString());
  assert.equal(last.meta.inputs.gauges[0].raw, -0.09);
});

// A mid-session read is not the session's verdict.
test('refuses a read of a session still trading', async () => {
  const { db, rows } = database();
  const r = await recordRiskRegime(read('RISK-ON', '2026-11-13', { sessionComplete: false }), { db, now });
  assert.equal(r.skipped, 'session not settled');
  assert.equal(rows.length, 0);
});

test('never writes an older session over a newer one', async () => {
  const { db, rows } = database();
  await recordRiskRegime(read('NEUTRAL', '2026-11-13'), { db, now });
  assert.equal((await recordRiskRegime(read('RISK-OFF', '2026-11-12'), { db, now })).skipped, 'older session');
  assert.equal(rows.length, 1);
});
