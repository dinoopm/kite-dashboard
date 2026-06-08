// Lightweight breakout indicator for stock-list columns. Answers: is the latest
// close clearing the prior `lookback`-session high (a fresh N-day-high breakout)?
//   2 = breakout — closed at/above the prior 20-day high
//   1 = near     — within 1.5% of it (coiling just under resistance)
//   0 = below
//   null = insufficient history
//
// `sorted` is the ascending daily candle array ({ high, close, ... }).
export function breakoutStatus(sorted, lookback = 20) {
  if (!Array.isArray(sorted) || sorted.length < lookback + 2) return null;
  const n = sorted.length;
  const lastClose = sorted[n - 1].close;
  if (lastClose == null) return null;
  let priorHigh = -Infinity;
  for (let i = n - 1 - lookback; i < n - 1; i++) {
    const h = sorted[i].high ?? sorted[i].close;
    if (h > priorHigh) priorHigh = h;
  }
  if (!(priorHigh > 0)) return null;
  if (lastClose >= priorHigh) return 2;
  if (lastClose >= priorHigh * 0.985) return 1;
  return 0;
}
