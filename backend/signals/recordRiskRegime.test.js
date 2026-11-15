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

// `live` is today's live word; the recorder must ignore it and write `settled`.
const read = (label, date, { live = label, ...extra } = {}) => ({
  verdict: { label: live }, ruleVersion: 'risk-regime-test', rules: { windowSessions: 21 },
  settled: { date, label, score: label === 'RISK-OFF' ? -2 : 0, scores: { yield: -1, stocksBonds: -1, credit: 0 }, yield: 5.1, yield1mo: -0.09, spyTlt1mo: -2.7, hygLqd1mo: -0.2 },
  ...extra,
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
  assert.equal(last.meta.inputs.readings.yield1mo, -0.09);
  assert.match(last.meta.inputs.source, /daily closes/);
});

// The live word takes the 10Y from a live quote, so it depends on the hour the
// job runs — overnight in Asia it can differ from what the session closed at.
test('records the settled session, never the live word', async () => {
  const { db, rows } = database();
  await recordRiskRegime(read('NEUTRAL', '2026-11-13', { live: 'RISK-ON' }), { db, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.verdict, 'NEUTRAL');
  // The same session read again hours later, with the live word now different, changes nothing.
  const again = await recordRiskRegime(read('NEUTRAL', '2026-11-13', { live: 'RISK-OFF' }), { db, now: () => new Date('2026-11-14T01:00:00Z') });
  assert.equal(again.skipped, 'same verdict; no transition');
  assert.equal(rows.length, 1);
});

test('writes nothing when no session has settled', async () => {
  const { db, rows } = database();
  const r = await recordRiskRegime({ verdict: { label: 'RISK-ON' }, ruleVersion: 'risk-regime-test', settled: null }, { db, now });
  assert.equal(r.skipped, 'no settled session');
  assert.equal(rows.length, 0);
});

test('never writes an older session over a newer one', async () => {
  const { db, rows } = database();
  await recordRiskRegime(read('NEUTRAL', '2026-11-13'), { db, now });
  assert.equal((await recordRiskRegime(read('RISK-OFF', '2026-11-12'), { db, now })).skipped, 'older session');
  assert.equal(rows.length, 1);
});
