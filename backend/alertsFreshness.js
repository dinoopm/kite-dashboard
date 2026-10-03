'use strict';

const FAILURE_STATUSES = new Set(['failed', 'no-data', 'invalid', 'no-cache']);

function candleDate(value) {
  if (!value) return null;
  const key = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

function buildAlertsFreshness({ holdings, refreshResults, checkedAt = new Date() }) {
  const totalHoldings = Array.isArray(holdings) ? holdings.length : 0;
  const results = Array.isArray(refreshResults) ? refreshResults : [];
  const candleDates = results.map(item => candleDate(item.candleAsOf)).filter(Boolean).sort();
  const oldestCandleAt = candleDates[0] || null;
  const latestCandleAt = candleDates[candleDates.length - 1] || null;

  const issues = [];
  const seen = new Set();
  for (const item of results) {
    const asOf = candleDate(item.candleAsOf);
    let reason = null;
    if (FAILURE_STATUSES.has(item.status)) reason = item.status;
    else if (!asOf) reason = 'no-candle';
    else if (latestCandleAt && asOf < latestCandleAt) reason = 'lagging-candle';
    if (!reason || seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    issues.push({ symbol: item.symbol, candleAsOf: asOf, reason });
  }

  const successfulTimes = results.map(item => item.lastSuccessAt).filter(Boolean).sort();
  const coveredHoldings = results.filter(item => candleDate(item.candleAsOf)).length;
  const failedRefreshCount = results.filter(item => FAILURE_STATUSES.has(item.status)).length;

  return {
    checkedAt: new Date(checkedAt).toISOString(),
    candleAsOf: oldestCandleAt,
    latestCandleAt,
    lastSuccessfulRefreshAt: successfulTimes[successfulTimes.length - 1] || null,
    totalHoldings,
    coveredHoldings,
    coveragePct: totalHoldings > 0 ? (coveredHoldings / totalHoldings) * 100 : 100,
    attemptedCount: results.filter(item => item.attempted).length,
    successfulRefreshCount: results.filter(item => item.status === 'success').length,
    failedRefreshCount,
    cooldownCount: results.filter(item => item.status === 'cooldown').length,
    issues,
    status: coveredHoldings === totalHoldings && issues.length === 0 ? 'complete' : 'partial',
  };
}

module.exports = { FAILURE_STATUSES, buildAlertsFreshness, candleDate };

