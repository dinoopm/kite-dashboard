// ─── What was expected, recorded before the answer arrives ───────────────────
//
// Yahoo exposes only the CURRENT consensus. The pre-announcement consensus for
// a past quarter is not recoverable from any source this app can reach — the
// same limitation, and the same conclusion, as analyst_target_upside in
// BLOCKED_SIGNALS. So beat/miss cannot be reconstructed; it can only be
// recorded forward.
//
// Which is why this runs from day one, months before any panel reads it. A day
// not recorded is a day permanently missing, and stock_pick_snapshots already
// taught that lesson by losing 2026-07-16 and 07-17.
//
// Two details that decide whether the stored rows are usable later:
//
//   · Yahoo's trend periods are RELATIVE ('0q', '+1q'). '0q' means a different
//     quarter before and after a result lands, so the label alone cannot
//     identify what was being forecast. trend_end_date is stored beside it and
//     is what joins should use.
//   · market_cap rides along because it comes from the same quoteSummary call.
//     One fetch serves both the index weighting and the consensus, which is the
//     only reason a nightly pass over ~840 symbols is affordable at all.
//
// Cost control: only symbols inside a reporting window are refreshed, which is
// also the only window where a pre-announcement consensus is worth having.

require('dotenv').config({ path: __dirname + '/../../.env' });
const { createClient } = require('@supabase/supabase-js');
const YahooFinance = require('yahoo-finance2').default;

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const supabase = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// The reporting-lag band. SEBI LODR allows 45 days for Indian quarterly
// results; US filers are quicker. The lower bound exists because nothing
// reports the day a quarter closes, so a hit that early is a data artefact
// rather than a result.
const WINDOW = {
  IN: { minDays: 10, maxDays: 75 },
  US: { minDays: 10, maxDays: 60 },
};

const CONCURRENCY = 4;
const DAY = 86400000;
const todayIso = () => new Date().toISOString().slice(0, 10);

/** The calendar quarter end that follows a given period end. */
function nextQuarterEnd(periodEnd) {
  const d = new Date(periodEnd + 'T00:00:00Z');
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 4, 0));
  return end.toISOString().slice(0, 10);
}

/**
 * Which symbols are plausibly about to report, or have just reported.
 *
 * India has no earnings-calendar source — the US one at /api/us/earnings-calendar
 * has no Indian counterpart — so the expectation comes from each symbol's own
 * history: the quarter after its latest stored one, plus the reporting lag
 * band. Approximate by construction, which is why the band is generous rather
 * than tight.
 */
function symbolsInReportingWindow(latestBySymbol, market, today = todayIso()) {
  const { minDays, maxDays } = WINDOW[market] || WINDOW.IN;
  const now = Date.parse(today + 'T00:00:00Z');
  const out = [];
  for (const [symbol, latestPeriodEnd] of Object.entries(latestBySymbol)) {
    if (!latestPeriodEnd) { out.push(symbol); continue; }   // nothing stored — always look
    const expected = Date.parse(nextQuarterEnd(latestPeriodEnd) + 'T00:00:00Z');
    const age = (now - expected) / DAY;
    if (age >= minDays && age <= maxDays) out.push(symbol);
  }
  return out;
}

/** One symbol's consensus + cap, flattened into storable rows. */
function snapshotRows(market, symbol, quoteSummary, snapDate = todayIso()) {
  const trends = quoteSummary?.earningsTrend?.trend || [];
  const price = quoteSummary?.price || {};
  const marketCap = price.marketCap ?? null;
  const currency = price.currency || (market === 'IN' ? 'INR' : 'USD');
  const rows = [];
  for (const t of trends) {
    if (!t?.period) continue;
    const e = t.earningsEstimate || {};
    const rev = t.revenueEstimate || {};
    rows.push({
      market, symbol, snap_date: snapDate,
      trend_period: t.period,
      // The relative label is not enough to identify the quarter later.
      trend_end_date: t.endDate ? String(t.endDate).slice(0, 10) : null,
      eps_avg: e.avg ?? null,
      eps_low: e.low ?? null,
      eps_high: e.high ?? null,
      analysts: e.numberOfAnalysts ?? null,
      revenue_avg: rev.avg ?? null,
      market_cap: marketCap,
      market_cap_unit: currency,
    });
  }
  return rows;
}

async function latestPeriodEnds(market) {
  const { data, error } = await supabase()
    .from('stock_fundamentals')
    .select('symbol,period_end')
    .eq('market', market).eq('period_type', 'quarter')
    .order('period_end', { ascending: false });
  if (error) throw new Error(`stock_fundamentals: ${error.message}`);
  const out = {};
  for (const r of data || []) if (!(r.symbol in out)) out[r.symbol] = r.period_end;
  return out;
}

async function upsertSnapshots(rows) {
  if (!rows.length) return 0;
  const db = supabase();
  const CHUNK = 500;
  let saved = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from('consensus_snapshots')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'market,symbol,snap_date,trend_period' });
    if (error) throw new Error(`consensus_snapshots: ${error.message}`);
    saved += Math.min(CHUNK, rows.length - i);
  }
  return saved;
}

const toYahoo = (market, symbol) =>
  (market === 'IN' ? `${symbol.replace(/-(BE|BZ|SM)$/i, '')}.NS` : symbol.replace('.', '-'));

async function snapshotConsensus({ market = 'IN', symbols = null, limit = 0 } = {}) {
  const latest = await latestPeriodEnds(market);
  const candidates = symbols || symbolsInReportingWindow(latest, market);
  const list = limit ? candidates.slice(0, limit) : candidates;

  const rows = [];
  let ok = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < list.length) {
      const symbol = list[i++];
      try {
        // price AND earningsTrend in ONE call — the cap is for weighting, the
        // trend is the consensus, and fetching them separately would double an
        // already-large nightly bill.
        const q = await yf.quoteSummary(toYahoo(market, symbol),
          { modules: ['price', 'earningsTrend'] }, { validateResult: false });
        rows.push(...snapshotRows(market, symbol, q));
        ok++;
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  const saved = await upsertSnapshots(rows);
  return { market, considered: list.length, ok, failed, saved };
}

module.exports = {
  snapshotConsensus, symbolsInReportingWindow, snapshotRows, nextQuarterEnd, WINDOW,
};
