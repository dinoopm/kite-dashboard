// Deterministic Volatility Contraction Pattern detector. Pure functions over
// raw OHLC arrays, so both the screener scan (buildSeries) and the instrument
// alert builder (inline arrays) can call it without sharing a series builder.
const { ATR } = require('technicalindicators');

const VCP_SETUP_THRESHOLD = 70;
const MIN_BARS = 60;
const WEIGHTS = { contraction: 35, coiling: 25, volumeDryUp: 25, baseSanity: 15 };

// Linear map: value at `zeroAt` -> 0, at `oneAt` -> 1, clamped to [0,1].
// zeroAt may be greater than oneAt (inverse mapping).
function ramp(x, zeroAt, oneAt) {
  if (x == null || !isFinite(x)) return 0;
  const t = (x - zeroAt) / (oneAt - zeroAt);
  return Math.max(0, Math.min(1, t));
}

// Mean of arr over [from, to) skipping nulls; null if no samples.
function mean(arr, from, to) {
  let s = 0, c = 0;
  for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++) {
    if (arr[i] != null) { s += arr[i]; c++; }
  }
  return c ? s / c : null;
}

// Simple moving average of `closes` ending at index `idx`; null if not enough bars.
function smaAt(closes, period, idx) {
  if (idx < period - 1 || idx >= closes.length) return null;
  let s = 0;
  for (let i = idx - period + 1; i <= idx; i++) s += closes[i];
  return s / period;
}

function leftPad(arr, n) {
  return new Array(Math.max(0, n - arr.length)).fill(null).concat(arr);
}

function computeVcpScore({ closes, highs, lows, volumes, atr14 } = {}) {
  const n = Array.isArray(closes) ? closes.length : 0;
  if (n < MIN_BARS) {
    return { vcpScore: null, vcpSetup: 'NO', gatePassed: false, gateFailReason: 'insufficient history', components: null };
  }
  const last = n - 1;
  const price = closes[last];

  let atr = atr14;
  if (!atr) {
    const raw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    atr = leftPad(raw, n);
  }

  // ---- Gate: Minervini trend template ----
  const sma50 = smaAt(closes, 50, last);
  const sma200 = smaAt(closes, 200, last);
  const sma200prev = smaAt(closes, 200, last - 20);
  let gateFailReason = null;
  if (sma200 == null) gateFailReason = 'insufficient history for 200SMA';
  else if (price <= sma200) gateFailReason = 'price below 200SMA';
  else if (sma50 != null && price <= sma50) gateFailReason = 'price below 50SMA';
  else if (sma200prev == null) gateFailReason = 'insufficient history for 200SMA slope';
  else if (sma200 <= sma200prev) gateFailReason = '200SMA not rising';
  const gatePassed = gateFailReason == null;

  // ---- Component 1: volatility contraction (ATR% now vs ~50 bars ago) ----
  const atrPctNow = (atr[last] != null && price > 0) ? atr[last] / price : null;
  const pIdx = last - 50;
  const atrPctPrior = (atr[pIdx] != null && closes[pIdx] > 0) ? atr[pIdx] / closes[pIdx] : null;
  const atrRatio = (atrPctNow != null && atrPctPrior > 0) ? atrPctNow / atrPctPrior : null;
  const cContraction = ramp(atrRatio, 1.0, 0.5);

  // ---- Component 2: coiling near pivot (distance below 50d high) ----
  let hi50 = -Infinity;
  for (let i = last - 49; i <= last; i++) if (highs[i] > hi50) hi50 = highs[i];
  const distFromHigh = hi50 > 0 ? ((price - hi50) / hi50) * 100 : null;
  const cCoiling = ramp(distFromHigh, -12, -3);

  // ---- Component 3: volume dry-up (last 10 vs prior 50) ----
  const volNow = mean(volumes, last - 9, last + 1);
  const volPrior = mean(volumes, last - 59, last - 9);
  const volRatio = (volNow != null && volPrior > 0) ? volNow / volPrior : null;
  const cVolume = ramp(volRatio, 1.0, 0.6);

  // ---- Component 4: base sanity (50-bar depth, full inside 8-35%) ----
  let hiBase = -Infinity, loBase = Infinity;
  for (let i = last - 49; i <= last; i++) { if (highs[i] > hiBase) hiBase = highs[i]; if (lows[i] < loBase) loBase = lows[i]; }
  const baseDepth = hiBase > 0 ? ((hiBase - loBase) / hiBase) * 100 : null;
  let cBase = 0;
  if (baseDepth != null) {
    if (baseDepth < 8) cBase = ramp(baseDepth, 4, 8);
    else if (baseDepth > 35) cBase = ramp(baseDepth, 50, 35);
    else cBase = 1;
  }

  const raw = cContraction * WEIGHTS.contraction + cCoiling * WEIGHTS.coiling
    + cVolume * WEIGHTS.volumeDryUp + cBase * WEIGHTS.baseSanity;
  const vcpScore = Math.round(raw * (gatePassed ? 1 : 0.25));
  const vcpSetup = (gatePassed && vcpScore >= VCP_SETUP_THRESHOLD) ? 'YES' : 'NO';

  return {
    vcpScore, vcpSetup, gatePassed, gateFailReason,
    components: {
      contraction: +cContraction.toFixed(3),
      coiling: +cCoiling.toFixed(3),
      volumeDryUp: +cVolume.toFixed(3),
      baseSanity: +cBase.toFixed(3),
      atrRatio: atrRatio != null ? +atrRatio.toFixed(3) : null,
      distFromHighPct: distFromHigh != null ? +distFromHigh.toFixed(2) : null,
      volRatio: volRatio != null ? +volRatio.toFixed(3) : null,
      baseDepthPct: baseDepth != null ? +baseDepth.toFixed(2) : null,
    },
  };
}

