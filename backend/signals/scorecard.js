// ─── Scoring every signal the app publishes ──────────────────────────────────
//
// Reads signal_emissions and reports, per signal, what actually happened next.
// The point is coverage: a dashboard where one signal is validated and twelve
// are not is a dashboard where the user cannot tell which is which. Every entry
// in the registry appears in this output — including the ones that fired zero
// times and the ones that cannot be scored yet, each with the reason attached.
//
// Signals are scored separately by `source`, never pooled:
//
//   recorded      the row was written the day it fired, before the outcome
//                 existed. The only true out-of-sample evidence here.
//   reconstructed recomputed from stored OHLC. Bhavcopy is not revised and the
//                 detectors are causal, so this is faithful — but it was
//                 assembled after the fact, and pooling it with recorded rows
//                 would launder the weaker evidence into the stronger.

const { scoreSignal, summarise } = require('../signalScoring');
const { fetchAll, buildMarketContext } = require('./marketSeries');
const { ALL_SIGNALS, BLOCKED_SIGNALS, signalMeta } = require('./registry');

const HORIZONS = [5, 10, 22];
// Below this, `summarise` refuses to call a direction. Reported anyway, so an
// under-sampled signal is visibly under-sampled instead of merely absent.
const MIN_N = 20;

async function fetchEmissions() {
  const rows = await fetchAll('signal_emissions', 'signal,snap_date,symbol,source',
    (q) => q.order('snap_date', { ascending: true }));
  return rows.map(r => ({ signal: r.signal, date: r.snap_date, symbol: r.symbol, source: r.source }));
}

const pct = (x) => (x == null ? null : +x.toFixed(2));
const rate = (x) => (x == null ? null : +(x * 100).toFixed(1));

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
    underSampled: s.n < MIN_N,
    verdict: summarise(s, { minN: MIN_N }),
  }));
}

/**
 * The headline a UI can put next to the signal itself.
 *
 * Deliberately blunt and deliberately conservative: it reports the middle
 * horizon only, refuses to speak below MIN_N, and leads with excess over the
 * index rather than raw return, because raw return mostly measures the market
 * and would flatter every signal in a rising one.
 */
function headline(rows, { source, blockedReason } = {}) {
  if (blockedReason) return { state: 'unscoreable', text: 'Cannot be scored yet', detail: blockedReason };
  const mid = rows.find(r => r.horizon === '10d') || rows[0];
  if (!mid || !mid.n) return { state: 'no-data', text: 'No resolved firings yet', detail: 'Nothing has fired long enough ago to have an outcome.' };
  if (mid.underSampled) return { state: 'thin', text: `n=${mid.n} — too few to judge`, detail: `Needs ${MIN_N}+ resolved firings before a direction means anything.` };
  const edge = mid.medianExcessPct;
  if (edge == null) return { state: 'no-benchmark', text: `median ${mid.medianPct}% (no benchmark)`, detail: 'Index unavailable, so this is raw return and mostly reflects the market.' };
  return {
    state: edge > 0 ? 'positive' : 'negative',
    text: `${edge > 0 ? '+' : ''}${edge}% vs NIFTY over 10d (n=${mid.n})`,
    detail: `Median ${edge > 0 ? 'beat' : 'lagged'} the index by ${Math.abs(edge)}% over 10 sessions across ${mid.n} resolved firings${source === 'reconstructed' ? ', reconstructed from stored prices' : ''}.`,
  };
}

/** Score every signal in the registry. */
async function runSignalScorecard() {
  const all = await fetchEmissions();

  // Group by (signal, source) — the split is the point, so it happens before
  // anything is measured rather than being a filter applied afterwards.
  const groups = new Map();
  for (const e of all) {
    const key = `${e.signal}|${e.source || 'reconstructed'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const signals = [];
  const blocked = BLOCKED_SIGNALS.map(s => ({
    signal: s.name, label: s.label, source: s.source,
    firings: 0, symbols: 0, horizons: [],
    headline: headline([], { blockedReason: s.blockedReason }),
  }));

  if (!groups.size) {
    return {
      params: { horizons: HORIZONS, minN: MIN_N },
      signals: [...blocked],
      calendarGaps: [],
      caveats: ['signal_emissions is empty — run `node signals/backfill.js` after creating the table (see migrate_signal_emissions.js).'],
      generatedAt: new Date().toISOString(),
    };
  }

  const since = all.reduce((min, e) => (e.date < min ? e.date : min), all[0].date);
  const symbols = [...new Set(all.map(e => e.symbol))];
  const ctx = await buildMarketContext(symbols, since);
  const opts = { horizons: HORIZONS, benchmark: ctx.benchmark };

  for (const [key, emissions] of groups) {
    const [name, source] = key.split('|');
    const meta = signalMeta(name);
    const rows = present(scoreSignal(emissions, ctx.seriesBySymbol, opts));
    const dates = [...new Set(emissions.map(e => e.date))];
    signals.push({
      signal: name,
      label: meta?.label || name,
      description: meta?.description || null,
      source,
      firings: emissions.length,
      symbols: new Set(emissions.map(e => e.symbol)).size,
      firstFired: dates[0],
      lastFired: dates[dates.length - 1],
      horizons: rows,
      headline: headline(rows, { source }),
    });
  }

  // Registry entries that have never fired still belong in the output — a
  // signal shipping in the UI with no emissions is a recording bug, and
  // omitting it would hide exactly that.
  const seen = new Set(signals.map(s => s.signal));
  const neverFired = ALL_SIGNALS
    .filter(s => !seen.has(s.name) && !s.blockedReason)
    .map(s => ({
      signal: s.name, label: s.label, source: s.source,
      firings: 0, symbols: 0, horizons: [],
      headline: { state: 'no-data', text: 'Never recorded', detail: 'This signal is in the registry but nothing has been written for it — check the recorder.' },
    }));

  signals.sort((a, b) => b.firings - a.firings);

  return {
    params: { horizons: HORIZONS, minN: MIN_N, benchmark: ctx.benchmarkSymbol },
    period: { first: since, calendarSessions: ctx.calendar.length },
    calendarGaps: ctx.calendarGaps,
    signals: [...signals, ...neverFired, ...blocked],
    caveats: [
      ...(ctx.calendarGaps.length
        ? [`nse_bhavcopy is missing ${ctx.calendarGaps.length} session(s) the index traded (${ctx.calendarGaps.join(', ')}). Horizons use the merged calendar so spacing stays right; firings entering or exiting on those dates are unresolved.`]
        : []),
      'Excess is over NIFTY 50. Raw return is shown too, but in a rising market it flatters every signal.',
      'Firings overlap: many symbols fire on the same day for the same market-wide reason, so n overstates how much independent evidence there is.',
      'Entry at the firing day close. Costs, slippage and liquidity are not modeled; a floor of ₹1 crore median daily turnover is applied at recording time.',
      '`reconstructed` signals were recomputed from stored OHLC after the fact — faithful, since bhavcopy is not revised and the detectors are causal, but weaker evidence than `recorded`.',
      'Recent firings have not had time to resolve at the longer horizons; they are counted as unresolved, never as flat.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runSignalScorecard, headline, present, HORIZONS, MIN_N };
