// Sector breadth analyser — pure derivation of a sector's internal health from
// the per-stock technicals already computed on the sector-detail pages. No data
// fetch: it reads rows already loaded and recomputes as more stream in.
//
// A `row` is one enriched constituent with (at least): aboveSma20, aboveSma200
// (bool | null), rsi14 (number | null), breakout (0..7 | null; ≥2 = at a new
// high, 1 = near, 0 = below), '1D' (percent | null), name (string).
//
// Every dimension excludes rows whose relevant field is null, so each degrades
// independently while the table is still loading.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Verdict thresholds shared by the composite score and the panel's zone colors.
export const STRONG_MIN = 66;
export const MIXED_MIN = 40;

const READ = {
  Strong: 'Broad participation — most of the sector is trending up.',
  Mixed: 'Selective — a portion of the sector leads, be picky.',
  Weak: 'Narrow / weak — few names holding up.',
};

// Compute the full breadth object, or null if no rows have loaded yet.
export function computeSectorBreadth(rows) {
  const loaded = (rows || []).filter(s => s && s.aboveSma20 !== null && s.aboveSma20 !== undefined);
  if (loaded.length === 0) return null;

  // ── Moving-average breadth (mirrors the previous maGaugeData memo) ──
  const above20 = loaded.filter(s => s.aboveSma20);
  const above200 = loaded.filter(s => s.aboveSma200);
  const pct20 = (above20.length / loaded.length) * 100;
  const pct200 = (above200.length / loaded.length) * 100;
  const sma = {
    pct20,
    pct200,
    above20names: above20.map(s => s.name),
    below20names: loaded.filter(s => !s.aboveSma20).map(s => s.name),
    above200names: above200.map(s => s.name),
    below200names: loaded.filter(s => s.aboveSma200 === false).map(s => s.name),
  };

  // ── Advance / decline (today) ──
  const adRows = loaded.filter(s => s['1D'] != null);
  const adv = adRows.filter(s => s['1D'] > 0).length;
  const dec = adRows.filter(s => s['1D'] < 0).length;
  const flat = adRows.length - adv - dec;
  const advDecline = {
    adv, dec, flat, total: adRows.length,
    pctAdv: adRows.length ? (adv / adRows.length) * 100 : 0,
  };

  // ── New highs vs lows (from the breakout rank) ──
  const bRows = loaded.filter(s => s.breakout != null);
  const atHigh = bRows.filter(s => s.breakout >= 2).length;
  const near = bRows.filter(s => s.breakout === 1).length;
  const below = bRows.filter(s => s.breakout === 0).length;
  const newHighsLows = { atHigh, near, below, total: bRows.length };

  // ── RSI distribution ──
  const rRows = loaded.filter(s => s.rsi14 != null);
  const overbought = rRows.filter(s => s.rsi14 >= 70).length;
  const oversold = rRows.filter(s => s.rsi14 <= 30).length;
  const rsiDist = {
    overbought, oversold, neutral: rRows.length - overbought - oversold, total: rRows.length,
  };

  // ── Composite 0–100 breadth score (transparent factor blend) ──
  const newHighParticipation = newHighsLows.total
    ? (atHigh + 0.5 * near) / newHighsLows.total
    : 0;
  const oversoldRate = rsiDist.total ? oversold / rsiDist.total : 0;
  const oversoldPenalty = clamp((oversoldRate - 0.40) / 0.60, 0, 1) * 10;

  const rawScore =
      0.30 * pct20
    + 0.25 * pct200
    + 0.20 * advDecline.pctAdv
    + 0.25 * (100 * newHighParticipation)
    - oversoldPenalty;
  const score = clamp(Math.round(rawScore), 0, 100);
  const verdict = score >= STRONG_MIN ? 'Strong' : score >= MIXED_MIN ? 'Mixed' : 'Weak';

  return {
    loadedCount: loaded.length,
    advDecline,
    newHighsLows,
    rsiDist,
    sma,
    composite: { score, verdict, read: READ[verdict] },
  };
}
