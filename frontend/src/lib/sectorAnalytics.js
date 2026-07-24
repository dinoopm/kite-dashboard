// Pure analytics shared by the India (SectorDetail) and US (UsSectorDetail)
// sector drill-downs. Those two pages are near-copies that differ only in
// currency, benchmark and API prefix, so every function here was previously
// duplicated verbatim in both — and drifted: the Hidden Leaders relative-
// strength gate had to be fixed twice, once per file. Keeping the computation
// in one place is what stops that recurring.
//
// Everything below is a pure function of its arguments (no fetches, no React),
// which is what makes it unit-testable — see sectorAnalytics.test.js.

const RSI_MULT_SEVERE_OVERBOUGHT = 0.85;
const RSI_MULT_OVERBOUGHT = 0.92;
const RSI_MULT_OVERSOLD = 1.08;
const RSI_MULT_SEVERE_OVERSOLD = 1.15;

// Momentum blend weights (1W / 1M / 3M).
export const W_1W = 0.20, W_1M = 0.50, W_3M = 0.30;

// Trailing returns for a sorted daily series, anchored to midnight in
// `timeZone`. Defaults to Asia/Kolkata because both pages were written against
// the India market; the US page inherited that anchor when it was copied. Pass
// an explicit zone to change it — doing so shifts the window boundaries and
// therefore the reported percentages, so it is deliberately not automatic.
export function calculateHistoricalReturns(series, currentPrice, timeZone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  const anchor = new Date(`${y}-${m}-${d}T00:00:00Z`);

  const dates = series.map(c => new Date(c.date).getTime());

  // Nearest close to a target date, via binary search on the sorted series.
  const getPriceAtDate = (targetDate) => {
    if (dates.length === 0) return 0;
    const target = targetDate.getTime();
    let lo = 0, hi = dates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(dates[lo - 1] - target) <= Math.abs(dates[lo] - target)) {
      return series[lo - 1].close;
    }
    return series[lo].close;
  };

  const d1W = new Date(anchor); d1W.setDate(anchor.getDate() - 7);
  const d1M = new Date(anchor); d1M.setMonth(anchor.getMonth() - 1);
  const d3M = new Date(anchor); d3M.setMonth(anchor.getMonth() - 3);
  const d6M = new Date(anchor); d6M.setMonth(anchor.getMonth() - 6);
  const d1Y = new Date(anchor); d1Y.setFullYear(anchor.getFullYear() - 1);
  const d2Y = new Date(anchor); d2Y.setFullYear(anchor.getFullYear() - 2);
  const d3Y = new Date(anchor); d3Y.setFullYear(anchor.getFullYear() - 3);

  const calcPct = (oldPrice) => {
    if (!oldPrice || oldPrice === 0) return 0;
    return ((currentPrice - oldPrice) / oldPrice) * 100;
  };

  return {
    '1W': calcPct(getPriceAtDate(d1W)),
    '1M': calcPct(getPriceAtDate(d1M)),
    '3M': calcPct(getPriceAtDate(d3M)),
    '6M': calcPct(getPriceAtDate(d6M)),
    '1Y': calcPct(getPriceAtDate(d1Y)),
    '2Y': calcPct(getPriceAtDate(d2Y)),
    '3Y': calcPct(getPriceAtDate(d3Y)),
  };
}

