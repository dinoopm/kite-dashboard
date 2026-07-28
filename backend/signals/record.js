// ─── Recording signal emissions ──────────────────────────────────────────────
//
// Turns the registry's detectors loose on stored bhavcopy and writes every
// firing to signal_emissions, plus mirrors the two signals that were already
// being captured elsewhere (published picks, 52-week highs) into the same table
// so one scorer can read them all.
//
// Upsert on the primary key makes every run idempotent: a daily run, a
// re-run after a crash, and a full backfill are the same operation, which is
// what stops the record from developing the holes it exists to detect.
//
// The liquidity floor is a judgement call, stated rather than hidden: a signal
// firing on a stock with ₹20 lakh of daily turnover is not actionable, and
// including such names would let the scorecard be carried by prices nobody
// could have traded at.

const { createClient } = require('@supabase/supabase-js');
const { buildSeries } = require('../backtest/indicators');
const { detectAll, PRICE_SIGNALS } = require('./registry');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MIN_MEDIAN_TURNOVER_LACS = 100; // ₹1 crore/day median over the window
const UPSERT_CHUNK = 500;

async function fetchAll(table, cols, applyFilters) {
  const PAGE = 1000;
  let offset = 0;
  const out = [];
  for (;;) {
    let q = supabase.from(table).select(cols).range(offset, offset + PAGE - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * symbol -> ascending candle array, EQ series only.
 *
 * EQ only is not a filter of convenience: BE/BZ series carry trade-to-trade and
 * surveillance restrictions, and their prints are not comparable to the EQ
 * closes every indicator in this codebase is built on.
 */
async function loadCandles() {
  const rows = await fetchAll('nse_bhavcopy',
    'trade_date,symbol,series,open,high,low,close,volume,turnover_lacs',
    (q) => q.eq('series', 'EQ').order('trade_date', { ascending: true }));

  const bySymbol = new Map();
  for (const r of rows) {
    if (r.close == null || r.high == null || r.low == null) continue;
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push({
      date: r.trade_date, open: r.open, high: r.high, low: r.low,
      close: r.close, volume: r.volume || 0, turnover: r.turnover_lacs || 0,
    });
  }

  // Drop the illiquid tail before any detector sees it.
  const liquid = new Map();
  let dropped = 0;
  for (const [sym, candles] of bySymbol) {
    if (median(candles.map(c => c.turnover)) < MIN_MEDIAN_TURNOVER_LACS) { dropped++; continue; }
    liquid.set(sym, candles);
  }
  return { bySymbol: liquid, illiquidDropped: dropped, symbolsSeen: bySymbol.size };
}

async function upsertEmissions(rows) {
  let saved = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from('signal_emissions')
      .upsert(chunk, { onConflict: 'signal,snap_date,symbol' });
    if (error) throw new Error(`signal_emissions: ${error.message}`);
    saved += chunk.length;
  }
  return saved;
}

/** Run the price detectors over stored bhavcopy and persist every firing. */
async function recordPriceSignals({ fromDate = null } = {}) {
  const { bySymbol, illiquidDropped, symbolsSeen } = await loadCandles();
  const rows = [];
  let skippedShort = 0;
  const minBarsNeeded = Math.min(...PRICE_SIGNALS.map(s => s.minBars));

  for (const [symbol, candles] of bySymbol) {
    if (candles.length <= minBarsNeeded) { skippedShort++; continue; }
    const S = buildSeries(candles);
    for (const hit of detectAll(S, { fromDate })) {
      rows.push({ signal: hit.signal, snap_date: hit.date, symbol, source: 'reconstructed', meta: hit.meta });
    }
  }

  const saved = await upsertEmissions(rows);
  const byName = {};
  for (const r of rows) byName[r.signal] = (byName[r.signal] || 0) + 1;
  return { saved, byName, symbols: bySymbol.size, symbolsSeen, illiquidDropped, skippedShort };
}

/**
 * Mirror the published picks into signal_emissions as `recorded` rows.
 *
 * They stay in stock_pick_snapshots as the system of record — this is a copy so
 * that one scorer can compare picks against price signals on identical terms.
 */
async function recordPickSignals({ fromDate = null } = {}) {
  const snaps = await fetchAll('stock_pick_snapshots', 'snap_date,symbol,rank,composite',
    (q) => (fromDate ? q.gte('snap_date', fromDate) : q));
  const rows = [];
  for (const s of snaps) {
    const meta = { rank: s.rank, composite: s.composite };
    rows.push({ signal: 'picks_top25', snap_date: s.snap_date, symbol: s.symbol, source: 'recorded', meta });
    if (s.rank <= 10) rows.push({ signal: 'picks_top10', snap_date: s.snap_date, symbol: s.symbol, source: 'recorded', meta });
  }
  return { saved: await upsertEmissions(rows) };
}

/**
 * New 52-week highs, from the daily snapshot NSE publishes.
 *
 * The table is a running snapshot: each row carries the trailing 52-week high
 * and the date it was set. The obvious test — `high_date === trade_date` — never
 * matches, because NSE computes the file as of the previous session, so
 * `high_date` is at most trade_date − 1. That silently recorded nothing at all
 * until the scorecard reported the signal as "never recorded".
 *
 * A new high is therefore a CHANGE in `high_date` between one snapshot and the
 * next for the same symbol. The emission is dated at the snapshot that revealed
 * it, not at the session the high was actually set: the later date is the first
 * one on which a user could have acted, and dating it earlier would score the
 * signal on a move nobody could have traded.
 */
async function record52wHighs({ fromDate = null } = {}) {
  const rows52 = await fetchAll('nse_52_week_high_low', 'trade_date,symbol,series,adjusted_52_week_high,high_date',
    (q) => (fromDate ? q.gte('trade_date', fromDate) : q));

  // symbol -> snapshots in date order
  const bySymbol = new Map();
  for (const r of rows52) {
    if (r.series && r.series !== 'EQ') continue;
    if (!r.high_date) continue;
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }

  const rows = [];
  for (const [symbol, snaps] of bySymbol) {
    snaps.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
    for (let i = 1; i < snaps.length; i++) {
      const prev = String(snaps[i - 1].high_date).slice(0, 10);
      const curr = String(snaps[i].high_date).slice(0, 10);
      // Only a FORWARD move counts. The trailing window also drops old highs off
      // the back, which moves high_date backwards — that is a high expiring, not
      // a new one being set.
      if (curr <= prev) continue;
      rows.push({
        signal: 'high_52w', snap_date: snaps[i].trade_date, symbol, source: 'recorded',
        meta: { high: snaps[i].adjusted_52_week_high, highSetOn: curr },
      });
    }
  }
  return { saved: await upsertEmissions(rows) };
}

/** Everything, in one idempotent pass. Safe to run daily or over all history. */
async function recordAll({ fromDate = null } = {}) {
  const price = await recordPriceSignals({ fromDate });
  const picks = await recordPickSignals({ fromDate });
  const highs = await record52wHighs({ fromDate });
  return { price, picks, highs, fromDate, recordedAt: new Date().toISOString() };
}

module.exports = { recordAll, recordPriceSignals, recordPickSignals, record52wHighs, loadCandles };
