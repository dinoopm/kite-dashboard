export const measurementPrice = (axisValue, base) => base > 0 ? base * (1 + axisValue / 100) : axisValue;
export const measurementAxisValue = (price, base) => base > 0 ? (price / base - 1) * 100 : price;

export function measurementTime(row, intraday = false, timeZone = 'America/New_York') {
  const raw = row.timestamp || row.date;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return { time: null };
  if (intraday) return {
    time: date.getTime() / 1000,
    label: date.toLocaleString('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  };
  // Daily candles carry a market calendar date, even if midnight in their
  // source timezone falls on the preceding UTC day (notably Indian bars).
  const ymd = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return { time: ymd ? { year: +ymd[1], month: +ymd[2], day: +ymd[3] }
    : { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() } };
}
