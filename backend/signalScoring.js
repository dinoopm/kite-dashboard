// Scoring for the app's own signals.
//
// Every signal here — Hidden Leaders, momentum ranks, breakouts, VCP — asserts
// something about the future and is then never checked. This module closes
// that loop: given the dates a signal fired and the price series afterwards,
// it reports what actually happened.
//
// Two deliberate choices:
//
// 1. Excess return over a benchmark is the headline, not raw return. A signal
//    that returns +4% in a month when the index returned +6% did not find
//    strength, it found a laggard. Raw return mostly measures the market.
//
// 2. Median alongside mean. One 300% outlier can carry a mean while the median
//    trade lost money; a signal you act on repeatedly lives on the median.
//
// Nothing here fetches — callers pass the series, which keeps it pure and
// testable, and keeps lookahead bias visible: a signal dated T is scored from
// the close at T forward, never from data the signal could not have seen.

/**
 * Forward return, in percent, from `fromIdx` to `horizon` bars later.
 * Returns null when the series does not extend far enough — an unresolved
 * signal must not be silently scored as flat.
 */
function forwardReturn(series, fromIdx, horizon) {
  if (!Array.isArray(series)) return null;
  if (fromIdx < 0 || fromIdx >= series.length) return null;
  const toIdx = fromIdx + horizon;
  if (toIdx >= series.length) return null;
  const from = series[fromIdx]?.close;
  const to = series[toIdx]?.close;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/** Index of the bar on `date` (YYYY-MM-DD), or -1. */
function indexOfDate(series, date) {
  if (!Array.isArray(series) || !date) return -1;
  const want = String(date).slice(0, 10);
  return series.findIndex(b => String(b.date).slice(0, 10) === want);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Illustrative all-in fee and slippage assumptions, not broker-specific rates.
const DEFAULT_COST_MODEL = Object.freeze({ version: 'illustrative-v1', feeBpsPerSide: 10, slippageBpsPerSide: 5 });

function validateCostModel(model) {
  for (const key of ['feeBpsPerSide', 'slippageBpsPerSide']) {
    if (!Number.isFinite(model?.[key]) || model[key] < 0) throw new TypeError(`Invalid ${key}`);
  }
  if (model.feeBpsPerSide + model.slippageBpsPerSide >= 10000) throw new TypeError('Costs must be below 100% per side');
  return model;
}

function forwardOutcome(series, fromIdx, horizon, { entryPrice, costModel } = {}) {
  if (!Number.isInteger(horizon) || horizon < 1 || !Array.isArray(series) || fromIdx < 0 || fromIdx + horizon >= series.length) return null;
  const entry = entryPrice ?? series[fromIdx]?.close;
  const exit = series[fromIdx + horizon]?.close;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit) || exit <= 0) return null;
  const grossReturnPct = ((exit / entry) - 1) * 100;
  let netReturnPct = null;
  if (costModel) {
    validateCostModel(costModel);
    const rate = (costModel.feeBpsPerSide + costModel.slippageBpsPerSide) / 10000;
    netReturnPct = ((exit * (1 - rate)) / (entry * (1 + rate)) - 1) * 100;
  }
  // Exclude the observation-day low: it may precede an intraday observation.
  // Any missing session low leaves the adverse-move measurement unresolved.
  const path = series.slice(fromIdx + 1, fromIdx + horizon + 1);
  const pathComplete = path.every(bar => Number.isFinite(bar.low) && bar.low > 0);
  const maxAdversePct = pathComplete ? Math.min(0, (Math.min(...path.map(bar => bar.low)) / entry - 1) * 100) : null;
  return {
    grossReturnPct, netReturnPct, maxAdversePct, pathComplete,
    exitDate: series[fromIdx + horizon].date,
    outcomeAfterCosts: netReturnPct === null ? null : netReturnPct > 0 ? 'gain' : netReturnPct < 0 ? 'loss' : 'flat',
  };
}

