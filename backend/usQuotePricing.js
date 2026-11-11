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
// The detail-page header keeps the regular close as its headline and shows an
// out-of-hours print beside it, so this answers "what has it done since the
// close?", measured from the last regular close in both sessions. That differs
// from quoteFromSnapshot's after-hours change, which is the full-day one.
function extendedSession(snapshot, options = {}) {
  const quote = quoteFromSnapshot(snapshot, { ...options, extended: true });
  if (quote.quote_session !== 'pre-market' && quote.quote_session !== 'after-hours') return null;
  const base = price(snapshot?.dailyBar?.c);
  if (!base) return null;
  const change = quote.last_price - base;
  return { session: quote.quote_session, price: quote.last_price, change, changePct: (change / base) * 100, base, asOf: quote.quote_as_of, feed: quote.feed };
}
// Yahoo carries the out-of-hours print as it happens, where Alpaca's free
// snapshot runs 15 minutes behind. marketState says whether there is an
// out-of-hours session at all; the timestamps say which print is current,
// because Yahoo leaves the morning's pre-market fields on the quote all day.
function yahooExtendedSession(quote, { now = Date.now() } = {}) {
  if (!quote || quote.marketState === 'REGULAR') return null;
  const base = price(quote.regularMarketPrice);
  const closedAt = +new Date(quote.regularMarketTime);
  if (!base || !(closedAt > 0)) return null;
  const latest = [
    { session: 'pre-market', p: quote.preMarketPrice, t: quote.preMarketTime },
    { session: 'after-hours', p: quote.postMarketPrice, t: quote.postMarketTime },
  ].map(c => ({ ...c, ms: +new Date(c.t) }))
    .filter(c => price(c.p) && c.ms > closedAt && c.ms <= now)
    .sort((a, b) => b.ms - a.ms)[0];
  if (!latest) return null;
  const change = latest.p - base;
  return { session: latest.session, price: latest.p, change, changePct: (change / base) * 100, base, asOf: new Date(latest.ms).toISOString(), feed: 'yahoo' };
}
// A thinly traded name can have a newer print on one feed than the other, so
// neither source is simply preferred: the later trade is the current price.
// Compared in whole seconds because Yahoo stamps seconds and Alpaca nanoseconds,
// and the same trade on both feeds has to tie rather than favour the delayed one.
function newestExtended(a, b) {
  if (!a || !b) return a ?? b ?? null;
  const second = x => Math.floor(Date.parse(x.asOf) / 1000);
  return second(b) > second(a) ? b : a;
}
module.exports = { quoteFromSnapshot, extendedSession, yahooExtendedSession, newestExtended };
