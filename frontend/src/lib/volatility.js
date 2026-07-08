// Historical-volatility helpers for the instrument pages. Same contract as
// vixAnalytics.js: plain arrays in, numbers out — no React, no fetching — so
// the math is unit-testable and the panel component stays presentational.

import { stdev, quantile, percentileRank, realizedVol } from './vixAnalytics';

const ANNUALIZE = Math.sqrt(252);

// Rolling annualized close-to-close volatility (%): at each index i >= window,
// stdev of the previous `window` daily log returns × √252. Entries before the
// window has warmed up are omitted. Returns [{ i, vol }].
export function rollingRealizedVol(closes, window = 20) {
  if (closes.length < window + 1) return [];
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const out = [];
  for (let i = window; i <= rets.length; i++) {
    const sd = stdev(rets.slice(i - window, i));
    if (sd != null) out.push({ i, vol: sd * ANNUALIZE * 100 });
  }
  return out;
}

// Everything the VolatilityPanel renders, from ascending daily bars
// ({ date, close }). Returns null when there isn't enough history for even
// the 20-day figure.
export function computeVolStats(bars, { sparkPoints = 252 } = {}) {
  const clean = (bars || []).filter(b => b && b.close != null && b.close > 0);
  const closes = clean.map(b => b.close);
  if (closes.length < 21) return null;

  const hv20 = realizedVol(closes, 20);
  const hv60 = realizedVol(closes, 60);
  const hv252 = realizedVol(closes, 252);
  const dailySigma = hv20 != null ? hv20 / ANNUALIZE : null;

  // Rolling 20D series for the sparkline — last ~1 trading year. rollingRealizedVol
  // indexes into the returns array, so rets index i lines up with bar i (the bar
  // that completes the window).
  const rolling = rollingRealizedVol(closes, 20).slice(-sparkPoints);
  const series = rolling.map(({ i, vol }) => ({ date: clean[i].date, vol: +vol.toFixed(1) }));
  const vols = rolling.map(r => r.vol);
  const pctile = hv20 != null && vols.length >= 30 ? percentileRank(vols, hv20) : null;
  const median = vols.length ? quantile(vols, 0.5) : null;

  return { hv20, hv60, hv252, dailySigma, series, pctile, median };
}

// Plain-English classification of the current vol level so a non-quant can
// read the panel. Primary signal: where today's 20D vol sits vs the stock's
// own past year (percentile) — "is this normal for THIS stock". When the
// history is too short for a percentile, fall back to absolute annualized
// bands (rough equity heuristics: <20% calm large-cap, >45% jumpy).
export function volRegime(pctile, hv20) {
  if (pctile != null) {
    // percentileRank counts the current value itself, so cap the displayed
    // figure at 99 — "harder than 100% of the past year" reads wrong.
    const p = Math.min(99, Math.round(pctile));
    if (pctile >= 90) return { label: 'MUCH HIGHER THAN USUAL', tone: 'alert', blurb: `swinging harder than ${p}% of the past year` };
    if (pctile >= 75) return { label: 'HIGHER THAN USUAL', tone: 'warn', blurb: `above its normal range (${p}th percentile of the past year)` };
    if (pctile <= 25) return { label: 'CALMER THAN USUAL', tone: 'good', blurb: `quieter than ${Math.round(100 - pctile)}% of the past year` };
    return { label: 'NORMAL FOR THIS STOCK', tone: 'neutral', blurb: 'moving about as much as it usually does' };
  }
  if (hv20 == null) return null;
  if (hv20 >= 45) return { label: 'HIGH', tone: 'alert', blurb: 'large daily swings — expect sharp moves both ways' };
  if (hv20 >= 30) return { label: 'ELEVATED', tone: 'warn', blurb: 'bigger daily swings than a typical large-cap' };
  if (hv20 < 20) return { label: 'LOW', tone: 'good', blurb: 'small, steady daily moves' };
  return { label: 'MODERATE', tone: 'neutral', blurb: 'typical equity-sized daily moves' };
}
