// ─── Does a year-long base actually predict anything? ────────────────────────
//
// The screener gained a "range-bound for a year, then a fresh BUY" preset. The
// pattern is folklore-adjacent — Darvas boxes, cup-and-handle, Minervini bases
// — and this app cannot score it on Indian data until roughly mid-2027, because
// nse_bhavcopy holds ~82 sessions and one firing needs 252 before it.
//
// US history is long enough today, so the question gets answered now rather
// than after a year of acting on an untested screen. Same shape as
// expiryStudy.js: an event set, a benchmark, and base rates for both.
//
// Two design choices that decide whether this is evidence or decoration:
//
// 1. THE SWEEP. The preset's thresholds (45% range, ±20% return, 10 bars) were
//    picked by eye. A single result at one setting proves nothing — pick
//    another and get another number. So every setting in a grid is reported,
//    and the honest read is whether the effect survives the grid or only
//    appears at one convenient corner.
//
// 2. CAUSALITY. Detection at bar i uses bars <= i only, and the forward return
//    starts at i's close. Nothing looks ahead.

const YahooFinance = require('yahoo-finance2').default;

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const BENCHMARK = '^GSPC';
const HISTORY_FROM = '2014-01-01';
const HORIZONS = [5, 10, 22];
const MIN_N = 30;
const BASE_BARS = 252;      // "about a year"
const FETCH_GAP_MS = 120;   // be polite to Yahoo

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const variance = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};
/** One-sample t against zero: is the mean excess distinguishable from none? */
function tAgainstZero(xs) {
  if (xs.length < 2) return null;
  const sd = Math.sqrt(variance(xs));
  if (!sd) return null;
  return mean(xs) / (sd / Math.sqrt(xs.length));
}

const sma = (values, period, i) => {
  if (i < period - 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) s += values[k];
  return s / period;
};