// Wilder-smoothed RSI(14) through `endIdx` of the series. Returns null when
// there aren't enough candles to seed it. Taking an explicit end index is what
// lets the ranking pipeline ask for "RSI as of N days ago" without slicing a
// copy at every call site.
export function rsi14At(history, endIdx) {
  if (!history || endIdx < 14) return null;
  const closes = history.slice(0, endIdx + 1).map(c => c.close);
  if (closes.length < 15) return null;
  const changes = closes.slice(1).map((v, i) => v - closes[i]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < 14; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= 14;
  avgLoss /= 14;
  for (let i = 14; i < changes.length; i++) {
    avgGain = (avgGain * 13 + (changes[i] > 0 ? changes[i] : 0)) / 14;
    avgLoss = (avgLoss * 13 + (changes[i] < 0 ? Math.abs(changes[i]) : 0)) / 14;
  }
  // With no down-closes the ratio would be infinite; cap it so RSI reads 99.
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

// RSI(14) at the latest candle.
export function computeRsi14(sorted) {
  if (!sorted || sorted.length < 15) return null;
  return rsi14At(sorted, sorted.length - 1);
}

// Momentum haircut/boost by RSI — overbought names are discounted, oversold
// ones get credit, so the ranking doesn't just chase the most extended stock.
export function rsiMultiplierFor(rsi14) {
  if (rsi14 == null) return 1.0;
  if (rsi14 >= 80) return RSI_MULT_SEVERE_OVERBOUGHT;
  if (rsi14 >= 70) return RSI_MULT_OVERBOUGHT;
  if (rsi14 <= 20) return RSI_MULT_SEVERE_OVERSOLD;
  if (rsi14 <= 30) return RSI_MULT_OVERSOLD;
  return 1.0;
}

export function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Collapse a sorted daily series into weekly buckets keyed by that week's
// Friday, tracking the week's high. Used for Higher-High / Lower-High
// structure comparisons.
export function resampleToWeeklyHighs(sortedDailyData) {
  if (!sortedDailyData || sortedDailyData.length === 0) return [];
  const weeks = {};
  for (const c of sortedDailyData) {
    const d = new Date(c.date);
    const day = d.getDay();
    const diff = 5 - day;
    const friday = new Date(d);
    friday.setDate(d.getDate() + diff);
    const weekKey = friday.toISOString().split('T')[0];
    if (!weeks[weekKey]) weeks[weekKey] = { weekKey, high: c.high ?? c.close, close: c.close, date: c.date };
    else {
      const h = c.high ?? c.close;
      if (h > weeks[weekKey].high) weeks[weekKey].high = h;
      weeks[weekKey].close = c.close;
      weeks[weekKey].date = c.date;
    }
  }
  return Object.values(weeks).sort((a, b) => a.weekKey.localeCompare(b.weekKey));
}

// Percentile momentum score (1..99) for a set of rows carrying a `history`
// array, anchored `asOfShift` candles back from the latest close. Blends the
// 1W/1M/3M returns, applies the RSI haircut, then ranks the survivors against
// each other — so the score is relative to the cohort, not absolute.
//
// Called twice by the indices pages: once for today (asOfShift = 0) and once
// for a past anchor, and the difference between the two ranks is the
// rank-change chip on the Momentum Ranking chart.
//
// Rows without enough history to cover 3M + the shift are skipped rather than
// scored against a shorter window, which would flatter them.
export function computeScoreMap(rows, asOfShift = 0) {
  const W = [5, 22, 66]; // 1W, 1M, 3M in trading days
  const items = [];
  for (const r of rows) {
    const h = r.history;
    // Need 3M return + the lookback shift + 1 anchor candle of history.
    if (!h || h.length < 66 + asOfShift + 1) continue;
    const anchorIdx = h.length - 1 - asOfShift;
    const anchor = h[anchorIdx]?.close;
    if (anchor == null) continue;
    const returns = W.map(w => {
      const past = h[anchorIdx - w]?.close;
      return past ? ((anchor - past) / past) * 100 : null;
    });
    if (returns.some(v => v === null)) continue;
    const [r1w, r1m, r3m] = returns;
    const raw = r1w * W_1W + r1m * W_1M + r3m * W_3M;
    const adjusted = raw * rsiMultiplierFor(rsi14At(h, anchorIdx));
    items.push({ id: r.id, adjusted });
  }
  if (items.length === 0) return {};
  const sortedAsc = [...items].sort((a, b) => a.adjusted - b.adjusted);
  const n = sortedAsc.length;
  const out = {};
  sortedAsc.forEach((s, rank) => {
    out[s.id] = n === 1 ? 50 : Math.round(1 + (rank / (n - 1)) * 99);
  });
  return out;
}

// Stocks making Higher Highs while their sector makes a Lower High — a
// relative-strength divergence.
//
// Returns null when there isn't enough history to judge (callers render a
// loading state), { active: false } when the sector is NOT making a Lower High
// (the signal simply doesn't apply), and { active: true, leaders } otherwise.
//
// The rsVsSector > 0 gate matters: a Higher High on its own can be a single
// spike from four weeks ago on a stock that has since rolled over. Without the
// gate a name down 10% on the month, underperforming its sector by 9%, still
// showed up as a "leader".
export function findHiddenLeaders(sectorHistory, stocks) {
  if (!sectorHistory || sectorHistory.length < 8) return null;
  const sectorWeekly = resampleToWeeklyHighs(sectorHistory);
  if (sectorWeekly.length < 8) return null;

  const recentSector = Math.max(...sectorWeekly.slice(-4).map(w => w.high));
  const priorSector = Math.max(...sectorWeekly.slice(-8, -4).map(w => w.high));
  if (recentSector >= priorSector) return { active: false, leaders: [] };

  const leaders = (stocks || []).filter(s => {
    if (!s.weeklyHighs || s.weeklyHighs.length < 8) return false;
    const recentStock = Math.max(...s.weeklyHighs.slice(-4).map(w => w.high));
    const priorStock = Math.max(...s.weeklyHighs.slice(-8, -4).map(w => w.high));
    const isHigherHigh = recentStock > priorStock;
    const outperformsSector = s.rsVsSector != null && s.rsVsSector > 0;
    return isHigherHigh && outperformsSector;
  });

  return { active: true, leaders };
}
