// Summary statistics over a backtest's closed trades + equity curves.

function maxDrawdown(curve) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const pt of curve) {
    peak = Math.max(peak, pt.equity);
    if (peak > 0) maxDd = Math.min(maxDd, (pt.equity - peak) / peak);
  }
  return +(maxDd * 100).toFixed(2);
}

function curveReturns(curve) {
  if (!curve || curve.length < 2) return { totalReturnPct: 0, cagr: 0 };
  const first = curve[0], last = curve[curve.length - 1];
  if (!first.equity) return { totalReturnPct: 0, cagr: 0 };
  const total = last.equity / first.equity - 1;
  const days = Math.max(1, (new Date(last.date) - new Date(first.date)) / 86400000);
  const cagr = days >= 30 ? Math.pow(last.equity / first.equity, 365 / days) - 1 : total;
  return { totalReturnPct: +(total * 100).toFixed(2), cagr: +(cagr * 100).toFixed(2) };
}

function computeMetrics(trades, equityCurve, buyHoldCurve, { barsInMarket = 0, totalBars = 0 } = {}) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avg = (arr, f) => arr.length ? arr.reduce((s, t) => s + f(t), 0) / arr.length : null;
  const rTrades = trades.filter(t => t.rMultiple != null);

  const strat = curveReturns(equityCurve);
  const bh = curveReturns(buyHoldCurve);

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : null,
    profitFactor: grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? null : 0),
    avgWinPct: avg(wins, t => t.pnlPct) != null ? +avg(wins, t => t.pnlPct).toFixed(2) : null,
    avgLossPct: avg(losses, t => t.pnlPct) != null ? +avg(losses, t => t.pnlPct).toFixed(2) : null,
    expectancyR: rTrades.length ? +(rTrades.reduce((s, t) => s + t.rMultiple, 0) / rTrades.length).toFixed(2) : null,
    totalReturnPct: strat.totalReturnPct,
    cagr: strat.cagr,
    maxDrawdownPct: maxDrawdown(equityCurve),
    avgHoldDays: avg(trades, t => t.holdDays) != null ? +avg(trades, t => t.holdDays).toFixed(1) : null,
    exposurePct: totalBars > 0 ? +((barsInMarket / totalBars) * 100).toFixed(1) : null,
    buyHold: {
      totalReturnPct: bh.totalReturnPct,
      cagr: bh.cagr,
      maxDrawdownPct: maxDrawdown(buyHoldCurve),
    },
  };
}

module.exports = { computeMetrics, maxDrawdown };
