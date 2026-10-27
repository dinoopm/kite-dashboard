const axios = require('axios');
const HISTORY_URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv';
const positive = value => Number.isFinite(value) && value > 0;
const marketDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

function parseVixHistory(csv) {
  const rows = String(csv).trim().split(/\r?\n/);
  if (rows.shift()?.replace(/^\uFEFF/, '').trim() !== 'DATE,OPEN,HIGH,LOW,CLOSE') throw new Error('Unexpected VIX history format');
  const points = new Map();
  for (const row of rows) {
    const [date, , , , rawClose] = row.split(',');
    const match = date?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const close = rawClose?.trim() ? Number(rawClose) : NaN;
    if (!match || !positive(close)) continue;
    const iso = `${match[3]}-${match[1]}-${match[2]}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== iso) continue;
    points.set(iso, { date: iso, close });
  }
  const series = [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (series.length < 2) throw new Error('VIX history unavailable');
  return series;
}

function vixSnapshot(history, quote, now = new Date()) {
  const series = history.map(point => ({ ...point }));
  const last = series.at(-1);
  const time = quote?.regularMarketTime == null ? new Date(NaN) : new Date(quote.regularMarketTime);
  // Never relabel an older quote as current or let it overwrite newer official history.
  const usable = positive(quote?.regularMarketPrice) && Number.isFinite(+time) && +time <= +now + 60_000
    && (!last || marketDay(time) >= last.date);
  const quoteDay = usable ? marketDay(time) : null;
  // A gap in the daily file must not turn an older close into yesterday's close.
  const prior = usable ? (last?.date === quoteDay ? series.at(-2)?.close : null) : series.at(-2)?.close;
  const previousClose = usable && positive(quote.regularMarketPreviousClose) ? quote.regularMarketPreviousClose : prior ?? null;
  const current = usable ? quote.regularMarketPrice : last?.close;
  if (!positive(current)) throw new Error('US VIX data unavailable');
  if (usable) {
    const point = { date: quoteDay, close: current, provisional: true };
    if (last?.date === quoteDay) series[series.length - 1] = point;
    else series.push(point);
  }
  const change = positive(previousClose) ? current - previousClose : null;
  return {
    symbol: '^VIX', current, previousClose, change,
    changePct: change == null ? null : change / previousClose * 100,
    asOf: usable ? time.toISOString() : last.date,
    kind: usable ? 'quote' : 'daily-close',
    delayMinutes: usable && Number.isFinite(quote.exchangeDataDelayedBy) ? quote.exchangeDataDelayedBy : null,
    source: usable ? 'Yahoo Finance · Cboe VIX (^VIX)' : 'Cboe · official daily close',
    historySource: 'Cboe · daily closing values',
    historyAsOf: last?.date ?? null, series,
  };
}

async function fetchVixHistory() { return parseVixHistory((await axios.get(HISTORY_URL, { timeout: 15_000 })).data); }

function createVixService({ fetchHistory = fetchVixHistory, fetchQuote, now = () => new Date() }) {
  let history = null, historyAt = 0, cached = null, cachedAt = 0, pending = null;
  return async function getVix() {
    const stamp = +now();
    if (cached && stamp - cachedAt < 60_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const needsHistory = !history || stamp - historyAt >= 6 * 3600_000;
      const results = await Promise.allSettled([
        needsHistory ? fetchHistory() : Promise.resolve(history),
        fetchQuote(),
      ]);
      if (results[0].status === 'fulfilled') { history = results[0].value; if (needsHistory) historyAt = stamp; }
      const quote = results[1].status === 'fulfilled' ? results[1].value : null;
      // A feed failure can use last successfully fetched history, visibly marked.
      const data = vixSnapshot(history || [], quote, now());
      data.warnings = [];
      if (results[0].status === 'rejected') data.warnings.push(history ? 'History refresh failed; showing cached daily history.' : 'Daily history is unavailable.');
      if (results[1].status === 'rejected') data.warnings.push('Quote unavailable; showing the last available daily close.');
      data.fetchedAt = now().toISOString();
      cached = data; cachedAt = stamp;
      return data;
    })().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { HISTORY_URL, fetchVixHistory, parseVixHistory, vixSnapshot, createVixService };
