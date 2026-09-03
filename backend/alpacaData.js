// ─── Alpaca market-data plumbing shared by the router and the batch engines ──
//
// Lifted out of alpaca.js so a module that is NOT the router — the US picks
// engine, its backtest, its scorer — can fetch bars without requiring the
// 2,600-line router (and, since the router will mount routes that require
// those modules, without a circular require). Nothing here knows about
// Express.

const DATA_BASE = 'https://data.alpaca.markets/v2';
const FEED = process.env.ALPACA_DATA_FEED || 'sip';
const API_KEY = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID;
const API_SECRET = process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY;
const isConfigured = () => Boolean(API_KEY && API_SECRET);

// ─── Tiny in-memory cache (keyed by request URL) ───────────────────────────
const cache = {};    // url -> { data, ts }
const inflight = {}; // url -> Promise (coalesce concurrent identical fetches)

async function alpacaGet(path, params = {}, ttlMs = 60_000) {
  if (!isConfigured()) {
    const err = new Error('Alpaca API keys are not configured');
    err.statusCode = 503;
    err.notConfigured = true;
    throw err;
  }
  const qs = new URLSearchParams({ ...params, feed: params.feed || FEED }).toString();
  const url = `${DATA_BASE}${path}${qs ? `?${qs}` : ''}`;

  const hit = cache[url];
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  if (inflight[url]) return inflight[url];

  inflight[url] = (async () => {
    const resp = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': API_SECRET,
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const err = new Error(`Alpaca ${resp.status}: ${body.slice(0, 300)}`);
      err.statusCode = resp.status === 429 ? 429 : 502;
      throw err;
    }
    const data = await resp.json();
    cache[url] = { data, ts: Date.now() };
    return data;
  })().finally(() => { delete inflight[url]; });

  return inflight[url];
}

// Bars with an absurd wick (a bad print) get the wick clamped to the body.
const sanitizeBar = (b) => {
  const bodyLo = Math.min(b.open, b.close), bodyHi = Math.max(b.open, b.close);
  const low = (b.low <= 0 || b.low < bodyLo * 0.5) ? bodyLo : b.low;
  const high = b.high > bodyHi * 2 ? bodyHi : b.high;
  return (low === b.low && high === b.high) ? b : { ...b, low, high };
};

// Daily bars for many symbols via Alpaca's multi-symbol endpoint — one request
// per 100 symbols, paginated. `get` is injectable only so the chunking and the
// pagination can be tested without the network.
async function fetchBarsMulti(symbols, start, { get = alpacaGet } = {}) {
  const out = {}; // symbol -> candles[]
  const CHUNK = 100;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    let pageToken = null, guard = 0;
    do {
      const params = { symbols: chunk.join(','), timeframe: '1Day', start: start.toISOString(), limit: 10000, adjustment: 'all' };
      if (pageToken) params.page_token = pageToken;
      const data = await get('/stocks/bars', params, 60 * 60 * 1000);
      const bars = data?.bars || {};
      for (const s of Object.keys(bars)) {
        (out[s] = out[s] || []).push(...bars[s].map(b => sanitizeBar({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
      }
      pageToken = data?.next_page_token || null;
    } while (pageToken && ++guard < 60);
  }
  return out;
}

module.exports = { alpacaGet, sanitizeBar, fetchBarsMulti, isConfigured, FEED, DATA_BASE, API_KEY, API_SECRET };