/** Wilder RSI series, aligned to `closes` (null during warmup). */
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) {
        gain /= period; loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

/**
 * Every bar where the preset's conditions become true, for one symbol.
 *
 * Fires on the TRANSITION — the bar the fast SMA crosses above the slow one —
 * not on every bar the state holds, which would turn one setup into forty rows.
 */
function findFirings(bars, { maxRangePct, maxAbsRet1Y }) {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const rsi = rsiSeries(closes);
  const out = [];

  for (let i = BASE_BARS; i < bars.length; i++) {
    const fast = sma(closes, 10, i), slow = sma(closes, 50, i);
    const fastPrev = sma(closes, 10, i - 1), slowPrev = sma(closes, 50, i - 1);
    if (fast == null || slow == null || fastPrev == null || slowPrev == null) continue;
    // The crossover itself, with the same RSI filter the screener uses.
    if (!(fastPrev <= slowPrev && fast > slow)) continue;
    if (!(rsi[i] > 50)) continue;

    // The base: the 252 bars BEFORE this one, so the breakout bar cannot
    // widen the range it is supposed to be breaking out of.
    let hi = -Infinity, lo = Infinity;
    for (let k = i - BASE_BARS; k < i; k++) {
      if (highs[k] > hi) hi = highs[k];
      if (lows[k] < lo) lo = lows[k];
    }
    if (!(lo > 0)) continue;
    const rangePct = ((hi - lo) / lo) * 100;
    if (rangePct > maxRangePct) continue;

    const past = closes[i - BASE_BARS];
    if (!(past > 0)) continue;
    const ret1Y = ((closes[i] / past) - 1) * 100;
    if (Math.abs(ret1Y) > maxAbsRet1Y) continue;

    out.push({ index: i, date: bars[i].date, rangePct, ret1Y });
  }
  return out;
}

const fwd = (closes, i, h) =>
  (i + h < closes.length && closes[i] > 0 ? ((closes[i + h] / closes[i]) - 1) * 100 : null);

async function fetchBars(symbol, from) {
  const c = await yf.chart(symbol, { period1: from, interval: '1d' }, { validateResult: false });
  return (c.quotes || [])
    .filter(q => q.close != null && q.high != null && q.low != null)
    .map(q => ({ date: q.date.toISOString().slice(0, 10), high: q.high, low: q.low, close: q.close }));
}

/**
 * Run the study across a symbol list.
 *
 * @param symbols   tickers to scan
 * @param grid      threshold combinations to sweep
 */
async function runBaseBreakoutStudy({ symbols, from = HISTORY_FROM, grid = null, onProgress = null } = {}) {
  if (!symbols?.length) throw new Error('No symbols supplied');

  const benchBars = await fetchBars(BENCHMARK, from);
  const benchClose = new Map(benchBars.map(b => [b.date, b.close]));
  const benchIdx = new Map(benchBars.map((b, i) => [b.date, i]));
  const benchCloses = benchBars.map(b => b.close);

  const settings = grid || [
    { maxRangePct: 30, maxAbsRet1Y: 15 },
    { maxRangePct: 45, maxAbsRet1Y: 20 },   // the preset's own setting
    { maxRangePct: 60, maxAbsRet1Y: 25 },
    { maxRangePct: 80, maxAbsRet1Y: 30 },
  ];

  // symbol -> bars, fetched once and reused across every grid point.
  const barsBySymbol = new Map();
  let fetched = 0, failed = 0;
  for (const sym of symbols) {
    try {
      const b = await fetchBars(sym, from);
      if (b.length > BASE_BARS + Math.max(...HORIZONS)) barsBySymbol.set(sym, b);
      fetched++;
    } catch { failed++; }
    if (onProgress && fetched % 25 === 0) onProgress({ fetched, failed, total: symbols.length });
    await new Promise(r => setTimeout(r, FETCH_GAP_MS));
  }

  const results = [];
  for (const setting of settings) {
    const excess = { }, raw = { };
    for (const h of HORIZONS) { excess[h] = []; raw[h] = []; }
    let firings = 0;
    const symbolsFiring = new Set();

    for (const [sym, bars] of barsBySymbol) {
      const closes = bars.map(b => b.close);
      for (const f of findFirings(bars, setting)) {
        firings++;
        symbolsFiring.add(sym);
        const bi = benchIdx.get(f.date);
        for (const h of HORIZONS) {
          const r = fwd(closes, f.index, h);
          if (r == null) continue;
          raw[h].push(r);
          // Excess only when the benchmark resolves over the SAME window;
          // otherwise the comparison is against nothing.
          const br = bi != null ? fwd(benchCloses, bi, h) : null;
          if (br != null) excess[h].push(r - br);
        }
      }
    }

    results.push({
      setting,
      firings,
      symbols: symbolsFiring.size,
      horizons: HORIZONS.map(h => {
        const ex = excess[h];
        const t = tAgainstZero(ex);
        return {
          horizon: `${h}d`,
          n: ex.length,
          medianExcessPct: median(ex) == null ? null : +median(ex).toFixed(3),
          meanExcessPct: mean(ex) == null ? null : +mean(ex).toFixed(3),
          medianRawPct: median(raw[h]) == null ? null : +median(raw[h]).toFixed(3),
          hitRateExcessPct: ex.length ? +((ex.filter(v => v > 0).length / ex.length) * 100).toFixed(1) : null,
          tStat: t == null ? null : +t.toFixed(2),
          underSampled: ex.length < MIN_N,
          verdict: !ex.length ? 'no firings'
            : ex.length < MIN_N ? `n=${ex.length} — too few to judge`
            : (t == null || Math.abs(t) < 2)
              ? `${median(ex) >= 0 ? '+' : ''}${median(ex).toFixed(2)}% median excess, not distinguishable from noise (t=${t ?? '—'}, n=${ex.length})`
              : `${median(ex) >= 0 ? '+' : ''}${median(ex).toFixed(2)}% median excess (t=${t}, n=${ex.length})`,
        };
      }),
    });
  }

  return {
    benchmark: BENCHMARK,
    period: { from: benchBars[0]?.date, to: benchBars[benchBars.length - 1]?.date },
    universe: { requested: symbols.length, usable: barsBySymbol.size, failed },
    baseBars: BASE_BARS,
    minN: MIN_N,
    results,
    caveats: [
      'Survivorship bias: the universe is today\'s index members, so companies that were delisted or dropped never appear. That biases every long-horizon US backtest upward, this one included.',
      'Firings cluster in time — many stocks break out of bases in the same month for the same market-wide reason — so n overstates how much independent evidence there is.',
      'Entry at the firing day close; costs, slippage and liquidity are not modeled.',
      'Excess is over the index. In a decade-long bull market raw return flatters everything, which is why raw is shown but not used for the verdict.',
      'The grid is reported in full on purpose. A result that appears at one threshold and vanishes at the neighbours is a property of the threshold, not of the market.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runBaseBreakoutStudy, findFirings, rsiSeries, tAgainstZero, BASE_BARS, MIN_N };
