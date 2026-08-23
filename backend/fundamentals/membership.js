// ─── Who was in the index, on the day we looked ──────────────────────────────
//
// Every historical quarter this app aggregates is computed over TODAY's
// constituents. That flatters it: names dropped from an index never appear, and
// the survivors are the ones that did well. It cannot be undone backwards — NSE
// does not publish clean historical membership — but it can be stopped from
// growing, which is what this does.
//
// WRITTEN ON CHANGE, NOT DAILY. A daily snapshot of both markets is ~940 rows a
// day, 340,000 a year, to record maybe twenty real constituent changes — and
// this repo has already been burned once by a job whose reads were sized
// without asking what they cost (see dailyJobs' note on the 29 MB bhavcopy
// scan). Membership as of any date is "the latest snapshot at or before that
// date", so skipping unchanged days loses nothing: the previous row still
// answers the question for every day until the next change.

require('dotenv').config({ path: __dirname + '/../../.env' });
const { createClient } = require('@supabase/supabase-js');

const supabase = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Which index keys actually moved since the last snapshot.
 *
 * Pure, so the comparison that decides whether to write anything is testable
 * without a database.
 *
 * @param current  Map(index_key -> Set(symbol)) as of now
 * @param previous Map(index_key -> Set(symbol)) from the newest stored snapshot
 */
function changedIndexKeys(current, previous) {
  const changed = [];
  for (const [key, symbols] of current) {
    const before = previous.get(key);
    // An index we have never snapshotted always counts as changed — otherwise a
    // newly added sector would never get a first row.
    if (!before) { changed.push(key); continue; }
    if (before.size !== symbols.size) { changed.push(key); continue; }
    for (const s of symbols) {
      if (!before.has(s)) { changed.push(key); break; }
    }
  }
  return changed;
}

/** The newest stored snapshot per index, as Map(index_key -> Set(symbol)). */
async function latestSnapshot(market) {
  const db = supabase();
  const { data: latest, error: dErr } = await db
    .from('index_membership_snapshots').select('snap_date')
    .eq('market', market).order('snap_date', { ascending: false }).limit(1);
  if (dErr) throw new Error(`index_membership_snapshots: ${dErr.message}`);
  const snapDate = latest?.[0]?.snap_date;
  if (!snapDate) return { snapDate: null, byIndex: new Map() };

  const { data, error } = await db
    .from('index_membership_snapshots').select('index_key,symbol')
    .eq('market', market).eq('snap_date', snapDate);
  if (error) throw new Error(`index_membership_snapshots: ${error.message}`);
  const byIndex = new Map();
  for (const r of data || []) {
    if (!byIndex.has(r.index_key)) byIndex.set(r.index_key, new Set());
    byIndex.get(r.index_key).add(r.symbol);
  }
  return { snapDate, byIndex };
}

async function currentIndia() {
  const { data, error } = await supabase()
    .from('sector_constituents').select('sector_key,symbol,name');
  if (error) throw new Error(`sector_constituents: ${error.message}`);
  const rows = new Map();
  for (const r of data || []) {
    if (!rows.has(r.sector_key)) rows.set(r.sector_key, []);
    rows.get(r.sector_key).push({ symbol: r.symbol, name: r.name ?? null });
  }
  return rows;
}

async function currentUS() {
  const { getSP500, getNasdaq100 } = require('../usUniverses');
  const [spx, ndx] = await Promise.all([getSP500(), getNasdaq100()]);
  return new Map([
    ['SP500', spx.map(r => ({ symbol: r.symbol, name: r.name ?? null }))],
    ['NASDAQ100', ndx.map(r => ({ symbol: r.symbol, name: r.name ?? null }))],
  ]);
}

async function snapshotMarket(market, snapDate = today()) {
  const current = market === 'IN' ? await currentIndia() : await currentUS();
  const asSets = new Map([...current].map(([k, v]) => [k, new Set(v.map(x => x.symbol))]));
  const { snapDate: lastDate, byIndex } = await latestSnapshot(market);
  const changed = changedIndexKeys(asSets, byIndex);

  if (!changed.length) {
    return { market, changed: 0, saved: 0, unchangedSince: lastDate };
  }

  const rows = [];
  for (const key of changed) {
    for (const c of current.get(key)) {
      rows.push({ market, index_key: key, snap_date: snapDate, symbol: c.symbol, name: c.name });
    }
  }
  const db = supabase();
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from('index_membership_snapshots')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'market,index_key,snap_date,symbol' });
    if (error) throw new Error(`index_membership_snapshots: ${error.message}`);
  }
  return { market, changed: changed.length, saved: rows.length, indexes: changed };
}

async function snapshotAll(snapDate = today()) {
  const results = { snapDate };
  for (const market of ['IN', 'US']) {
    try { results[market] = await snapshotMarket(market, snapDate); }
    catch (err) { results[market] = { error: err.message }; }
  }
  return results;
}

module.exports = { snapshotAll, snapshotMarket, changedIndexKeys, latestSnapshot };
