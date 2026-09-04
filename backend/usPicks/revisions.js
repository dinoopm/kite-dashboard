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
  const failedSymbols = new Set(); // thrown this run — excluded from `missing`, never cached
  const failures = []; // { symbol, message }, for the one summary console.warn below
  let missing = 0;
  let failed = 0;
  const todo = [];
  for (const s of symbols) {
    const hit = cache.get(s);
    if (hit && Date.now() - hit.ts < TTL) bySymbol.set(s, hit.raw);
    else todo.push(s);
  }
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const results = await Promise.allSettled(chunk.map(s => fetchOne(s)));
    chunk.forEach((s, j) => {
      const res = results[j];
      if (res.status === 'rejected') {
        // A thrown fetch ("we don't know") and a successful fetch that yields
        // no usable data ("Yahoo genuinely has no estimates for this symbol")
        // are different facts. The second is real information and is safe to
        // cache for 24h; the first is a network blip or a rate limit and
        // caching it the same way would silently turn an outage into a day
        // of neutral scores for every symbol it touched. So a throw is
        // counted and logged, not cached — bySymbol still reports null this
        // run (a caller has to rank the symbol somehow) but the next call
        // retries it instead of serving a stale non-answer.
        failed++;
        failedSymbols.add(s);
        failures.push({ symbol: s, message: res.reason?.message || String(res.reason) });
        bySymbol.set(s, null);
      } else {
        const raw = revisionsRawFrom(res.value);
        cache.set(s, { raw, ts: Date.now() });
        bySymbol.set(s, raw);
      }
    });
    if (gapMs && i + CHUNK < todo.length) await new Promise(r => setTimeout(r, gapMs));
  }
  for (const [s, v] of bySymbol) if (v == null && !failedSymbols.has(s)) missing++;
  if (failed > 0) {
    const example = failures[0];
    console.warn(`[usPicks/revisions] ${failed} of ${symbols.length} fetches threw and were left uncached for retry — e.g. ${example.symbol}: ${example.message}`);
  }
  return { bySymbol, missing, failed };
}

module.exports = { revisionsRawFrom, fetchRevisions, _resetCache };
