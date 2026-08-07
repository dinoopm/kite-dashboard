// ─── Shared price plumbing for every scorecard ───────────────────────────────
//
// Both scorers — picks/scorecard.js and signals/scorecard.js — need the same
// three things: a trustworthy trading calendar, per-symbol closes laid onto it,
// and a benchmark laid onto the same one. Keeping that in a single module is
// what stops the two from silently measuring different windows and disagreeing
// about the same model.
//
// The calendar is the part that matters. nse_bhavcopy has ingested holes
// (2026-07-03/06/07 were missing while NIFTY traded), and signalScoring counts
// horizons in BARS, so scoring off the bhavcopy calendar alone would quietly
// stretch a "5-day" return across seven real sessions. Merging in the index's
// own sessions restores correct spacing at no cost: forwardReturn only reads
// the endpoints of a window, so a hole in the middle is stepped over, and a
// hole landing on an endpoint has no price to score and becomes `unresolved`.

const YahooFinance = require('yahoo-finance2').default;
const { createClient } = require('@supabase/supabase-js');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BENCHMARK = '^NSEI';

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

/** Every session either source knows about, from `since` on. See the note above. */
function mergeCalendars(tableDates, benchDates, since) {
  const all = new Set((tableDates || []).filter(d => d >= since));
  for (const d of benchDates || []) if (d >= since) all.add(d);
  return [...all].sort();
}

/**
 * Sessions on `calendar` that the price table skipped, so a caller can say so
 * instead of quietly reporting numbers computed over a holed calendar.
 *
 * Bounded at the table's own last row: bhavcopy publishes hours after the
 * close, so the index prints today's bar before the price feed does. Counting
 * that as a hole would raise a false alarm every afternoon — anything at or
 * after the last ingested date is not-yet-arrived, which is dataHealth.js's
 * freshness check, not a gap.
 */
function findCalendarGaps(tableDates, calendar) {
  const sorted = [...(tableDates || [])].sort();
  const last = sorted[sorted.length - 1];
  if (!last) return [];
  const have = new Set(sorted);
  return calendar.filter(d => d < last && !have.has(d));
}

/** Lay a date->close map onto a calendar; missing sessions stay as null closes. */
function alignToCalendar(dates, closeByDate) {
  return dates.map(d => ({ date: d, close: closeByDate?.get(d) ?? null }));
}

/** The bhavcopy trading calendar (RELIANCE trades every session). */
async function fetchTradingDates() {
  const rows = await fetchAll('nse_bhavcopy', 'trade_date',
    (q) => q.eq('symbol', 'RELIANCE').eq('series', 'EQ').order('trade_date', { ascending: true }));
  return rows.map(r => r.trade_date);
}

/** symbol -> (date -> close) for the given symbols, EQ preferred over BE. */
async function fetchCloses(symbols, since) {
  const bySymbol = new Map();
  const CHUNK = 50;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const rows = await fetchAll('nse_bhavcopy', 'trade_date,symbol,series,close',
      (q) => q.in('symbol', symbols.slice(i, i + CHUNK)).gte('trade_date', since));
    for (const r of rows) {
      if (r.close == null) continue;
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, new Map());
      const m = bySymbol.get(r.symbol);
      if (!m.has(r.trade_date) || r.series === 'EQ') m.set(r.trade_date, r.close);
    }
  }
  return bySymbol;
}

/** NIFTY 50 daily closes as date -> close. */
async function fetchBenchmark(since) {
  const c = await yf.chart(BENCHMARK, { period1: since, interval: '1d' });
  const m = new Map();
  for (const q of c.quotes || []) {
    if (q.close == null) continue;
    m.set(q.date.toISOString().slice(0, 10), q.close);
  }
  return m;
}

/**
 * Everything a scorer needs for one set of symbols from one start date.
 *
 * A missing benchmark degrades to raw-return-only scoring rather than failing:
 * Yahoo being down should not delete the track record, though the caller is
 * expected to say so, because raw return mostly measures the market.
 */
async function buildMarketContext(symbols, since) {
  const [tdatesAll, closesBySymbol, benchByDate] = await Promise.all([
    fetchTradingDates(),
    fetchCloses(symbols, since),
    fetchBenchmark(since).catch(() => null),
  ]);

  const calendar = mergeCalendars(tdatesAll, benchByDate ? [...benchByDate.keys()] : [], since);
  const calendarGaps = findCalendarGaps(tdatesAll, calendar);

  const seriesBySymbol = {};
  for (const s of symbols) seriesBySymbol[s] = alignToCalendar(calendar, closesBySymbol.get(s));

  return {
    calendar,
    calendarGaps,
    seriesBySymbol,
    benchmark: benchByDate ? alignToCalendar(calendar, benchByDate) : null,
    benchmarkSymbol: BENCHMARK,
  };
}

module.exports = {
  BENCHMARK, fetchAll, mergeCalendars, findCalendarGaps, alignToCalendar,
  fetchTradingDates, fetchCloses, fetchBenchmark, buildMarketContext,
};
