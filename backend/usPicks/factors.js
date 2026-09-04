// ─── US Quant Picks — the factor maths, and nothing else ─────────────────────
//
// Every function here reads arrays and an index i, and only ever looks at
// indices ≤ i. That single property is what makes the backtest honest: running
// these at a past i reproduces exactly what the live engine would have said on
// that evening. No fetching, no dates, no Supabase — the engine supplies
// aligned arrays and asks.
//
// The definitions mirror backend/picks/engine.js (India) where the data allows
// it, so the two pages rank on the same idea of momentum, volume and 52-week
// strength. Where India has a term this market cannot supply — delivery % in
// the volume authenticity — it is simply absent, and the weights of the
// remaining terms are renormalised rather than a zero silently dragging every
// stock's authenticity down.

const MOM_WINDOW = 20;          // sessions in the momentum return
const MOM_SKIP = 5;             // freshest sessions skipped (short-term reversal)
const RS_WINDOW = 63;           // ~3 months, deliberately longer than momentum
const FIFTY_TWO_WINDOW = 252;   // sessions in "52-week"
const VOL_RECENT = 5;           // the week being judged
const VOL_BASE = 15;            // baseline sessions before it (6..20)
const HEAVY_MULT = 1.5;         // a session counts as heavy above this × baseline
const TRAP_SURGE = 1.0;         // volume more than doubled...
const TRAP_AUTH = 0.45;         // ...with little to show for it

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Simple moving average of `values` over `period` ending at i, or null. */
function smaAt(values, period, i) {
  if (i < period - 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) s += values[k];
  return s / period;
}

/** close[i−skip] / close[i−skip−window] − 1. */
function momentumAt(closes, i, { window = MOM_WINDOW, skip = MOM_SKIP } = {}) {
  const a = i - skip, b = i - skip - window;
  if (b < 0) return null;
  const c0 = closes[b], c1 = closes[a];
  if (!(c0 > 0) || c1 == null) return null;
  return c1 / c0 - 1;
}

/**
 * Volume conviction for the week ending at i, judged against the stock's own
 * baseline (sessions i−19..i−5), with the authenticity guard from India minus
 * its delivery term. A volume surge that moved price and persisted is demand;
 * one that did neither is churn, and its raw strength is scaled down to match.
 */
function volumeAt(closes, volumes, i) {
  const none = { surge: null, surgePct: null, ret5Abs: null, corroboration: null, persistence: null, authenticity: null, volumeRaw: 0, trapRisk: false, trapReason: null };
  if (i < VOL_RECENT + VOL_BASE - 1) return none;
  const recent = volumes.slice(i - VOL_RECENT + 1, i + 1);
  const base = volumes.slice(i - VOL_RECENT - VOL_BASE + 1, i - VOL_RECENT + 1);
  const baseAvg = mean(base);
  if (!(baseAvg > 0)) return none;
  const surge = mean(recent) / baseAvg - 1;
  const surgePct = surge * 100;
  const cSkip = closes[i - VOL_RECENT];
  const ret5Abs = cSkip > 0 ? Math.abs(closes[i] / cSkip - 1) * 100 : 0;
  // (a) price corroboration: a real volume surge moves price.
  const corroboration = clamp01(ret5Abs / (0.5 + surgePct / 200));
  // (b) persistence: heavy across the week, not one print.
  const persistence = recent.filter(v => v > HEAVY_MULT * baseAvg).length / VOL_RECENT;
  const authenticity = clamp01(0.6 * corroboration + 0.4 * persistence);
  const rawStrength = Math.max(0, surge);
  const surgeSignal = surge > 0.25;
  const volumeRaw = surgeSignal ? rawStrength * authenticity : 0;
  const trapRisk = surge > TRAP_SURGE && authenticity < TRAP_AUTH;
  let trapReason = null;
  if (trapRisk) {
    if (corroboration < 0.4) trapReason = `vol +${Math.round(surgePct)}% but price ~flat (${ret5Abs.toFixed(1)}% move)`;
    else if (persistence < 0.4) trapReason = `one-day blip (${Math.round(persistence * VOL_RECENT)} of ${VOL_RECENT} sessions heavy)`;
    else trapReason = 'low-conviction volume surge';
  }
  return { surge, surgePct, ret5Abs, corroboration, persistence, authenticity, volumeRaw, trapRisk, trapReason };
}

/**
 * Rolling 252-bar max and min at every j in [jStart, jEnd], in one forward
 * sweep with monotonic deques (classic sliding-window-maximum) instead of a
 * fresh O(window) scan per j. fiftyTwoAt needs up to 5 of these per call, and
 * this runs across ~570 evaluation dates × ~560 symbols, so the naive version
 * (up to 6 full 252-bar scans per call) is worth collapsing into one pass.
 */
