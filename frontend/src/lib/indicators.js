// Shared technical indicators (pure functions over daily bars).

// Wilder ADX(14) as a series. bars: [{ date, high, low, close }].
//
// ADX has a long warm-up: the DM/TR smoothing eats the first p bars, and the DX
// average eats another p, so the first plottable value sits at bars[2p-1]. Those
// leading bars are dropped rather than emitted as nulls, because a chart would
// otherwise have to special-case them and the axis would start on empty space.
// Returns [] when the series is too short (< 2p+1 bars).
export const adx14Series = (bars, p = 14) => {
  if (!Array.isArray(bars) || bars.length < 2 * p + 1) return [];
  const tr = [], pDM = [], mDM = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    const pc = bars[i - 1].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  const wilder = (arr) => { let s = arr.slice(0, p).reduce((a, b) => a + b, 0); const o = [s]; for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; o.push(s); } return o; };
  const trS = wilder(tr), pS = wilder(pDM), mS = wilder(mDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (!trS[i]) { dx.push(0); continue; }
    const pdi = 100 * pS[i] / trS[i], mdi = 100 * mS[i] / trS[i];
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  }
  if (dx.length < p) return [];
  // dx[i] describes bars[i + p], so the seed average (dx[0..p-1]) lands on
  // bars[2p-1] and each subsequent smoothed value on bars[i + p].
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const out = [{ date: bars[2 * p - 1].date, adx }];
  for (let i = p; i < dx.length; i++) {
    adx = (adx * (p - 1) + dx[i]) / p;
    out.push({ date: bars[i + p].date, adx });
  }
  return out;
};

// Latest ADX(14) only. Returns null when the series is too short (< 2p+1 bars).
export const adx14 = (bars, p = 14) => {
  const series = adx14Series(bars, p);
  return series.length ? series[series.length - 1].adx : null;
};
