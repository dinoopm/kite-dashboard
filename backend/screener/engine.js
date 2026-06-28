// Custom screener engine. Computes a flat row of indicator values per stock
// from its daily candles (reusing the backtester's buildSeries so screener
// numbers can never disagree with backtest/alert math), then evaluates
// user-defined conditions against that row. All conditions are ANDed.
const { buildSeries, rollingMax } = require('../backtest/indicators');

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
  { key: 'smaCross',    label: 'SMA 50/200 state',         type: 'enum', enumValues: ['GOLDEN', 'DEATH'], group: 'Trend' },
  { key: 'breakout20d', label: 'Above prior 20d high',     type: 'enum', enumValues: ['YES', 'NO'], group: 'Levels' },
  { key: 'breakout55d', label: 'Above prior 55d high',     type: 'enum', enumValues: ['YES', 'NO'], group: 'Levels' },
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

// Full SMA series via rolling sum (null during warmup) — same alignment as
// the frontend signalEngine's sma().
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Most recent SMA fast/slow crossover signal, with the same RSI momentum
// filter as the Signals tab: BUY on golden cross + RSI > 50, SELL on death
// cross + RSI < 50. Returns { signal: 'BUY'|'SELL'|null, barsAgo }.
function lastCrossoverSignal(closes, rsiArr, fastPeriod = 10, slowPeriod = 50) {
  const fast = smaSeries(closes, fastPeriod);
  const slow = smaSeries(closes, slowPeriod);
  let signal = null;
  let signalIdx = null;
  for (let i = 1; i < closes.length; i++) {
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null || rsiArr[i] == null) continue;
    const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
    if (crossedUp && rsiArr[i] > 50) { signal = 'BUY'; signalIdx = i; }
    else if (crossedDown && rsiArr[i] < 50) { signal = 'SELL'; signalIdx = i; }
  }
  return { signal, barsAgo: signalIdx != null ? closes.length - 1 - signalIdx : null };
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
    supertrend: S.supertrend[last]?.direction ?? null,
    ...(() => {
      const { signal, barsAgo } = lastCrossoverSignal(closes, S.rsi14, 10, 50);
      return { signal1050: signal ?? 'NONE', signal1050Age: barsAgo };
    })(),
    smaCross: (sma50 != null && sma200 != null) ? (sma50 > sma200 ? 'GOLDEN' : 'DEATH') : null,
    breakout20d: hi20 != null ? (price > hi20 ? 'YES' : 'NO') : null,
    breakout55d: hi55 != null ? (price > hi55 ? 'YES' : 'NO') : null,
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
