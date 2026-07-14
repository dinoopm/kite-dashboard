// Shared technical indicators (pure functions over daily bars).

// Wilder ADX(14). bars: [{ high, low, close }]. Returns null when the series
// is too short (< 2p+1 bars).
export const adx14 = (bars, p = 14) => {
  if (bars.length < 2 * p + 1) return null;
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
  if (dx.length < p) return null;
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return adx;
};