/**
 * Score a set of signal emissions.
 *
 * @param {Array<{symbol: string, date: string}>} emissions  when the signal fired
 * @param {Object<string, Array<{date,close}>>} seriesBySymbol  price history per symbol
 * @param {Object} [opts]
 * @param {number[]} [opts.horizons]   forward windows in trading days
 * @param {Array<{date,close}>} [opts.benchmark]  series to measure excess against
 * @returns {Object} per-horizon stats: { n, hitRate, medianPct, meanPct,
 *          medianExcessPct, hitRateExcess, unresolved }
 *
 * `hitRate` is the fraction that rose; `hitRateExcess` the fraction that beat
 * the benchmark. When a benchmark is supplied the excess figures are the ones
 * worth reading.
 */
function scoreSignal(emissions, seriesBySymbol, opts = {}) {
  const horizons = opts.horizons || [5, 22];
  const benchmark = opts.benchmark || null;
  const out = {};

  for (const h of horizons) {
    const raw = [];
    const excess = [];
    const net = [];
    const adverse = [];
    let adverseUnresolved = 0;
    let unresolved = 0;

    for (const e of emissions || []) {
      const series = seriesBySymbol?.[e?.symbol];
      const idx = indexOfDate(series, e?.date);
      if (idx < 0) { unresolved++; continue; }

      const result = forwardOutcome(series, idx, h, { entryPrice: e.entryPrice, costModel: e.costModel || opts.costModel });
      if (!result) { unresolved++; continue; }
      const r = result.grossReturnPct;
      raw.push(r);
      if (result.netReturnPct !== null) net.push(result.netReturnPct);
      if (result.maxAdversePct !== null) adverse.push(result.maxAdversePct);
      else adverseUnresolved++;

      if (benchmark) {
        const bIdx = indexOfDate(benchmark, e.date);
        const bR = bIdx >= 0 ? forwardReturn(benchmark, bIdx, h) : null;
        // Only count excess when the benchmark resolves over the same window,
        // otherwise the comparison is against nothing.
        if (bR != null) excess.push(r - bR);
      }
    }

    out[`${h}d`] = {
      n: raw.length,
      unresolved,
      hitRate: raw.length ? raw.filter(r => r > 0).length / raw.length : null,
      medianPct: median(raw),
      meanPct: mean(raw),
      medianExcessPct: excess.length ? median(excess) : null,
      meanExcessPct: excess.length ? mean(excess) : null,
      hitRateExcess: excess.length ? excess.filter(r => r > 0).length / excess.length : null,
      nExcess: excess.length,
      nNet: net.length,
      medianNetPct: median(net),
      meanNetPct: mean(net),
      hitRateNet: net.length ? net.filter(r => r > 0).length / net.length : null,
      outcomesAfterCosts: { gains: net.filter(r => r > 0).length, losses: net.filter(r => r < 0).length, flat: net.filter(r => r === 0).length },
      nAdverse: adverse.length,
      adverseUnresolved,
      medianMaxAdversePct: median(adverse),
      worstMaxAdversePct: adverse.length ? Math.min(...adverse) : null,
    };
  }

  return out;
}

/**
 * A blunt readability helper: turn a horizon's stats into a one-line verdict.
 * Deliberately conservative — below `minN` it refuses to call anything, because
 * a 70% hit rate on seven samples is noise, and presenting it as a result is
 * how a dashboard talks someone into a bad habit.
 */
function summarise(stat, { minN = 20 } = {}) {
  if (!stat || !stat.n) return 'no resolved signals';
  if (stat.n < minN) return `n=${stat.n} — too few to judge`;
  const edge = stat.medianExcessPct;
  if (edge == null) return `n=${stat.n}, median ${stat.medianPct.toFixed(2)}% (no benchmark)`;
  const dir = edge > 0 ? 'beat' : 'lagged';
  return `n=${stat.n}, median ${dir} benchmark by ${Math.abs(edge).toFixed(2)}%`;
}

module.exports = { forwardReturn, forwardOutcome, indexOfDate, scoreSignal, summarise, DEFAULT_COST_MODEL, validateCostModel };
