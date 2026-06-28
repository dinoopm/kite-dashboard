// Pure volatility-analytics helpers for the VIX "cockpit". Inputs are plain
// number arrays (or {date, close} series); no React, no fetching — so the math
// can be unit-tested in isolation and reused by the dashboard widget later.

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export const stdev = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// Percentile rank of `value` within `arr` (0–100): share of observations ≤ value.
export const percentileRank = (arr, value) => {
  if (!arr.length) return null;
  const below = arr.filter(x => x <= value).length;
  return (below / arr.length) * 100;
};

// IV Rank: where `value` sits between the window's min and max (0–100).
export const ivRank = (arr, value) => {
  if (!arr.length) return null;
  const lo = Math.min(...arr), hi = Math.max(...arr);
  return hi > lo ? ((value - lo) / (hi - lo)) * 100 : 50;
};

// Quantile via linear interpolation (q in [0,1]).
export const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
};

export const zScore = (arr, value) => {
  const m = mean(arr), sd = stdev(arr);
  return sd ? (value - m) / sd : null;
};

// Annualized close-to-close realized volatility (%) over the last `window`
// returns of a close series — stdev of daily log returns × √252.
export const realizedVol = (closes, window = 20) => {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-(window + 1));
  const rets = [];
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
  const sd = stdev(rets);
  return sd != null ? sd * Math.sqrt(252) * 100 : null;
};

// Implied 1σ move from VIX for a horizon of `days` trading days.
// Returns the move as a % and in absolute points around `spot`.
export const expectedMove = (spot, vix, days = 1) => {
  if (!spot || !vix) return null;
  const sigma = (vix / 100) * Math.sqrt(days / 252);
  return { pct: sigma * 100, points: spot * sigma, lo: spot * (1 - sigma), hi: spot * (1 + sigma) };
};

// Pearson correlation of two equal-length arrays.
export const correlation = (a, b) => {
  if (a.length !== b.length || a.length < 2) return null;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return (va && vb) ? cov / Math.sqrt(va * vb) : null;
};

// Align a VIX series and a Nifty series (each {date, close}) on common dates,
// ascending. Returns { dates, vix, nifty } as parallel arrays.
export function alignSeries(vixSeries, niftySeries) {
  const niftyByDate = new Map(niftySeries.map(c => [String(c.date).slice(0, 10), c.close]));
  const dates = [], vix = [], nifty = [];
  for (const c of vixSeries) {
    const d = String(c.date).slice(0, 10);
    if (niftyByDate.has(d)) { dates.push(d); vix.push(c.close); nifty.push(niftyByDate.get(d)); }
  }
  return { dates, vix, nifty };
}

// Rolling 20-day correlation of Nifty daily returns vs VIX daily *changes*.
// A breakdown toward positive (index up AND vol up) is the divergence warning.
export function vixNiftyCorrelation(vixCloses, niftyCloses, window = 20) {
  const n = Math.min(vixCloses.length, niftyCloses.length);
  if (n < window + 1) return null;
  const niftyRet = [], vixChg = [];
  for (let i = n - window; i < n; i++) {
    niftyRet.push((niftyCloses[i] - niftyCloses[i - 1]) / niftyCloses[i - 1]);
    vixChg.push(vixCloses[i] - vixCloses[i - 1]);
  }
  return correlation(niftyRet, vixChg);
}

// Forward-return study: classify the VIX range into 5 equal bands, find the band
// the current VIX sits in, then report what Nifty did over each forward horizon
// from every historical day in that band. `vixCloses`/`niftyCloses` must be
// aligned (same dates, ascending).
export function forwardReturnStudy(vixCloses, niftyCloses, currentVix, horizons = [5, 10, 20]) {
  const n = Math.min(vixCloses.length, niftyCloses.length);
  if (n < 30) return null;
  const lo = Math.min(...vixCloses), hi = Math.max(...vixCloses);
  const bandSize = (hi - lo) / 5 || 1;
  const bandIndex = Math.min(4, Math.max(0, Math.floor((currentVix - lo) / bandSize)));
  const bandLo = lo + bandIndex * bandSize, bandHi = bandLo + bandSize;

  const inBand = [];
  for (let i = 0; i < n; i++) if (vixCloses[i] >= bandLo && vixCloses[i] <= bandHi) inBand.push(i);

  const horizonStats = horizons.map(h => {
    const rets = [];
    for (const i of inBand) if (i + h < n) rets.push((niftyCloses[i + h] - niftyCloses[i]) / niftyCloses[i] * 100);
    if (!rets.length) return { h, n: 0, mean: null, median: null, hitRate: null, best: null, worst: null };
    const pos = rets.filter(r => r > 0).length;
    return {
      h, n: rets.length,
      mean: mean(rets), median: quantile(rets, 0.5),
      hitRate: (pos / rets.length) * 100,
      best: Math.max(...rets), worst: Math.min(...rets),
    };
  });
  return { bandLo, bandHi, bandIndex, sampleDays: inBand.length, horizons: horizonStats };
}

// One-line, data-driven read of the vol regime for the strategy banner.
export function regimeReadout({ vix, ivPct, ivr, vrp, z }) {
  const cheapRich = ivPct == null ? '' : ivPct < 20 ? 'cheap' : ivPct > 80 ? 'rich' : 'mid-range';
  const vrpPhrase = vrp == null ? ''
    : vrp > 1.5 ? 'implied is well above realized (positive variance risk premium) — selling premium is paid for the risk'
    : vrp < -1.5 ? 'implied is below realized — options look cheap vs. what Nifty is actually delivering; favor buying optionality'
    : 'implied and realized are roughly in line';
  const stretch = z == null ? '' : z < -1 ? ' Vol is stretched low and tends to mean-revert up.' : z > 1.5 ? ' Vol is stretched high and tends to mean-revert down.' : '';
  const pctTxt = ivPct == null ? '' : `${Math.round(ivPct)}th percentile of the past year (IV Rank ${Math.round(ivr ?? 0)})`;
  return `India VIX ${vix.toFixed(2)} sits in the ${pctTxt} — implied vol is ${cheapRich}. ${vrpPhrase ? vrpPhrase[0].toUpperCase() + vrpPhrase.slice(1) + '.' : ''}${stretch}`;
}
