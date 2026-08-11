// ─── Bollinger bandwidth and the squeeze ─────────────────────────────────────
//
// Bandwidth = (upper − lower) ÷ middle × 100, on a 20-period SMA ± 2 population
// standard deviations. A "squeeze" is bandwidth sitting at, or within a
// tolerance of, its lowest level over a lookback window — the folklore being
// that compressed volatility precedes a breakout.
//
// This lived only in frontend/src/components/SignalChart.jsx, which meant the
// chart could draw it but no screener could filter on it and no scorer could
// check whether it works. Same maths, moved where both can reach it, and
// exported as pure functions so the study and the screener cannot disagree.
//
// Two distinctions the rest of the app depends on:
//
// 1. `squeezeMask` is a STATE — true for every bar the compression lasts, often
//    twenty in a row. That is the right thing for a screener field ("is this
//    stock coiled right now?").
// 2. `squeezeStarts` is the TRANSITION — the single bar where compression
//    begins. That is the right thing to record as a signal, because recording
//    the state daily turns one call into twenty rows and makes n look like
//    evidence when it is one observation.
//
// Everything is causal: bar i uses bars <= i only.

const BB_PERIOD = 20;
const BB_MULT = 2;
const SQUEEZE_LOOKBACK = 30;
const SQUEEZE_TOL = 1.05;   // within 5% of the window low still counts

/** Bars needed before the first bar that can be evaluated at all. */
const MIN_BARS = BB_PERIOD + SQUEEZE_LOOKBACK;

/**
 * Bollinger bands over `closes`, aligned to the input (null during warmup).
 * Population standard deviation, matching the chart and most platforms.
 */
function bollinger(closes, period = BB_PERIOD, mult = BB_MULT) {
  const n = closes.length;
  const upper = new Array(n).fill(null);
  const middle = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = closes[j];
      if (!Number.isFinite(v)) { ok = false; break; }
      sum += v;
    }
    if (!ok) continue;
    const mean = sum / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) varSum += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(varSum / period);
    middle[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, middle, lower };
}

/** Bandwidth as a percent of the middle band, aligned to `closes`. */
function bandwidthSeries(closes, period = BB_PERIOD, mult = BB_MULT) {
  const bb = bollinger(closes, period, mult);
  return bb.middle.map((m, i) => (m != null && m !== 0 ? ((bb.upper[i] - bb.lower[i]) / m) * 100 : null));
}

/**
 * Which bars are squeezed.
 *
 * The window INCLUDES bar i, so the test is "is today at or near the lowest
 * bandwidth of the last `lookback` bars" — which is what makes it causal. A
 * window that excluded i would compare today against a past minimum and fire
 * on any quiet stretch.
 *
 * `requireFullWindow` refuses to judge until a whole lookback exists. Without
 * it the first bar after warmup is trivially its own minimum and every symbol
 * fires on bar 20, which is an artifact rather than a squeeze.
 */
function squeezeMask(bbw, { lookback = SQUEEZE_LOOKBACK, tol = SQUEEZE_TOL, requireFullWindow = true } = {}) {
  const n = bbw.length;
  const mask = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (bbw[i] == null) continue;
    const from = i - lookback + 1;
    if (requireFullWindow && from < 0) continue;
    let mn = Infinity;
    let seen = 0;
    for (let j = Math.max(0, from); j <= i; j++) {
      if (bbw[j] == null) continue;
      seen++;
      if (bbw[j] < mn) mn = bbw[j];
    }
    if (requireFullWindow && seen < lookback) continue;
    if (mn !== Infinity && bbw[i] <= mn * tol) mask[i] = true;
  }
  return mask;
}

/**
 * Bars where a squeeze BEGINS — false on the previous bar, true on this one.
 *
 * This is what gets recorded as a signal. The state can persist for weeks; the
 * call is made once.
 */
function squeezeStarts(mask) {
  const out = [];
  for (let i = 1; i < mask.length; i++) if (mask[i] && !mask[i - 1]) out.push(i);
  return out;
}

/**
 * Everything the screener needs for one symbol, from its closes.
 * Returns nulls rather than guesses when there is not enough history.
 */
function squeezeState(closes, opts = {}) {
  const bbw = bandwidthSeries(closes, opts.period, opts.mult);
  const mask = squeezeMask(bbw, opts);
  let i = bbw.length - 1;
  while (i >= 0 && bbw[i] == null) i--;
  if (i < 0) return { bandwidth: null, squeezed: null, barsInSqueeze: null, startedAt: null };

  let bars = 0;
  if (mask[i]) { let k = i; while (k >= 0 && mask[k]) { bars++; k--; } }
  return {
    bandwidth: bbw[i],
    squeezed: mask[i],
    barsInSqueeze: mask[i] ? bars : 0,
    startedAt: mask[i] ? i - bars + 1 : null,
  };
}

module.exports = {
  BB_PERIOD, BB_MULT, SQUEEZE_LOOKBACK, SQUEEZE_TOL, MIN_BARS,
  bollinger, bandwidthSeries, squeezeMask, squeezeStarts, squeezeState,
};
