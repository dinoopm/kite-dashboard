// Shared realized-volatility math for the red-flag checks (India:
// picks/redFlags.js, US: alpaca.js). Mirrors frontend/src/lib/volatility.js —
// annualized close-to-close HV and where today's 20D value sits vs the stock's
// own trailing year — duplicated here because the backend is CommonJS and the
// frontend lib is an ES module.

const ANNUALIZE = Math.sqrt(252);

const stdev = (a) => {
  if (a.length < 2) return null;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// closes: ascending daily closes. Returns { hv20, pctile, points } where
// pctile is the percentile rank of the current 20D HV within up to a year of
// rolling values and `points` is how many rolling values that rank is based
// on — callers should phrase the lookback from it (the India bhavcopy table
// currently holds only ~3 months and grows daily). Needs ≥60 closes (≈40
// rolling points) for the percentile to mean anything; below that, null.
function hvSpike(closes) {
  const clean = (closes || []).filter(c => c != null && c > 0);
  if (clean.length < 60) return null;
  const rets = [];
  for (let i = 1; i < clean.length; i++) rets.push(Math.log(clean[i] / clean[i - 1]));
  const rolling = [];
  for (let i = 20; i <= rets.length; i++) {
    const sd = stdev(rets.slice(i - 20, i));
    if (sd != null) rolling.push(sd * ANNUALIZE * 100);
  }
  const window = rolling.slice(-252);
  const hv20 = window[window.length - 1];
  const below = window.filter(v => v <= hv20).length;
  return { hv20, pctile: (below / window.length) * 100, points: window.length };
}

module.exports = { hvSpike };
