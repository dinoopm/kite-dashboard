// ─── Signal Engine ───────────────────────────────────────────────
// Pure, UI-agnostic technical-analysis math. Given OHLCV bars it computes the
// moving averages, RSI, and the Buy/Sell crossover signals. No React, no DOM —
// so it's trivially testable and reusable.

// Simple Moving Average. Returns an array aligned to `values` (null until the
// window fills). O(n) via a rolling sum.
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Wilder's RSI. Aligned to `closes` (null during warmup).
export function rsi(closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Moving-average crossover + RSI momentum filter.
//   Buy : fast SMA crosses ABOVE slow SMA (golden cross) AND RSI > 50
//   Sell: fast SMA crosses BELOW slow SMA (death cross)  AND RSI < 50
// Returns the indicator series plus a list of signal events, each carrying the
// exact values that triggered it (for the tooltip).
export function generateSignals(bars, fastPeriod = 10, slowPeriod = 50, rsiPeriod = 14) {
  const closes = bars.map(b => b.close);
  const fast = sma(closes, fastPeriod);
  const slow = sma(closes, slowPeriod);
  const rsiArr = rsi(closes, rsiPeriod);

  const signals = [];
  for (let i = 1; i < bars.length; i++) {
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null || rsiArr[i] == null) continue;

    const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];

    if (crossedUp && rsiArr[i] > 50) {
      signals.push({ index: i, type: 'buy', bar: bars[i], rsi: rsiArr[i], fast: fast[i], slow: slow[i], fastPeriod, slowPeriod });
    } else if (crossedDown && rsiArr[i] < 50) {
      signals.push({ index: i, type: 'sell', bar: bars[i], rsi: rsiArr[i], fast: fast[i], slow: slow[i], fastPeriod, slowPeriod });
    }
  }
  return { fast, slow, rsi: rsiArr, signals };
}
