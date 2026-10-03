'use strict';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// The same ownership convention as Portfolio: settled shares plus T1 shares.
// Financial values come from the holdings snapshot, independently of candles
// and technical signals. Keep full precision until the response is formatted.
function holdingMetrics(holding) {
  const quantity = (finiteNumber(holding.quantity) ?? 0) + (finiteNumber(holding.t1_quantity) ?? 0);
  const price = finiteNumber(holding.last_price);
  const average = finiteNumber(holding.average_price);
  const previousClose = finiteNumber(holding.close_price);
  const dayChange = finiteNumber(holding.day_change)
    ?? (price > 0 && previousClose > 0 ? price - previousClose : null);
  const currentValue = quantity > 0 && price > 0 ? quantity * price : null;
  const invested = quantity > 0 && average > 0 ? quantity * average : null;
  const pnl = currentValue !== null && invested !== null ? currentValue - invested : null;

  return {
    quantity,
    avgPrice: average ?? 0,
    currentValue,
    invested,
    pnl,
    pnlPct: pnl !== null ? (pnl / invested) * 100 : null,
    dayChangeRupee: quantity > 0 && dayChange !== null ? quantity * dayChange : null,
  };
}

function buildHoldingSummary(holdings) {
  const positions = holdings.map(holdingMetrics).filter(position => position.quantity > 0);
  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalPnl = 0;
  let pnlInvested = 0;
  let todayPnl = 0;
  for (const position of positions) {
    totalInvested += position.invested ?? 0;
    totalCurrentValue += position.currentValue ?? 0;
    todayPnl += position.dayChangeRupee ?? 0;
    if (position.pnl !== null) {
      totalPnl += position.pnl;
      pnlInvested += position.invested;
    }
  }
  const round = value => +value.toFixed(2);
  return {
    todayPnlRupee: round(todayPnl),
    totalPnlRupee: round(totalPnl),
    totalPnlPct: pnlInvested > 0 ? round((totalPnl / pnlInvested) * 100) : null,
    totalInvested: round(totalInvested),
    totalCurrentValue: round(totalCurrentValue),
    totalHoldings: holdings.length,
    financialCoverage: {
      totalPositions: positions.length,
      investedPositions: positions.filter(position => position.invested !== null).length,
      valuedPositions: positions.filter(position => position.currentValue !== null).length,
      pnlPositions: positions.filter(position => position.pnl !== null).length,
      dailyPnlPositions: positions.filter(position => position.dayChangeRupee !== null).length,
    },
  };
}

module.exports = { holdingMetrics, buildHoldingSummary };
