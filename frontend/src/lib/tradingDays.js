// Daily candles already exclude exchange holidays and weekends. Keep their
// exchange date instead of converting midnight into the viewer's time zone.
export function getRecentTradingDays(candles) {
  if (!Array.isArray(candles)) return [];

  const byDate = new Map();
  for (const candle of candles) {
    const date = typeof candle?.date === 'string' ? candle.date.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) continue;
    byDate.set(date, candle.close);
  }

  const days = [...byDate].sort(([a], [b]) => a.localeCompare(b));
  return days.slice(1).map(([date, close], index) => {
    const previousClose = days[index][1];
    const changePct = Number.isFinite(close) && close > 0
      && Number.isFinite(previousClose) && previousClose > 0
      ? ((close - previousClose) / previousClose) * 100
      : null;
    return { date, changePct };
  }).slice(-5);
}
