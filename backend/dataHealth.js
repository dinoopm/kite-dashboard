// ─── Feed ingest health ──────────────────────────────────────────────────────
//
// Written after nse_bhavcopy was found to be silently missing three sessions
// (2026-07-03, 07-06, 07-07) that NSE actually traded. Nothing broke, nothing
// logged, and every downstream number — momentum, 52-week strength, backtest
// horizons — was computed over a calendar with holes and then reported to two
// decimal places. Unmonitored ingest is worse than a loud failure: it produces
// confident, wrong output.
//
// The index is the reference calendar. If NIFTY 50 printed a close on a date,
// the market was open, and a price table with no rows for that date is missing
// data — not observing a holiday. That single comparison catches the whole
// class of problem without needing an exchange holiday list.
//
// Pure functions first (findGaps/checkFreshness) so the logic is testable
// without a database; the fetching wrapper is the thin part.

const YahooFinance = require('yahoo-finance2').default;
const { createClient } = require('@supabase/supabase-js');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const INDEX = '^NSEI';

/**
 * Sessions the index traded that the table never ingested.
 *
 * Bounded at BOTH ends, and both bounds matter:
 *
 *   · `since` — a table that only starts in May must not be reported as missing
 *     all of April.
 *   · the table's own last row — bhavcopy publishes hours after the close, so
 *     the index prints today's bar before the price feed does. Counting that as
 *     a "missing session" would raise a false alarm every single afternoon.
 *     A hole is only a hole once the feed has moved PAST it; anything at or
 *     after the last ingested date is merely not-yet-arrived, which is what
 *     checkFreshness is for.
 */
function findGaps(tableDates, indexDates, since) {
  const sorted = [...tableDates].sort();
  const have = new Set(tableDates);
  const from = since || (sorted.length ? sorted[0] : null);
  const until = sorted[sorted.length - 1];
  if (!from || !until) return [];
  return indexDates.filter(d => d >= from && d < until && !have.has(d)).sort();
}

/**
 * How stale a feed is, measured in index sessions rather than calendar days —
 * a feed last written on Friday is not "3 days behind" on Monday, it is current.
 *
 * `graceSessions` exists because feeds legitimately land late: the bhavcopy for
 * a session publishes after the close, so being one session behind during
 * market hours is normal, not an outage.
 */
function checkFreshness(lastDate, indexDates, { graceSessions = 1 } = {}) {
  if (!lastDate) return { lastDate: null, sessionsBehind: null, stale: true };
  const after = indexDates.filter(d => d > lastDate);
  return {
    lastDate,
    sessionsBehind: after.length,
    stale: after.length > graceSessions,
  };
}

/**
 * Distinct dates present in `table`, ascending.
 *
 * `probeSymbol` is the whole trick. These tables hold one row per symbol per
 * session, so paging them just to learn which DATES exist read 217,000 rows of
 * nse_bhavcopy — 5.8 MB — to discover 78 distinct days, on every check. A
 * symbol that trades every session answers the same question in 78 rows.
 *
 * The probe must be a name that never misses a session, or a real gap would be
 * indistinguishable from that one stock not trading. RELIANCE is the same
 * choice marketSeries makes for the trading calendar.
 */
async function fetchDates(table, col, probeSymbol) {
  const PAGE = 1000;
  const seen = new Set();
  let offset = 0;
  for (;;) {
    let q = supabase.from(table).select(col).order(col, { ascending: true });
    if (probeSymbol) q = q.eq('symbol', probeSymbol);
    const { data, error } = await q.range(offset, offset + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data || []) seen.add(String(r[col]).slice(0, 10));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return [...seen].sort();
}

/** Index sessions since `period1`, as ascending YYYY-MM-DD. */
async function fetchIndexDates(period1) {
  const c = await yf.chart(INDEX, { period1, interval: '1d' });
  return (c.quotes || []).filter(q => q.close != null)
    .map(q => q.date.toISOString().slice(0, 10)).sort();
}

// Feeds worth watching, with how late each is allowed to be. nse_bhavcopy is
// the one everything else derives from, so it gets the tightest grace.
// `probe` names a symbol present every session, so the date list costs a few
// dozen rows instead of the whole table. Feeds with no such guarantee (a stock
// only appears in volume_gainers on days it surged) are read in full, which is
// affordable because those tables are far smaller.
const FEEDS = [
  { table: 'nse_bhavcopy',           col: 'trade_date', grace: 1, label: 'Bhavcopy (prices)',   probe: 'RELIANCE' },
  { table: 'nse_52_week_high_low',   col: 'trade_date', grace: 2, label: '52-week highs/lows',  probe: 'RELIANCE' },
  { table: 'volume_gainers',         col: 'trade_date', grace: 2, label: 'Volume gainers' },
  { table: 'stock_pick_snapshots',   col: 'snap_date',  grace: 2, label: 'Published picks' },
];

/**
 * Check every feed against the index calendar.
 *
 * Returns `ok: false` when anything is stale or has holes, so a caller can log
 * loudly or a UI can show a banner. Individual feed failures degrade to an
 * `error` on that row rather than sinking the whole report — a health check
 * that dies when one thing is broken is useless precisely when it is needed.
 */
async function checkDataHealth({ since = '2026-04-01' } = {}) {
  const indexDates = await fetchIndexDates(since);
  const feeds = [];

  for (const f of FEEDS) {
    try {
      const dates = await fetchDates(f.table, f.col, f.probe);
      const gaps = findGaps(dates, indexDates);
      const fresh = checkFreshness(dates[dates.length - 1], indexDates, { graceSessions: f.grace });
      feeds.push({
        table: f.table, label: f.label,
        first: dates[0] || null, last: fresh.lastDate,
        sessions: dates.length,
        sessionsBehind: fresh.sessionsBehind,
        stale: fresh.stale,
        gaps,
        ok: !fresh.stale && gaps.length === 0,
      });
    } catch (err) {
      feeds.push({ table: f.table, label: f.label, ok: false, error: err.message });
    }
  }

  return {
    index: { symbol: INDEX, sessions: indexDates.length, last: indexDates[indexDates.length - 1] || null },
    feeds,
    ok: feeds.every(f => f.ok),
    checkedAt: new Date().toISOString(),
  };
}

/** One-line-per-problem log. Silent when everything is healthy. */
function logDataHealth(report) {
  if (report.ok) return;
  for (const f of report.feeds) {
    if (f.ok) continue;
    if (f.error) { console.error(`[data-health] ${f.table}: check failed — ${f.error}`); continue; }
    if (f.stale) console.error(`[data-health] ${f.table}: ${f.sessionsBehind} session(s) behind (last ${f.last})`);
    if (f.gaps?.length) console.error(`[data-health] ${f.table}: missing ${f.gaps.length} traded session(s) — ${f.gaps.join(', ')}`);
  }
}

module.exports = { checkDataHealth, logDataHealth, findGaps, checkFreshness };