function slidingExtrema(values, window, jStart, jEnd) {
  const maxDeque = [], minDeque = []; // indices; values decreasing / increasing
  const maxAt = new Map(), minAt = new Map();
  for (let k = jStart - window + 1; k <= jEnd; k++) {
    while (maxDeque.length && values[maxDeque[maxDeque.length - 1]] <= values[k]) maxDeque.pop();
    maxDeque.push(k);
    while (maxDeque[0] < k - window + 1) maxDeque.shift();
    while (minDeque.length && values[minDeque[minDeque.length - 1]] >= values[k]) minDeque.pop();
    minDeque.push(k);
    while (minDeque[0] < k - window + 1) minDeque.shift();
    if (k >= jStart) { maxAt.set(k, values[maxDeque[0]]); minAt.set(k, values[minDeque[0]]); }
  }
  return { maxAt, minAt };
}

/**
 * 52-week strength from adjusted closes. `newHigh5` asks whether any of the
 * last 5 closes was the rolling 252-session high AT THAT BAR — a stock that
 * printed a high on Monday and eased since still counts this week.
 */
function fiftyTwoAt(closes, i) {
  if (i < FIFTY_TWO_WINDOW - 1) return null;
  const jStart = Math.max(FIFTY_TWO_WINDOW - 1, i - 4);
  const { maxAt, minAt } = slidingExtrema(closes, FIFTY_TWO_WINDOW, jStart, i);
  const high252 = maxAt.get(i), low252 = minAt.get(i);
  let newHigh5 = false, newLow5 = false;
  for (let j = jStart; j <= i; j++) {
    if (closes[j] >= maxAt.get(j)) newHigh5 = true;
    if (closes[j] <= minAt.get(j)) newLow5 = true;
  }
  const nearHighPct = high252 > 0 ? clamp01(closes[i] / high252) : null;
  const fiftyTwoRaw = (newHigh5 ? 1 : 0) - (newLow5 ? 1 : 0) + (nearHighPct != null ? nearHighPct - 0.8 : 0);
  return { high252, low252, nearHighPct, newHigh5, newLow5, fiftyTwoRaw };
}

/** 63-session return minus SPY's, in percentage points. */
function relStrengthAt(closes, spyCloses, i) {
  const b = i - RS_WINDOW;
  if (b < 0) return null;
  const c0 = closes[b], s0 = spyCloses?.[b], c1 = closes[i], s1 = spyCloses?.[i];
  if (!(c0 > 0) || !(s0 > 0) || c1 == null || s1 == null) return null;
  return ((c1 / c0 - 1) - (s1 / s0 - 1)) * 100;
}

/** Median dollar volume over the 20 sessions ending at i. */
function dollarVolumeMedianAt(closes, volumes, i) {
  if (i < 19) return null;
  const xs = [];
  for (let k = i - 19; k <= i; k++) xs.push(closes[k] * volumes[k]);
  xs.sort((a, b) => a - b);
  return (xs[9] + xs[10]) / 2;
}

/** Everything the engine records for one symbol at bar i. */
function factorRowAt({ closes, volumes, spyCloses }, i, { momentum = {} } = {}) {
  const vol = volumeAt(closes, volumes, i);
  const ft = fiftyTwoAt(closes, i);
  const sma50 = smaAt(closes, 50, i), sma200 = smaAt(closes, 200, i);
  return {
    momentumRaw: momentumAt(closes, i, momentum),
    ...vol,
    fiftyTwoRaw: ft ? ft.fiftyTwoRaw : null,
    nearHighPct: ft ? ft.nearHighPct : null,
    newHigh5: ft ? ft.newHigh5 : false,
    newLow5: ft ? ft.newLow5 : false,
    relStrengthRaw: relStrengthAt(closes, spyCloses, i),
    dollarVolume: dollarVolumeMedianAt(closes, volumes, i),
    aboveSma50: sma50 != null ? closes[i] >= sma50 : null,
    aboveSma200: sma200 != null ? closes[i] >= sma200 : null,
  };
}

/** Market breadth over the universe's factor rows. */
function breadth(rows) {
  const pct = (pred) => {
    const known = rows.filter(r => pred(r) != null);
    return known.length ? +(known.filter(r => pred(r) === true).length / known.length * 100).toFixed(1) : null;
  };
  const pctAbove50 = pct(r => r.aboveSma50);
  const pctAbove200 = pct(r => r.aboveSma200);
  const pctPositiveMomentum = pct(r => (r.momentumRaw == null ? null : r.momentumRaw > 0));
  const label = pctAbove50 == null || pctAbove200 == null ? 'unknown'
    : pctAbove50 > 60 && pctAbove200 > 60 ? 'risk-on'
    : pctAbove50 < 40 && pctAbove200 < 40 ? 'risk-off'
    : 'mixed';
  return { pctAbove50, pctAbove200, pctPositiveMomentum, label };
}

module.exports = {
  momentumAt, volumeAt, fiftyTwoAt, relStrengthAt, dollarVolumeMedianAt, smaAt, factorRowAt, breadth,
  MOM_WINDOW, MOM_SKIP, RS_WINDOW, FIFTY_TWO_WINDOW, TRAP_SURGE, TRAP_AUTH, HEAVY_MULT,
};
