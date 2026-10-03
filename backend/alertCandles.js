'use strict';

const indiaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});

function indiaDate(value) {
  // Broker date-only bars already name their exchange session.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = indiaDateFormatter.formatToParts(date);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Quotes can update a real bar for the current exchange session, but cannot
// establish that a session occurred or supply its open/range/volume. In
// particular, a missing bar on a weekend, holiday or failed refresh stays missing.
function prepareAlertCandles(candles, lastPrice, now = new Date()) {
  const workingCandles = [...candles];
  if (workingCandles.length === 0 || lastPrice == null || lastPrice === '') return workingCandles;
  const price = Number(lastPrice);
  if (!Number.isFinite(price) || price <= 0) return workingCandles;
  const lastCandle = workingCandles[workingCandles.length - 1];
  const sessionDate = indiaDate(lastCandle.date);
  if (!sessionDate || sessionDate !== indiaDate(now)) return workingCandles;

  workingCandles[workingCandles.length - 1] = {
    ...lastCandle,
    close: price,
    high: Math.max(lastCandle.high, price),
    low: Math.min(lastCandle.low, price),
  };
  return workingCandles;
}

module.exports = { prepareAlertCandles };
