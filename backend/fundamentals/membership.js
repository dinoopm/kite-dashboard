// ─── Who was in the index, on the day we looked ──────────────────────────────
//
// Every historical quarter this app aggregates is computed over TODAY's
// constituents. That flatters it: names dropped from an index never appear, and
// the survivors are the ones that did well. It cannot be undone backwards — NSE
// does not publish clean historical membership — but it can be stopped from
// growing, which is what this does.
//
// The same move as signal_emissions: start recording before anything reads it,
// because a day not recorded is a day gone.

require('dotenv').config({ path: __dirname + '/../../.env' });
const { createClient } = require('@supabase/supabase-js');

const supabase = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const today = () => new Date().toISOString().slice(0, 10);

async function snapshotIndia(snapDate = today()) {
  const db = supabase();
  const { data, error } = await db.from('sector_constituents').select('sector_key,symbol,name');
  if (error) throw new Error(`sector_constituents: ${error.message}`);
  const rows = (data || []).map(r => ({
    market: 'IN', index_key: r.sector_key, snap_date: snapDate,
    symbol: r.symbol, name: r.name ?? null,
  }));
  return upsert(rows);
}

async function snapshotUS(snapDate = today()) {
  const { getSP500, getNasdaq100 } = require('../usUniverses');
  const [spx, ndx] = await Promise.all([getSP500(), getNasdaq100()]);
  const rows = [
    ...spx.map(r => ({ market: 'US', index_key: 'SP500', snap_date: snapDate, symbol: r.symbol, name: r.name ?? null })),
    ...ndx.map(r => ({ market: 'US', index_key: 'NASDAQ100', snap_date: snapDate, symbol: r.symbol, name: r.name ?? null })),
  ];
  return upsert(rows);
}

async function upsert(rows) {
  if (!rows.length) return 0;
  const db = supabase();
  const CHUNK = 500;
  let saved = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from('index_membership_snapshots')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'market,index_key,snap_date,symbol' });
    if (error) throw new Error(`index_membership_snapshots: ${error.message}`);
    saved += Math.min(CHUNK, rows.length - i);
  }
  return saved;
}

async function snapshotAll(snapDate = today()) {
  const results = {};
  for (const [market, fn] of [['IN', snapshotIndia], ['US', snapshotUS]]) {
    try { results[market] = { saved: await fn(snapDate) }; }
    catch (err) { results[market] = { error: err.message }; }
  }
  return { snapDate, ...results };
}

module.exports = { snapshotAll, snapshotIndia, snapshotUS };
