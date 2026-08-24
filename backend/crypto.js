// ─── Alpaca crypto market data ───────────────────────────────────────────────
//
// A different API from the equities one: /v1beta3/crypto/{loc} rather than /v2,
// pair symbols like BTC/USD, and no `feed` parameter — which is why alpacaGet
// cannot be reused, since it hardcodes the v2 base and always appends a feed.
//
// DATA ONLY. Nothing here can place an order.
//
// Two limits that decide what this data may honestly be used for, both stated
// on the page rather than buried here:
//
// 1. THE VOLUME IS ALPACA'S OWN BOOK. Equities have a consolidated tape, so the
//    sip feed sees essentially every share traded and the iex feed's 2-3% was a
//    bug to be caught (see feedAgreement.js). Crypto has no consolidated tape at
//    all: this is what crossed Alpaca's venue, not what traded in Bitcoin. There
//    is no fuller feed to switch to, so relative-volume or volume-thrust logic
//    built on it would measure Alpaca's liquidity rather than the market's.
//
// 2. IT TRADES 24/7. Every horizon in this app is counted in SESSIONS, and
//    calendars are built through signals/marketSeries.mergeCalendars against
//    NSE. Crypto has no sessions, no closes and no gaps, so a "20-day breakout"
//    is not the same object here and a daily bar depends on an arbitrary UTC
//    cutoff. That is why this module serves prices and volume and NOTHING that
//    claims to predict them: a signal here would need its own calendar and its
//    own track record before it could mean anything.

const express = require('express');
const router = express.Router();

const CRYPTO_BASE = 'https://data.alpaca.markets/v1beta3/crypto/us';
const API_KEY = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID;
const API_SECRET = process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY;

// Crypto market data is served without a subscription, but the keys are still
// sent when present — an authenticated call gets the better rate limit.
const authHeaders = () => (API_KEY && API_SECRET
  ? { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET, Accept: 'application/json' }
  : { Accept: 'application/json' });

// The liquid USD pairs Alpaca supports. Hardcoded rather than discovered: the
// assets endpoint needs trading credentials, and a data-only module should not
// require them.
const PAIRS = [
  { pair: 'BTC/USD', name: 'Bitcoin' },
  { pair: 'ETH/USD', name: 'Ethereum' },
  { pair: 'SOL/USD', name: 'Solana' },
  { pair: 'AVAX/USD', name: 'Avalanche' },
  { pair: 'LINK/USD', name: 'Chainlink' },
  { pair: 'LTC/USD', name: 'Litecoin' },
  { pair: 'BCH/USD', name: 'Bitcoin Cash' },
  { pair: 'UNI/USD', name: 'Uniswap' },
  { pair: 'AAVE/USD', name: 'Aave' },
  { pair: 'DOT/USD', name: 'Polkadot' },
  { pair: 'DOGE/USD', name: 'Dogecoin' },
  { pair: 'SHIB/USD', name: 'Shiba Inu' },
];
const PAIR_NAME = new Map(PAIRS.map(p => [p.pair, p.name]));

// URL-safe form for a route parameter: BTC/USD <-> BTC-USD. A slash in a path
// segment would need double-encoding and survives proxies badly.
const toPair = (slug) => String(slug).toUpperCase().replace('-', '/');
const toSlug = (pair) => pair.replace('/', '-');

const cache = {};
const inflight = {};

async function cryptoGet(path, params = {}, ttlMs = 30_000) {
  const qs = new URLSearchParams(params).toString();
  const url = `${CRYPTO_BASE}${path}${qs ? `?${qs}` : ''}`;

  const hit = cache[url];
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  if (inflight[url]) return inflight[url];

  inflight[url] = (async () => {
    const resp = await fetch(url, { headers: authHeaders() });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const err = new Error(`Alpaca crypto ${resp.status}: ${body.slice(0, 300)}`);
      err.statusCode = resp.status === 429 ? 429 : 502;
      throw err;
    }
    const data = await resp.json();
    cache[url] = { data, ts: Date.now() };
    return data;
  })().finally(() => { delete inflight[url]; });

  return inflight[url];
}

