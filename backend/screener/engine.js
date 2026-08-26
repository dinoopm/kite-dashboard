// Custom screener engine. Computes a flat row of indicator values per stock
// from its daily candles (reusing the backtester's buildSeries so screener
// numbers can never disagree with backtest/alert math), then evaluates
// user-defined conditions against that row. All conditions are ANDed.
const { buildSeries, rollingMax, rollingMin } = require('../backtest/indicators');
const { computeVcpScore } = require('./vcp');
const { squeezeState, MIN_BARS: SQUEEZE_MIN_BARS } = require('./squeeze');
// The BUY half of signal1050 is the registry's detector, not a second copy of
// the rule. See the note above lastCrossoverSignal for why that matters.
const {
  maCrossUp, smaSeries: registrySma, CROSS_FAST, CROSS_SLOW, CONFIRM_WINDOW, VOLUME_THRUST_MULT,
} = require('../signals/registry');

// Field catalog — drives both the UI's condition builder (dropdowns, operator
// choices, value inputs) and server-side validation. `group` is only a UI hint.
const SCREENER_FIELDS = [
  { key: 'price',       label: 'Price (₹)',                type: 'number', group: 'Price' },
  { key: 'change1D',    label: '1-day change %',           type: 'number', group: 'Price' },
  { key: 'change1W',    label: '1-week change %',          type: 'number', group: 'Price' },
  { key: 'ret1M',       label: '1-month return %',         type: 'number', group: 'Returns' },
  { key: 'ret3M',       label: '3-month return %',         type: 'number', group: 'Returns' },
  { key: 'ret6M',       label: '6-month return %',         type: 'number', group: 'Returns' },
  { key: 'ret1Y',       label: '1-year return %',          type: 'number', group: 'Returns' },
  { key: 'rsi14',       label: 'RSI (14)',                 type: 'number', group: 'Momentum' },
  { key: 'adx14',       label: 'ADX (14)',                 type: 'number', group: 'Momentum' },
  { key: 'volSurge',    label: 'Volume ÷ 20d avg',         type: 'number', group: 'Volume' },
  { key: 'atrPct',      label: 'ATR(14) % of price',       type: 'number', group: 'Volatility' },
  { key: 'pctVsSma20',  label: 'Price vs SMA20 %',         type: 'number', group: 'Trend' },
  { key: 'pctVsSma50',  label: 'Price vs SMA50 %',         type: 'number', group: 'Trend' },
  { key: 'pctVsSma200', label: 'Price vs SMA200 %',        type: 'number', group: 'Trend' },
  { key: 'pctVsEma200', label: 'Price vs EMA200 %',        type: 'number', group: 'Trend' },
  { key: 'dist52wHigh', label: 'Distance from 52w high %', type: 'number', group: 'Levels' },
  // How WIDE the last year's range was, as a % of its low: (52w high - 52w low)
  // / 52w low. A stock that spent the year between 400 and 500 scores 25; one
  // that tripled scores 200. Low values are the "gone nowhere for a year" base
  // a breakout can emerge from, which distance-from-high alone cannot express —
  // a stock 2% off its high has the same dist52wHigh whether it drifted
  // sideways all year or ran 300%.
  { key: 'range52wPct', label: '52-week range width %',      type: 'number', group: 'Levels' },
  // The same width over the last quarter divided by the year's. Only meaningful
  // ALONGSIDE a narrow range52wPct: a stock that tripled also scores ~0.14 here,
  // not because it is coiling but because one quarter of a huge run is small
  // next to the whole run. Pair the two, or this reads a runaway trend as
  // compression.
  { key: 'rangeCompression', label: '3m range ÷ 12m range',  type: 'number', group: 'Levels' },
  // Signed % from the prior 20-day high: negative = still below (approaching a
  // breakout), >= 0 = already above (breaking out). Screen "within 2% of
  // breakout" with `dist20dHigh >= -2`.
  { key: 'dist20dHigh', label: 'Distance from 20d high %', type: 'number', group: 'Levels' },
  { key: 'supertrend',  label: 'SuperTrend (10,3)',        type: 'enum', enumValues: ['BULL', 'BEAR'], group: 'Trend' },
  // Mirrors the Signals tab engine (frontend/src/lib/signalEngine.js):
  // BUY = SMA10 crosses above SMA50 with RSI > 50; SELL = crosses below with
  // RSI < 50. signal1050 = the most recent such event's type.
  { key: 'signal1050',    label: 'SMA 10/50 signal',            type: 'enum', enumValues: ['BUY', 'SELL', 'NONE'], group: 'Signals' },
  { key: 'signal1050Age', label: 'Bars since 10/50 signal',     type: 'number', group: 'Signals' },
  // Was there demand behind the buy? A volume thrust (>=2x the trailing
  // 20-session average on an up close) landing on the cross bar or in the 5
  // sessions before it. This is the split the registry already records as
  // ma_cross_volume vs ma_cross_quiet, surfaced so the screener can ask for it.
  //
  // NOT the same question as volSurge, which is today's volume against its
  // average — a stock that crossed six weeks ago on huge volume and is quiet
  // now has a low volSurge and a confirmed cross. One describes today, the
  // other describes the buy.
  //
  // Null unless the latest signal is a BUY: on a SELL or a stock that has never
  // crossed there is no cross for the question to be about, and null never
  // matches a condition, so `is NO` cannot sweep those in.
  { key: 'crossVolConfirmed', label: 'Buy volume-confirmed', type: 'enum', enumValues: ['YES', 'NO'], group: 'Signals' },
  // Volume ÷ 20-session average ON THE CROSS BAR itself — the figure recorded
  // with the emission, so a screened row and its scorecard entry agree.
  { key: 'crossVolRatio', label: 'Volume × at the cross', type: 'number', group: 'Signals' },
  { key: 'smaCross',    label: 'SMA 50/200 state',         type: 'enum', enumValues: ['GOLDEN', 'DEATH'], group: 'Trend' },
  { key: 'breakout20d', label: 'Above prior 20d high',     type: 'enum', enumValues: ['YES', 'NO'], group: 'Levels' },
  // Bollinger bandwidth and the squeeze. `bbSqueeze` is a STATE — true for
  // every bar the compression lasts — which is the right question for a
  // screener. The transition is a separate thing, recorded as a signal.
  { key: 'bbBandwidth', label: 'Bollinger bandwidth %',    type: 'number', group: 'Volatility' },
  { key: 'bbSqueeze',   label: 'BB squeeze (30d low)',     type: 'enum', enumValues: ['YES', 'NO'], group: 'Volatility' },
  { key: 'bbSqueezeAge', label: 'Bars in squeeze',         type: 'number', group: 'Volatility' },
  { key: 'breakout55d', label: 'Above prior 55d high',     type: 'enum', enumValues: ['YES', 'NO'], group: 'Levels' },
  { key: 'vcpScore', label: 'VCP score (0-100)', type: 'number', group: 'Patterns' },
  { key: 'vcpSetup', label: 'VCP setup',         type: 'enum', enumValues: ['YES', 'NO'], group: 'Patterns' },
];

