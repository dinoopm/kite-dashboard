// ─── Macro ingestion ─────────────────────────────────────────────────────────
//
// Pulls the catalogue from FRED and writes it to macro_observations, keeping
// revisions instead of overwriting them.
//
// The rule that keeps the table honest AND small: a new vintage row is written
// only when the value actually CHANGED. Writing a vintage on every run would
// add a row per series per day forever and say nothing; writing none would
// destroy the revision history that makes reconstruction possible. Comparing
// against the latest stored vintage gives both — an unrevised daily oil series
// stays one row per date, and a payrolls benchmark revision leaves a permanent
// before-and-after pair.

// Loaded before the Supabase client is constructed below, and only when this
// file is the entry point — required from server.js the env is already set.
if (require.main === module) {
  const dotenv = require('dotenv');
  const pathMod = require('path');
  // Cover being run from backend/, from the repo root, and from a worktree.
  for (const p of [
    pathMod.resolve(__dirname, '../../.env'),
    pathMod.resolve(process.cwd(), '../.env'),
    pathMod.resolve(process.cwd(), '.env'),
  ]) dotenv.config({ path: p });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('[macro-ingest] SUPABASE_URL / SUPABASE_SERVICE_KEY not found in .env');
    process.exit(1);
  }
}

const { createClient } = require('@supabase/supabase-js');
const { SERIES } = require('./series');
const { fetchMany } = require('./fred');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const today = () => new Date().toISOString().slice(0, 10);

