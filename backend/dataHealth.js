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
 * Gaps that are real, understood, and can never be filled.
 *
 * An entry here is not a mute button. It is a claim that the cause is known and
 * the data is unrecoverable, which is why each one has to carry its reason —
 * a date silenced without a stated cause is indistinguishable from one silenced
 * because it was inconvenient. Dates NOT declared here still raise the banner,
 * so a recorder that breaks tomorrow is exactly as loud as it ever was.
 *
 * The point of declaring them is that a warning which can never be cleared
 * gets ignored, and then the next real gap is ignored with it.
 */
const ACKNOWLEDGED_GAPS = {
  stock_pick_snapshots: {
    dates: ['2026-07-16', '2026-07-17'],
    reason: 'Daily recording fired lazily off a page view and set its done-flag before the write landed (it runs on a timer in dailyJobs.js now). A snapshot reconstructed after the fact is not the same evidence, so these two cannot be recovered.',
  },
};

/** Split found gaps into ones worth an alarm and ones already accounted for. */
function partitionGaps(gaps, acknowledged) {
  const known = new Set(acknowledged?.dates || []);
  return {
    gaps: gaps.filter(d => !known.has(d)),
    acknowledged: gaps.filter(d => known.has(d)),
  };
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
// `checkGaps: false` for feeds whose write days are not the index's trading
// days. The macro recorder runs on its own schedule — GitHub Actions on
// weekdays, dailyJobs whenever the server is up — so every weekend would show
// as a "missing session" and the banner would cry wolf permanently. Freshness
// is still checked, which is the question that matters: has the automation
// stopped?
const FEEDS = [
  { table: 'nse_bhavcopy',           col: 'trade_date', grace: 1, label: 'Bhavcopy (prices)',   probe: 'RELIANCE' },
  { table: 'nse_52_week_high_low',   col: 'trade_date', grace: 2, label: '52-week highs/lows',  probe: 'RELIANCE' },
  { table: 'volume_gainers',         col: 'trade_date', grace: 2, label: 'Volume gainers' },
  { table: 'stock_pick_snapshots',   col: 'snap_date',  grace: 2, label: 'Published picks' },
  // A stalled macro sync is invisible otherwise: the panel keeps rendering
  // last week's regime with no indication that nothing has updated it. Three
  // sessions of grace covers a long weekend plus one missed run.
  { table: 'macro_signal_snapshots', col: 'snap_date',  grace: 3, label: 'Macro regime', checkGaps: false },
];

/**
 * Check every feed against the index calendar.
 *
 * Returns `ok: false` when anything is stale or has holes, so a caller can log
 * loudly or a UI can show a banner. Individual feed failures degrade to an
 * `error` on that row rather than sinking the whole report — a health check
 * that dies when one thing is broken is useless precisely when it is needed.
 */
/**
 * Fundamentals coverage — a different question from a daily feed's gaps.
 *
 * The FEEDS check above asks "did this table get a row on every session the
 * index traded?", which is the right question for daily prices and a
 * meaningless one for quarterly results: companies report four times a year,
 * on their own dates. So this asks the two questions that CAN go wrong here
 * instead — how much of the universe has a recent period at all, and how long
 * since the ingest last ran.
 *
 * Deliberately not folded into `ok`: thin coverage in the days after a quarter
 * closes is the normal state of an earnings season, not a defect, and a banner
 * that cries during every results season stops being read.
 */
async function checkFundamentalsCoverage({ months = 6 } = {}) {
  const cutoff = new Date(Date.now() - months * 30 * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const market of ['IN', 'US']) {
    try {
      const { data, error } = await supabase
        .from('stock_fundamentals')
        .select('symbol,period_end,fetched_at')
        .eq('market', market).eq('period_type', 'quarter')
        .gte('period_end', cutoff);
      if (error) throw new Error(error.message);
      const symbols = new Set((data || []).map(r => r.symbol));
      const lastIngest = (data || []).reduce((m, r) => (r.fetched_at > m ? r.fetched_at : m), '');
      const ageHours = lastIngest ? (Date.now() - Date.parse(lastIngest)) / 3600000 : null;
      out.push({
        market,
        symbolsWithRecentPeriod: symbols.size,
        rows: (data || []).length,
        lastIngest: lastIngest || null,
        ingestAgeHours: ageHours == null ? null : +ageHours.toFixed(1),
        // A stalled ingest IS actionable, unlike thin seasonal coverage.
        ingestStale: ageHours != null && ageHours > 48,
        never: !lastIngest,
      });
    } catch (err) {
      out.push({ market, error: err.message });
    }
  }
  return out;
}

async function checkDataHealth({ since = '2026-04-01' } = {}) {
  const indexDates = await fetchIndexDates(since);
  const feeds = [];

  for (const f of FEEDS) {
    try {
      const dates = await fetchDates(f.table, f.col, f.probe);
      const declared = ACKNOWLEDGED_GAPS[f.table];
      const found = f.checkGaps === false ? [] : findGaps(dates, indexDates);
      const { gaps, acknowledged } = partitionGaps(found, declared);
      const fresh = checkFreshness(dates[dates.length - 1], indexDates, { graceSessions: f.grace });
      feeds.push({
        table: f.table, label: f.label,
        first: dates[0] || null, last: fresh.lastDate,
        sessions: dates.length,
        sessionsBehind: fresh.sessionsBehind,
        stale: fresh.stale,
        gaps,
        // Reported so the fact survives in the payload, but deliberately not
        // part of `ok` — nothing downstream can act on it.
        acknowledged,
        acknowledgedReason: acknowledged.length ? declared.reason : null,
        ok: !fresh.stale && gaps.length === 0,
      });
    } catch (err) {
      feeds.push({ table: f.table, label: f.label, ok: false, error: err.message });
    }
  }

  // Reported alongside, never inside `ok` — see checkFundamentalsCoverage.
  let fundamentals = null;
  try { fundamentals = await checkFundamentalsCoverage(); }
  catch (err) { fundamentals = [{ error: err.message }]; }

  return {
    index: { symbol: INDEX, sessions: indexDates.length, last: indexDates[indexDates.length - 1] || null },
    feeds,
    fundamentals,
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

module.exports = {
  checkDataHealth, logDataHealth, findGaps, checkFreshness,
  partitionGaps, ACKNOWLEDGED_GAPS, FEEDS, checkFundamentalsCoverage,
};
