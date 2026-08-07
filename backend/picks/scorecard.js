// ─── Picks scorecard — what the dashboard ACTUALLY published, scored ─────────
//
// Sibling of picks/backtest.js, and deliberately not the same measurement:
//
//   backtest.js  reconstructs what the model WOULD have picked on past dates by
//                re-running the engine, then measures those picks. It answers
//                "is the factor model any good?" — but it re-ranks with today's
//                surveillance list and today's revised feeds, so it flatters.
//
//   this module  reads the picks the server actually WROTE that day
//                (stock_pick_snapshots) and measures those. No reconstruction,
//                no revised inputs, no lookahead: it answers the narrower and
//                more honest question "did the rows a user saw on screen make
//                money?" That is the only track record that was ever real.
//
// Scoring itself lives in ../signalScoring.js and the price plumbing in
// ../signals/marketSeries.js, so this file is only the question being asked —
// the arithmetic and the calendar stay pure, tested and shared.
//
// Benchmark is NIFTY 50 (^NSEI). backtest.js benchmarks against the universe
// median, which asks "did the picks beat the average stock?"; here the question
// is the one an actual holder faces — "did holding these beat holding the
// index?" Both are legitimate, and they can disagree, so both are reported
// across the two endpoints rather than blended into one number.

const { scoreSignal, summarise } = require('../signalScoring');
const { fetchAll, buildMarketContext, BENCHMARK } = require('../signals/marketSeries');
const { ACKNOWLEDGED_GAPS } = require('../dataHealth');

const HORIZONS = [5, 10, 22]; // trading days: ~1 week, ~2 weeks, ~1 month

// The snapshot days that were never written. dataHealth declares them so the
// feed-integrity banner stops nagging about something nobody can fix; here they
// matter for the opposite reason. Every `n` below is genuinely short by those
// days, and that belongs beside the number it weakens rather than in a banner
// about broken feeds — a missing snapshot distorts no arithmetic, it just means
// less evidence than the count implies.
const MISSING_SNAPSHOTS = ACKNOWLEDGED_GAPS.stock_pick_snapshots;

/** Declared-missing snapshot days falling inside a scored period. */
function missingInPeriod(first, last) {
  return (MISSING_SNAPSHOTS?.dates || []).filter(d => d >= first && d <= last);
}

/** Every recorded emission, oldest first. */
async function fetchEmissions() {
  const rows = await fetchAll('stock_pick_snapshots', 'snap_date,symbol,rank',
    (q) => q.order('snap_date', { ascending: true }).order('rank', { ascending: true }));
  return rows.map(r => ({ date: r.snap_date, symbol: r.symbol, rank: r.rank }));
}

const pct = (x) => (x == null ? null : +x.toFixed(2));
const rate = (x) => (x == null ? null : +(x * 100).toFixed(1));

/** scoreSignal output -> the rounded shape the UI renders. */
function present(stats) {
  return Object.entries(stats).map(([horizon, s]) => ({
    horizon,
    n: s.n,
    unresolved: s.unresolved,
    hitRatePct: rate(s.hitRate),
    medianPct: pct(s.medianPct),
    meanPct: pct(s.meanPct),
    nExcess: s.nExcess,
    medianExcessPct: pct(s.medianExcessPct),
    meanExcessPct: pct(s.meanExcessPct),
    hitRateExcessPct: rate(s.hitRateExcess),
    verdict: summarise(s),
  }));
}

/**
 * Score every published pick, plus the top-10 slice on its own.
 *
 * The slice is not decoration: if rank carries information, the top 10 should
 * beat the full 25. If it doesn't, the ranking inside the list is noise even
 * when the list as a whole works, and that is worth seeing separately.
 */
async function runScorecard() {
  const emissions = await fetchEmissions();
  if (!emissions.length) {
    return {
      params: { horizons: HORIZONS, benchmark: BENCHMARK },
      period: null, overall: [], top10: [],
      caveats: ['No snapshots recorded yet — the track record starts accumulating from the first daily snapshot.'],
      generatedAt: new Date().toISOString(),
    };
  }

  const firstDate = emissions[0].date;
  const symbols = [...new Set(emissions.map(e => e.symbol))];

  // Calendar, per-symbol closes and benchmark all come from signals/marketSeries
  // so this scorer and the all-signals one can never measure different windows.
  const { seriesBySymbol, benchmark, calendarGaps } = await buildMarketContext(symbols, firstDate);

  const opts = { horizons: HORIZONS, benchmark };
  const overall = scoreSignal(emissions, seriesBySymbol, opts);
  const top10 = scoreSignal(emissions.filter(e => e.rank <= 10), seriesBySymbol, opts);

  const snapDates = [...new Set(emissions.map(e => e.date))];
  const lastDate = snapDates[snapDates.length - 1];
  const lostSnapshots = missingInPeriod(firstDate, lastDate);
  return {
    params: { horizons: HORIZONS, benchmark: BENCHMARK, topSlice: 10 },
    period: { first: firstDate, last: lastDate, snapshotDays: snapDates.length, emissions: emissions.length },
    calendarGaps,
    lostSnapshots,
    overall: present(overall),
    top10: present(top10),
    caveats: [
      ...(lostSnapshots.length
        ? [`No picks were recorded on ${lostSnapshots.join(', ')} — the recorder fired lazily off a page view then and lost them. Those days are absent from every n below and cannot be recovered.`]
        : []),
      ...(calendarGaps.length
        ? [`nse_bhavcopy is missing ${calendarGaps.length} session(s) the index traded (${calendarGaps.join(', ')}). Horizons are counted on the merged calendar so spacing stays right, but any pick entering or exiting on those dates is unresolved.`]
        : []),
      'Only picks actually written to stock_pick_snapshots — no reconstruction, so no feed-revision or surveillance-list lookahead.',
      'Emissions overlap heavily day to day (a pick usually stays in the top 25), so the samples are far from independent — n overstates the real evidence.',
      'Entry at the snapshot-date close; costs, slippage and liquidity are not modeled.',
      benchmark ? 'Excess is over NIFTY 50; picks/backtest measures excess over the universe median instead.'
                : 'Benchmark unavailable — only raw returns are shown, which mostly measure the market.',
      'Recent snapshots have not had time to resolve at the longer horizons; they are counted in `unresolved`, never as flat.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runScorecard, missingInPeriod };