/** Keep the catalogue in the database in step with series.js. */
async function syncCatalogue() {
  const rows = SERIES.map(s => ({
    series_id: s.id,
    series_key: s.key,
    label: s.label,
    original_source: s.originalSource,
    frequency: s.frequency,
    unit: s.unit,
    transform: s.transform,
    release_lag_days: s.releaseLagDays ?? null,
    revision_risk: s.revisionRisk ?? null,
    scored: s.scored !== false,
    note: s.note ?? null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('macro_series').upsert(rows, { onConflict: 'series_id' });
  if (error) throw new Error(`macro_series: ${error.message}`);
  return rows.length;
}

/** Latest stored vintage per observation date for one series. */
async function latestStored(seriesId, since) {
  const { data, error } = await supabase
    .from('macro_observations_latest')
    .select('observation_date,value')
    .eq('series_id', seriesId)
    .gte('observation_date', since);
  if (error) throw new Error(`macro_observations_latest: ${error.message}`);
  return new Map((data || []).map(r => [String(r.observation_date).slice(0, 10), r.value == null ? null : Number(r.value)]));
}

/** Values differ enough to be a real revision, not float noise. */
function changed(a, b) {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > 1e-9;
}

/**
 * Fetch and store one series. Returns what it did, so a scheduled run can log
 * revisions — a silent revision is how a six-month-ago value moves under you.
 */
async function ingestSeries(seriesId, observations, { vintageDate = null } = {}) {
  if (!observations?.length) return { seriesId, inserted: 0, revised: 0, skipped: 0 };
  const since = observations[0].observation_date;
  const stored = await latestStored(seriesId, since);
  const fallback = vintageDate || today();

  const rows = [];
  let revised = 0;
  for (const o of observations) {
    const date = String(o.observation_date).slice(0, 10);
    const value = o.value == null ? null : Number(o.value);
    // With FRED_API_KEY the JSON API returns `realtime_start`: the date the
    // SOURCE published this value. Without a key the CSV carries no vintage
    // information at all, so the best available stamp is the day we first saw
    // the value — which is a weaker claim, and the UI says "first seen" rather
    // than "vintage" so the two are not confused.
    const vintage = o.realtime_start ? String(o.realtime_start).slice(0, 10) : fallback;
    if (!stored.has(date)) {
      rows.push({ series_id: seriesId, observation_date: date, vintage_date: vintage, value });
      continue;
    }
    if (changed(stored.get(date), value)) {
      rows.push({ series_id: seriesId, observation_date: date, vintage_date: vintage, value });
      revised++;
    }
  }

  if (rows.length) {
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await supabase.from('macro_observations')
        .upsert(rows.slice(i, i + BATCH), { onConflict: 'series_id,observation_date,vintage_date' });
      if (error) throw new Error(`macro_observations: ${error.message}`);
    }
  }

  return {
    seriesId,
    inserted: rows.length - revised,
    revised,
    skipped: observations.length - rows.length,
  };
}

/**
 * The scheduled job.
 *
 * `mode: 'recent'` pulls a rolling window — cheap, and enough for the panel,
 * which only ever looks back six months. `mode: 'backfill'` pulls from 2000 so
 * the regime study has something to measure. Recent runs still catch revisions
 * inside the window; the periodic backfill catches the annual benchmark
 * revisions that reach further back than that.
 */
async function runIngest({ mode = 'recent', asOf = null } = {}) {
  const start = mode === 'backfill'
    ? '2000-01-01'
    : (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 30); return d.toISOString().slice(0, 10); })();

  await syncCatalogue();
  const ids = SERIES.map(s => s.id);
  const { series, errors } = await fetchMany(ids, { start, asOf });

  const results = [];
  for (const id of ids) {
    const s = series[id];
    if (!s) continue;
    try {
      results.push(await ingestSeries(id, s.observations, { vintageDate: asOf }));
    } catch (e) {
      errors[id] = e.message;
    }
  }

  const revisedSeries = results.filter(r => r.revised > 0);
  if (revisedSeries.length) {
    console.log(`[macro-ingest] revisions: ${revisedSeries.map(r => `${r.seriesId}×${r.revised}`).join(', ')}`);
  }
  if (Object.keys(errors).length) {
    console.error(`[macro-ingest] failed: ${Object.entries(errors).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  }
  return { mode, start, results, errors, ranAt: new Date().toISOString() };
}

/**
 * Observations for the monitor: LATEST VINTAGE per observation date.
 *
 * The vintage policy, stated once so it is not inferred from behaviour:
 *
 *   The dashboard shows the LATEST vintage — the best current estimate of what
 *   happened — and recomputes when a revision is ingested. It does not freeze
 *   values at first print. A panel describing today's economy should use the
 *   data statisticians currently believe, not what they believed in February.
 *
 *   Prior vintages are never overwritten, so an as-of read is available for
 *   anything that must not use hindsight — the same query with
 *   `.lte('vintage_date', asOf)` before the distinct. That is what a
 *   reconstruction must use, because a backtest reading revised payrolls reads
 *   numbers the signal could not have seen.
 *
 * `vintage_date` comes back with every row so the UI can say which vintage a
 * number is from rather than leaving the reader to assume.
 */
async function readSeries(seriesId, since, { asOf = null } = {}) {
  let q = supabase
    .from(asOf ? 'macro_observations' : 'macro_observations_latest')
    .select('observation_date,value,vintage_date')
    .eq('series_id', seriesId)
    .gte('observation_date', since);
  if (asOf) q = q.lte('vintage_date', asOf);
  const { data, error } = await q.order('observation_date', { ascending: true });
  if (error) throw new Error(`macro_observations: ${error.message}`);

  const rows = (data || []).map(r => ({
    observation_date: String(r.observation_date).slice(0, 10),
    value: r.value == null ? null : Number(r.value),
    vintage_date: r.vintage_date ? String(r.vintage_date).slice(0, 10) : null,
  }));
  if (!asOf) return rows;

  // An as-of read comes from the raw table, so collapse to the newest vintage
  // that existed on or before `asOf`.
  const byDate = new Map();
  for (const r of rows) {
    const prev = byDate.get(r.observation_date);
    if (!prev || (r.vintage_date || '') > (prev.vintage_date || '')) byDate.set(r.observation_date, r);
  }
  return [...byDate.values()].sort((a, b) => (a.observation_date < b.observation_date ? -1 : 1));
}

// Runnable on demand, because "the timer will get to it" is not an answer when
// a release just landed:
//
//   node macro/ingest.js              — rolling 30-month window (the daily job)
//   node macro/ingest.js backfill     — from 2000, for the regime study
//   node macro/ingest.js 2026-06-30   — that VINTAGE, i.e. the data as it was
//                                       known on that date (needs FRED_API_KEY)
//
// Exits non-zero if any series failed, so a scheduled run fails loudly rather
// than reporting success over a partial fetch.
if (require.main === module) {
  const arg = (process.argv[2] || '').trim();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : null;
  const mode = arg === 'backfill' ? 'backfill' : 'recent';

  runIngest({ mode, asOf })
    .then((r) => {
      for (const x of r.results) {
        console.log(`  ${x.seriesId.padEnd(15)} +${x.inserted} new, ${x.revised} revised, ${x.skipped} unchanged`);
      }
      const failed = Object.keys(r.errors);
      console.log(`[macro-ingest] ${r.mode} from ${r.start}: ${r.results.length} series${failed.length ? `, ${failed.length} FAILED` : ''}`);
      if (failed.length) process.exit(1);
    })
    .catch((err) => { console.error('[macro-ingest]', err.message); process.exit(1); });
}

module.exports = { runIngest, ingestSeries, syncCatalogue, readSeries, changed };
