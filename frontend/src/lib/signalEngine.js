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

// How far, and over how long, counts as the drop a dead cat bounces out of.
// Module scope because two rules read them — the crossover guard and the
// standalone bounce signal — and they must never drift apart, nor apart from
// DROP_LOOKBACK / DROP_PCT in backend/signals/registry.js.
export const DROP_LOOKBACK = 10;
export const DROP_PCT = 0.10;

// Moving-average crossover + RSI momentum filter.
//   Buy : fast SMA crosses ABOVE slow SMA (golden cross) AND RSI > 50
//   Sell: fast SMA crosses BELOW slow SMA (death cross)  AND RSI < 50
// Returns the indicator series plus a list of signal events, each carrying the
// exact values that triggered it (for the tooltip).
// `bbPeriod` is the Bollinger middle-band length (SMA basis, default 20) used
// only for the dead-cat-bounce guard below.
export function generateSignals(bars, fastPeriod = 10, slowPeriod = 50, rsiPeriod = 14, bbPeriod = 20) {
  const closes = bars.map(b => b.close);
  const fast = sma(closes, fastPeriod);
  const slow = sma(closes, slowPeriod);
  const mid = sma(closes, bbPeriod); // Bollinger middle band (the SMA basis)
  const rsiArr = rsi(closes, rsiPeriod);

  // Sharp-drop detector: a fall of ≥ DROP_PCT from the highest close over the
  // prior DROP_LOOKBACK bars — i.e. a recent steep decline that a bounce would
  // be retracing.
  const sharpDropAt = (i) => {
    let peak = -Infinity;
    for (let j = Math.max(0, i - DROP_LOOKBACK); j <= i; j++) peak = Math.max(peak, closes[j]);
    return peak > 0 && (peak - closes[i]) / peak >= DROP_PCT;
  };

  const signals = [];
  // Golden crosses that happened but failed the RSI > 50 gate.
  //
  // Returned SEPARATELY, never mixed into `signals`. Two reasons, and the
  // second is the load-bearing one. They are not signals — the rule rejected
  // them — so filing them alongside buys would be a category error. And
  // Instrument.jsx / UsInstrument.jsx both render a signal as `type === 'buy'
  // ? BUY : SELL`, so anything unfamiliar in that array is painted as a red
  // sell marker. A near-miss shown as a sell is worse than showing nothing.
  //
  // Buy side only. The sell rule has a symmetric near-miss (a death cross with
  // RSI >= 50) but the chart's quality furniture — the dead-cat tally, the
  // volume-confirmation chips — is all buy-side, and adding sell markers nobody
  // asked for would crowd the chart to answer a question nobody asked.
  const nearMisses = [];
  for (let i = 1; i < bars.length; i++) {
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null || rsiArr[i] == null) continue;

    const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];

    if (crossedUp && rsiArr[i] > 50) {
      // Dead-cat-bounce guard: a golden-cross buy while the close is still BELOW
      // the middle band right after a sharp drop is usually a failed bounce in a
      // downtrend, not a real reversal. Flag it so the UI can ignore it as a buy.
      const deadCat = mid[i] != null && closes[i] < mid[i] && sharpDropAt(i);
      signals.push({ index: i, type: 'buy', bar: bars[i], rsi: rsiArr[i], fast: fast[i], slow: slow[i], fastPeriod, slowPeriod, deadCat, mid: mid[i], close: closes[i] });
    } else if (crossedDown && rsiArr[i] < 50) {
      signals.push({ index: i, type: 'sell', bar: bars[i], rsi: rsiArr[i], fast: fast[i], slow: slow[i], fastPeriod, slowPeriod });
    } else if (crossedUp) {
      // The cross is real; only momentum was missing. Without this the chart
      // draws nothing here, so a visible crossing with no marker is
      // indistinguishable from no crossing at all — which is exactly how a
      // correct rejection reads as a bug.
      nearMisses.push({
        index: i, type: 'near-miss', reason: 'rsi', bar: bars[i],
        rsi: rsiArr[i], fast: fast[i], slow: slow[i], fastPeriod, slowPeriod,
      });
    }
  }
  // ─── The dead-cat bounce, standing on its own ──────────────────────────────
  //
  // Above, the dead cat is only a GUARD: it flags a crossover that fires inside
  // a sharp drop. But the pattern itself needs no crossover, and the far
  // commoner case — a hard fall, then a green day while price is still under
  // the mean — has no marker at all today. Those are the bars someone points at
  // and asks whether the rally is real, so they are drawn, counted, and scored.
  //
  // Mirrors `dead_cat_bounce` in backend/signals/registry.js exactly — same
  // 10% drop over the same 10-bar lookback, same middle band, same run guard —
  // so the bars drawn here are the bars the scorecard has rows for. Diverging
  // would put a track record beside markers it does not describe.
  //
  // The run guard is the load-bearing part: a failing bounce usually runs three
  // or four green days, and marking each of them would show one episode as four
  // calls whose forward windows almost entirely overlap.
  const bounceBarAt = (i) => (
    mid[i] != null && closes[i] < mid[i] && sharpDropAt(i)
    && closes[i - 1] != null && closes[i] > closes[i - 1]
  );
  const peakBefore = (i) => {
    let peak = -Infinity;
    for (let j = Math.max(0, i - DROP_LOOKBACK); j <= i; j++) peak = Math.max(peak, closes[j]);
    return peak;
  };
  // Kept out of `signals` on purpose, exactly as nearMisses are: Instrument.jsx
  // and UsInstrument.jsx both render anything in that array as a buy or a sell,
  // so a bearish third kind inside it would be painted as a sell call.
  const deadCatBounces = [];
  for (let i = 1; i < bars.length; i++) {
    if (!bounceBarAt(i) || bounceBarAt(i - 1)) continue;
    const peak = peakBefore(i);
    deadCatBounces.push({
      index: i, type: 'dead-cat-bounce', bar: bars[i],
      close: closes[i], mid: mid[i], rsi: rsiArr[i],
      dropPct: ((peak - closes[i]) / peak) * 100,
      peak,
    });
  }

  return { fast, slow, mid, rsi: rsiArr, signals, nearMisses, deadCatBounces };
}
