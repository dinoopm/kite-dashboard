// ─── EPS estimate revisions (Yahoo earningsTrend) ────────────────────────────
//
// The one factor here that is not price. It cannot be backtested — Yahoo
// exposes only the CURRENT estimate and the count of revisions in the last 30
// days, with no vintage history — so it is scored forward only, from the
// percentiles the daily snapshot records. Until ~20 snapshot days have
// resolved its badge says so.
//
// ~560 quoteSummary calls a day, chunked and cached 24h, run inside the daily
// job rather than on page load.

const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const TTL = 24 * 60 * 60 * 1000;
const CHUNK = 8;
let cache = new Map(); // symbol -> { raw, ts }
const _resetCache = () => { cache = new Map(); };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 0.5 · net revision ratio + 0.5 · clamped 30-day trend change. Either half
 * alone when the other is missing; null when both are.
 */
function revisionsRawFrom(earningsTrend) {
  const row = (earningsTrend?.trend || []).find(t => t.period === '0y');
  if (!row) return null;
  const up = row.epsRevisions?.upLast30days ?? 0;
  const down = row.epsRevisions?.downLast30days ?? 0;
  const net = up + down > 0 ? (up - down) / (up + down) : null;
  const now = row.epsTrend?.current, ago = row.epsTrend?.['30daysAgo'];
  const trend = (now != null && ago != null && ago !== 0) ? clamp(now / ago - 1, -0.2, 0.2) / 0.2 : null;
  if (net == null && trend == null) return null;
  if (net == null) return trend;
  if (trend == null) return net;
  return 0.5 * net + 0.5 * trend;
}

async function yahooEarningsTrend(symbol) {
  const q = await yf.quoteSummary(symbol.replace(/\./g, '-'), { modules: ['earningsTrend'] }, { validateResult: false });
  return q?.earningsTrend || null;
}

async function fetchRevisions(symbols, { fetchOne = yahooEarningsTrend, gapMs = 150 } = {}) {
  const bySymbol = new Map();
  let missing = 0;
  const todo = [];
  for (const s of symbols) {
    const hit = cache.get(s);
    if (hit && Date.now() - hit.ts < TTL) bySymbol.set(s, hit.raw);
    else todo.push(s);
  }
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const rows = await Promise.all(chunk.map(s => fetchOne(s).catch(() => null)));
    chunk.forEach((s, j) => {
      const raw = revisionsRawFrom(rows[j]);
      cache.set(s, { raw, ts: Date.now() });
      bySymbol.set(s, raw);
    });
    if (gapMs && i + CHUNK < todo.length) await new Promise(r => setTimeout(r, gapMs));
  }
  for (const v of bySymbol.values()) if (v == null) missing++;
  return { bySymbol, missing };
}

module.exports = { revisionsRawFrom, fetchRevisions, _resetCache };