const FIELD_BY_KEY = Object.fromEntries(SCREENER_FIELDS.map(f => [f.key, f]));
const NUMBER_OPS = ['gt', 'gte', 'lt', 'lte'];
const ENUM_OPS = ['is', 'isnot'];

function lastSma(closes, n) {
  if (closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

/**
 * Most recent SMA 10/50 crossover signal, with the Signals tab's RSI momentum
 * filter: BUY on golden cross + RSI > 50, SELL on death cross + RSI < 50.
 *
 * The BUY half calls the registry's `maCrossUp` rather than re-deriving the
 * rule here. This file used to carry its own copy, and the two had already
 * drifted: the registry (like the chart) drops a cross that fires below the
 * 20-bar mean right after a sharp fall — the dead-cat bounce the chart draws as
 * a hollow DC and deliberately does not count as a buy — and this copy did not.
 *
 * That divergence was latent rather than active: over 1,591 crossings in a
 * synthetic sweep the two rules agreed every time, because a golden cross
 * almost never fires with price under its own 20-bar mean. Latent is still
 * wrong. `ma_cross_up` is what the scorecard measures and what the badge beside
 * these results reports, so a screener hit that the scorecard would have
 * excluded is a row claiming a track record built without it.
 *
 * Returns the detector's own metadata for the buy, so a screened row and its
 * recorded emission carry identical numbers.
 */
function lastCrossoverSignal(S) {
  const closes = S.closes;
  const fast = registrySma(S, CROSS_FAST);
  const slow = registrySma(S, CROSS_SLOW);
  let signal = null, signalIdx = null, buy = null;
  for (let i = 1; i < closes.length; i++) {
    const hit = maCrossUp(S, i);
    if (hit) { signal = 'BUY'; signalIdx = i; buy = hit; continue; }
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null || S.rsi14[i] == null) continue;
    // No registry entry scores the sell side yet, so it stays local. When one
    // lands, it replaces this branch the same way the buy branch was replaced.
    if (fast[i - 1] >= slow[i - 1] && fast[i] < slow[i] && S.rsi14[i] < 50) {
      signal = 'SELL'; signalIdx = i; buy = null;
    }
  }
  return { signal, barsAgo: signalIdx != null ? closes.length - 1 - signalIdx : null, buy };
}

const pctVs = (price, ref) => (ref != null && ref > 0 ? +(((price - ref) / ref) * 100).toFixed(2) : null);
const retOver = (closes, bars) => {
  const i = closes.length - 1 - bars;
  return i >= 0 && closes[i] > 0 ? +(((closes[closes.length - 1] / closes[i]) - 1) * 100).toFixed(2) : null;
};

// One pass per stock — ~1-2ms over a 4-year series.
function computeScreenerRow(candles) {
  const S = buildSeries(candles);
  const n = candles.length;
  const last = n - 1;
  const closes = S.closes;
  const price = closes[last];

  const sma20 = lastSma(closes, 20);
  const sma50 = lastSma(closes, 50);
  const sma200 = lastSma(closes, 200);
  const ema200 = S.ema200[last];
  const atr = S.atr14[last];
  const vol20 = S.vol20avg[last];

  const hi252 = rollingMax(S.highs, Math.min(252, last), last);
  const lo252 = rollingMin(S.lows, Math.min(252, last), last);
  const hi66 = rollingMax(S.highs, Math.min(66, last), last);
  const lo66 = rollingMin(S.lows, Math.min(66, last), last);
  const width = (hi, lo) => (hi != null && lo != null && lo > 0 ? (hi - lo) / lo : null);
  const w252 = width(hi252, lo252);
  const w66 = width(hi66, lo66);
  const hi20 = rollingMax(S.highs, Math.min(20, last), last);
  const hi55 = rollingMax(S.highs, Math.min(55, last), last);

  return {
    price: +price.toFixed(2),
    change1D: last >= 1 && closes[last - 1] > 0 ? +(((price / closes[last - 1]) - 1) * 100).toFixed(2) : null,
    change1W: retOver(closes, 5),
    ret1M: retOver(closes, 22),
    ret3M: retOver(closes, 66),
    ret6M: retOver(closes, 132),
    ret1Y: retOver(closes, 252),
    rsi14: S.rsi14[last] != null ? +S.rsi14[last].toFixed(1) : null,
    adx14: S.adx14[last] != null ? +S.adx14[last].toFixed(1) : null,
    volSurge: vol20 > 0 ? +((S.volumes[last] || 0) / vol20).toFixed(2) : null,
    atrPct: atr != null && price > 0 ? +((atr / price) * 100).toFixed(2) : null,
    pctVsSma20: pctVs(price, sma20),
    pctVsSma50: pctVs(price, sma50),
    pctVsSma200: pctVs(price, sma200),
    pctVsEma200: pctVs(price, ema200),
    dist52wHigh: hi252 != null && hi252 > 0 ? +(((price - hi252) / hi252) * 100).toFixed(2) : null,
    dist20dHigh: hi20 != null && hi20 > 0 ? +(((price - hi20) / hi20) * 100).toFixed(2) : null,
    range52wPct: w252 != null ? +(w252 * 100).toFixed(2) : null,
    rangeCompression: (w252 != null && w252 > 0 && w66 != null) ? +(w66 / w252).toFixed(3) : null,
    supertrend: S.supertrend[last]?.direction ?? null,
    ...(() => {
      const { signal, barsAgo, buy } = lastCrossoverSignal(S);
      return {
        signal1050: signal ?? 'NONE',
        signal1050Age: barsAgo,
        crossVolConfirmed: buy ? (buy.confirmed ? 'YES' : 'NO') : null,
        crossVolRatio: buy ? buy.volRatio : null,
      };
    })(),
    smaCross: (sma50 != null && sma200 != null) ? (sma50 > sma200 ? 'GOLDEN' : 'DEATH') : null,
    breakout20d: hi20 != null ? (price > hi20 ? 'YES' : 'NO') : null,
    breakout55d: hi55 != null ? (price > hi55 ? 'YES' : 'NO') : null,
    ...(() => {
      const v = computeVcpScore({ closes: S.closes, highs: S.highs, lows: S.lows, volumes: S.volumes, atr14: S.atr14 });
      return { vcpScore: v.vcpScore, vcpSetup: v.vcpSetup };
    })(),
    // Null rather than 'NO' when there is not enough history: a stock that
    // cannot be judged is not a stock that is judged negatively, and a
    // screener condition on 'NO' should not silently sweep it in.
    ...(() => {
      if (n < SQUEEZE_MIN_BARS) return { bbBandwidth: null, bbSqueeze: null, bbSqueezeAge: null };
      const q = squeezeState(closes);
      return {
        bbBandwidth: q.bandwidth == null ? null : +q.bandwidth.toFixed(2),
        bbSqueeze: q.squeezed == null ? null : (q.squeezed ? 'YES' : 'NO'),
        bbSqueezeAge: q.barsInSqueeze,
      };
    })(),
  };
}

// Throws with a user-readable message on a malformed condition.
function validateConditions(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error('At least one condition is required');
  }
  if (conditions.length > 12) throw new Error('Too many conditions (max 12)');
  for (const c of conditions) {
    const f = FIELD_BY_KEY[c.field];
    if (!f) throw new Error(`Unknown field "${c.field}"`);
    if (f.type === 'number') {
      if (!NUMBER_OPS.includes(c.op)) throw new Error(`Invalid operator "${c.op}" for ${f.label}`);
      if (!Number.isFinite(Number(c.value))) throw new Error(`${f.label}: value must be a number`);
    } else {
      if (!ENUM_OPS.includes(c.op)) throw new Error(`Invalid operator "${c.op}" for ${f.label}`);
      if (!f.enumValues.includes(c.value)) throw new Error(`${f.label}: value must be one of ${f.enumValues.join(', ')}`);
    }
  }
}

// All conditions ANDed; a null field value never matches (insufficient history).
function evaluateConditions(values, conditions) {
  for (const c of conditions) {
    const v = values[c.field];
    if (v == null) return false;
    const target = FIELD_BY_KEY[c.field].type === 'number' ? Number(c.value) : c.value;
    switch (c.op) {
      case 'gt': if (!(v > target)) return false; break;
      case 'gte': if (!(v >= target)) return false; break;
      case 'lt': if (!(v < target)) return false; break;
      case 'lte': if (!(v <= target)) return false; break;
      case 'is': if (v !== target) return false; break;
      case 'isnot': if (v === target) return false; break;
      default: return false;
    }
  }
  return true;
}

module.exports = { SCREENER_FIELDS, computeScreenerRow, validateConditions, evaluateConditions };
