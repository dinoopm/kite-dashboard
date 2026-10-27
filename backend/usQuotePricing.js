// Quotes keep a single price/change pair. Extended mode uses the newest valid
// trade or minute close, with 1D measured from the preceding regular close.
const etFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function marketTime(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(etFormat.formatToParts(ms).map(x => [x.type, x.value]));
  return { ms, date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute, weekday: p.weekday };
}
const price = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
function quoteFromSnapshot(snapshot, { extended = false, feed = null, now = Date.now() } = {}) {
  const daily = snapshot?.dailyBar || {}, prev = snapshot?.prevDailyBar || {};
  const dailyTime = marketTime(daily.t);
  const regular = price(daily.c);
  let last = regular ?? price(snapshot?.latestTrade?.p);
  let previousClose = price(prev.c);
  let session = regular ? 'regular-close' : 'unavailable';
  let asOf = regular ? daily.t ?? null : null;
  if (extended) {
    const candidates = [
      { p: snapshot?.latestTrade?.p, t: snapshot?.latestTrade?.t },
      { p: snapshot?.minuteBar?.c, t: snapshot?.minuteBar?.t },
    ].map(c => ({ ...c, time: marketTime(c.t) })).filter(c =>
      price(c.p) && c.time && c.time.ms <= now &&
      !['Sat', 'Sun'].includes(c.time.weekday) &&
      c.time.minutes >= 240 && c.time.minutes < 1200 &&
      (!dailyTime || c.time.date >= dailyTime.date)
    ).sort((a, b) => b.time.ms - a.time.ms);
    const latest = candidates[0];
    if (latest) {
      last = latest.p;
      asOf = latest.t;
      session = latest.time.minutes < 570 ? 'pre-market'
        : latest.time.minutes >= 960 ? 'after-hours' : 'regular';
      // Before the next regular session, dailyBar can still be yesterday's
      // bar. Using prevDailyBar here would accidentally count two days.
      if (dailyTime && latest.time.date > dailyTime.date) previousClose = regular;
    }
  }
  const change = last != null && previousClose != null ? last - previousClose : null;
  return {
    last_price: last,
    net_change: change,
    ohlc: { open: daily.o ?? null, high: daily.h ?? null, low: daily.l ?? null, close: previousClose },
    quote_session: session, quote_as_of: asOf, feed,
  };
}
module.exports = { quoteFromSnapshot };
