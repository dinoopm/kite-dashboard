// Multi-timeframe breakout indicator for stock-list columns. Reports the LONGEST
// horizon over which the latest close makes a new high — a 3-year-high breakout
// is far more significant than a 1-month one. Returns a numeric rank (so the
// column sorts strongest-first); pair with breakoutLabel() to render it.
//
//   7 = 3Y high   6 = 2Y high   5 = 1Y high
//   4 = 6M high   3 = 3M high   2 = 1M high
//   1 = near (within 1.5% of the 1M high)   0 = below   null = no data
//
// `sorted` is the ascending daily candle array ({ high, close, ... }). Trading
// days: 1M≈22, 3M≈66, 6M≈132, 1Y≈252, 2Y≈504, 3Y≈756.
const BREAKOUT_PERIODS = [
  { rank: 7, label: '3Y', days: 756 },
  { rank: 6, label: '2Y', days: 504 },
  { rank: 5, label: '1Y', days: 252 },
  { rank: 4, label: '6M', days: 132 },
  { rank: 3, label: '3M', days: 66 },
  { rank: 2, label: '1M', days: 22 },
];

export function breakoutRank(sorted) {
  if (!Array.isArray(sorted) || sorted.length < 23) return null; // need ≥ ~1M of history
  const n = sorted.length;
  const lastClose = sorted[n - 1].close;
  if (lastClose == null) return null;

  // Highest intraday high over the prior `days` sessions (excluding today).
  const priorHigh = (days) => {
    let m = -Infinity;
    for (let i = Math.max(0, n - 1 - days); i < n - 1; i++) {
      const h = sorted[i].high ?? sorted[i].close;
      if (h > m) m = h;
    }
    return m;
  };

  // Longest → shortest: the first horizon the close clears is the breakout's reach.
  for (const p of BREAKOUT_PERIODS) {
    if (n - 1 < p.days) continue; // not enough history to claim this horizon
    const ph = priorHigh(p.days);
    if (ph > 0 && lastClose >= ph) return p.rank;
  }
  const m1 = priorHigh(22);
  if (m1 > 0 && lastClose >= m1 * 0.985) return 1; // coiling just under the 1M high
  return 0;
}

// Map a rank to a display badge { text, color }. Longer horizon = greener.
export function breakoutLabel(rank) {
  switch (rank) {
    case 7: return { text: '🚀 3Y', color: '#16a34a' };
    case 6: return { text: '🚀 2Y', color: '#22c55e' };
    case 5: return { text: '🚀 1Y', color: '#4ade80' };
    case 4: return { text: '🚀 6M', color: '#a3e635' };
    case 3: return { text: '🚀 3M', color: '#eab308' };
    case 2: return { text: '🚀 1M', color: '#fbbf24' };
    case 1: return { text: '↗ Near', color: '#eab308' };
    default: return { text: '—', color: 'var(--text-secondary)' };
  }
}