// ZigZag over closes: a pivot forms when price reverses >= reversalPct from the
// running extreme. Contractions = each swing-high followed by a swing-low.
function computeVcpContractions({ closes, highs, lows, volumes, lookback = 65, reversalPct = 5 } = {}) {
  const n = Array.isArray(closes) ? closes.length : 0;
  if (n < 20) return { contractions: [], tightening: false, verdict: 'insufficient history' };
  const from = Math.max(0, n - lookback);

  const piv = []; // { idx, price, type: 'H' | 'L' }
  let extIdx = from, extPrice = closes[from], dir = 0; // dir: 1 up, -1 down, 0 unknown
  for (let i = from + 1; i < n; i++) {
    const c = closes[i];
    if (dir >= 0) {
      if (c > extPrice) { extPrice = c; extIdx = i; }
      else if (((extPrice - c) / extPrice) * 100 >= reversalPct) {
        piv.push({ idx: extIdx, price: extPrice, type: 'H' }); dir = -1; extPrice = c; extIdx = i;
      }
    }
    if (dir <= 0) {
      if (c < extPrice) { extPrice = c; extIdx = i; }
      else if (((c - extPrice) / extPrice) * 100 >= reversalPct) {
        piv.push({ idx: extIdx, price: extPrice, type: 'L' }); dir = 1; extPrice = c; extIdx = i;
      }
    }
  }

  const contractions = [];
  for (let i = 0; i < piv.length - 1; i++) {
    if (piv[i].type === 'H' && piv[i + 1].type === 'L') {
      const depthPct = +(((piv[i].price - piv[i + 1].price) / piv[i].price) * 100).toFixed(2);
      const avgVolume = Math.round(mean(volumes, piv[i].idx, piv[i + 1].idx + 1) || 0);
      contractions.push({ depthPct, avgVolume });
    }
  }

  const depths = contractions.map(c => c.depthPct);
  const tightening = depths.length >= 2 && depths.every((d, i) => i === 0 || d <= depths[i - 1] + 0.01);
  let verdict;
  if (contractions.length === 0) verdict = 'no contractions detected in base';
  else verdict = `${contractions.length} contraction${contractions.length > 1 ? 's' : ''} `
    + `${depths.map(d => Math.round(d) + '%').join('→')}${tightening ? ' — tightening' : ''}`;
  return { contractions, tightening, verdict };
}

module.exports = { computeVcpScore, computeVcpContractions, VCP_SETUP_THRESHOLD, MIN_BARS, ramp, mean, smaAt };
