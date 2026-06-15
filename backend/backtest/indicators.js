// Shared indicator math for the backtester AND the live alert engine.
// computeSuperTrend lives here (moved verbatim from server.js) so backtests and
// live alerts can never drift apart on SuperTrend semantics.
const { EMA, RSI, ATR, ADX } = require('technicalindicators');

// Classic SuperTrend(period, multiplier) — iterative because each bar's bands
// depend on the prior bar's "sticky" final bands and direction. Inputs:
//   candles: full OHLC array (uses high, low, close)
//   atrArr:  output from technicalindicators ATR.calculate (length = candles.length - period)
//   period:  lookback used to align ATR with candles (default 10)
//   mult:    band multiplier (default 3)
// Returns one row per usable bar (starting from index `period` in candles)
// shaped { value, direction: 'BULL'|'BEAR' }. The first row's direction is
// seeded from close vs basic upper band; subsequent rows carry/flip per the
// canonical SuperTrend rules.
function computeSuperTrend(candles, atrArr, period = 10, mult = 3) {
  if (!candles || candles.length <= period || atrArr.length === 0) return [];
  const offset = candles.length - atrArr.length; // ATR lops off first `period` bars
  const out = [];
  let prevFinalUpper = null;
  let prevFinalLower = null;
  let prevDirection = null;
  for (let i = 0; i < atrArr.length; i++) {
    const c = candles[i + offset];
    const prevC = candles[i + offset - 1] || c;
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + mult * atrArr[i];
    const basicLower = hl2 - mult * atrArr[i];

    // Sticky final bands — tighten only in the direction of trend.
    const finalUpper = (prevFinalUpper == null || basicUpper < prevFinalUpper || prevC.close > prevFinalUpper)
      ? basicUpper : prevFinalUpper;
    const finalLower = (prevFinalLower == null || basicLower > prevFinalLower || prevC.close < prevFinalLower)
      ? basicLower : prevFinalLower;

    let direction;
    if (prevDirection == null) {
      // Seed off the very first bar — direction = whichever band the close is above.
      direction = c.close > finalUpper ? 'BULL' : 'BEAR';
    } else if (prevDirection === 'BULL') {
      direction = c.close < finalLower ? 'BEAR' : 'BULL';
    } else {
      direction = c.close > finalUpper ? 'BULL' : 'BEAR';
    }
    const value = direction === 'BULL' ? finalLower : finalUpper;
    out.push({ value, direction });

    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevDirection = direction;
  }
  return out;
}

// Left-pad a series with nulls so result[i] aligns with candles[i].
// technicalindicators returns arrays shorter than the input (warmup lopped off).
function padLeft(arr, totalLen) {
  if (arr.length >= totalLen) return arr.slice(arr.length - totalLen);
  return new Array(totalLen - arr.length).fill(null).concat(arr);
}

// Max of values[i-n .. i-1] (EXCLUDES bar i — matches the "today excluded"
// convention of BREAKOUT_WINDOWS / prior20 in the live alert engine).
// Returns null until a full window exists.
function rollingMax(values, n, i) {
  if (i - n < 0) return null;
  let m = -Infinity;
  for (let j = i - n; j < i; j++) {
    if (values[j] != null && values[j] > m) m = values[j];
  }
  return m === -Infinity ? null : m;
}

function rollingMin(values, n, i) {
  if (i - n < 0) return null;
  let m = Infinity;
  for (let j = i - n; j < i; j++) {
    if (values[j] != null && values[j] < m) m = values[j];
  }
  return m === Infinity ? null : m;
}

// Precompute every series the strategies need, ONCE per stock. All series are
// index-aligned with `candles` (null during warmup). This is what keeps the
// backtest O(n): the bar-walker only ever does array lookups.
function buildSeries(candles, { atrPeriod = 10, atrMult = 3 } = {}) {
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);
  const volumes = candles.map(c => c.volume || 0);
  const dates = candles.map(c => c.date);

  const ema200 = padLeft(EMA.calculate({ period: 200, values: closes }), n);
  const rsi14 = padLeft(RSI.calculate({ period: 14, values: closes }), n);
  const atr14 = padLeft(ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }), n);

  const atrStRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: atrPeriod });
  const supertrend = padLeft(computeSuperTrend(candles, atrStRaw, atrPeriod, atrMult), n);
  const atrSt = padLeft(atrStRaw, n);

  const adxRaw = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
  const adx14 = padLeft(adxRaw.map(r => r.adx), n);

  // Rolling 20-bar average volume over [i-20, i-1] via prefix sums (excludes bar i).
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + volumes[i];
  const vol20avg = new Array(n).fill(null);
  for (let i = 20; i < n; i++) vol20avg[i] = (prefix[i] - prefix[i - 20]) / 20;

  return { candles, closes, highs, lows, opens, volumes, dates, ema200, rsi14, atr14, atrSt, supertrend, adx14, vol20avg };
}

module.exports = { computeSuperTrend, buildSeries, rollingMax, rollingMin, padLeft };