const num = (v) => (v == null || !Number.isFinite(v) ? null : v);

/**
 * Latest daily bar per pair, with the change against the previous one.
 *
 * "24h change" is deliberately NOT what this reports. A daily bar closes at an
 * arbitrary UTC boundary on a market that never closes, so bar-over-bar change
 * is a statement about two UTC days rather than about the last 24 hours. The
 * field is named for what it is.
 */
router.get('/snapshots', async (req, res) => {
  try {
    const symbols = PAIRS.map(p => p.pair).join(',');
    const data = await cryptoGet('/bars', {
      symbols, timeframe: '1Day', limit: 1000,
      start: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    const rows = PAIRS.map(({ pair, name }) => {
      const bars = data?.bars?.[pair] || [];
      const last = bars[bars.length - 1];
      const prev = bars[bars.length - 2];
      const close = num(last?.c);
      const prevClose = num(prev?.c);
      return {
        pair, slug: toSlug(pair), name,
        close,
        prevClose,
        changePct: (close != null && prevClose) ? ((close / prevClose) - 1) * 100 : null,
        volume: num(last?.v),
        trades: num(last?.n),
        vwap: num(last?.vw),
        barStart: last?.t || null,
      };
    });
    res.json({
      rows,
      venue: 'Alpaca',
      caveat: 'Volume is what crossed Alpaca\'s own venue. Crypto has no consolidated tape, so this is not total market volume and there is no fuller feed to switch to.',
      barNote: 'Daily bars close at a UTC boundary on a market that never closes, so change is bar-over-bar, not a rolling 24 hours.',
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * The bar size is chosen BY the range, not offered alongside it.
 *
 * They are not independent: five years of 5-minute bars is half a million
 * candles nobody can read and Alpaca will not return in one page, and one day
 * of daily bars is a single candle. Each row below keeps the count in the
 * hundreds — the largest is 5Y at ~1,825 — which fits one request and stays
 * legible.
 */
const RANGES = {
  '1D': { timeframe: '5Min',  days: 1 },
  '1W': { timeframe: '1Hour', days: 7 },
  '1M': { timeframe: '1Hour', days: 30 },
  '3M': { timeframe: '4Hour', days: 90 },
  '6M': { timeframe: '1Day',  days: 180 },
  '1Y': { timeframe: '1Day',  days: 365 },
  '2Y': { timeframe: '1Day',  days: 730 },
  '3Y': { timeframe: '1Day',  days: 1095 },
  '4Y': { timeframe: '1Day',  days: 1460 },
  '5Y': { timeframe: '1Day',  days: 1825 },
};

/** Candles for one pair. `slug` is BTC-USD; Alpaca wants BTC/USD. */
router.get('/bars/:slug', async (req, res) => {
  const pair = toPair(req.params.slug);
  if (!PAIR_NAME.has(pair)) return res.status(404).json({ error: `Unsupported pair: ${pair}` });

  const range = String(req.query.range || '1Y').toUpperCase();
  const spec = RANGES[range];
  if (!spec) {
    return res.status(400).json({ error: `Unsupported range: ${range}`, supported: Object.keys(RANGES) });
  }

  try {
    const requestedFrom = new Date(Date.now() - spec.days * 86400000).toISOString();
    const data = await cryptoGet('/bars', {
      symbols: pair, timeframe: spec.timeframe, limit: 10000, start: requestedFrom,
    });
    const bars = (data?.bars?.[pair] || []).map(b => ({
      date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw, trades: b.n,
    }));
    // Alpaca's crypto history does not reach back equally far for every pair —
    // a newer listing simply has less. Returning what was ASKED FOR alongside
    // what arrived lets the page say "only 14 months exist" instead of drawing
    // a short series under a 5Y label as though that were the whole story.
    res.json({
      pair, name: PAIR_NAME.get(pair),
      range, timeframe: spec.timeframe,
      requestedFrom,
      firstBar: bars[0]?.date || null,
      bars,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/pairs', (req, res) => res.json({ pairs: PAIRS.map(p => ({ ...p, slug: toSlug(p.pair) })) }));

module.exports = { cryptoRouter: router, PAIRS, RANGES, toPair, toSlug };
