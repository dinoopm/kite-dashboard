// ─── Alpaca US market-data integration ─────────────────────────────────────
// A self-contained Express router that tracks US indices / sectors via Alpaca's
// market-data API (https://data.alpaca.markets/v2). This is DATA-ONLY: it never
// touches the trading API (no account, positions, or orders), so the only
// credentials it needs are a free Alpaca API key + secret (a paper-account
// signup is enough to get data keys).
//
// Alpaca's stock data API serves equities/ETFs, not raw index symbols, so we
// track liquid ETF proxies: SPY≈S&P 500, QQQ≈Nasdaq 100, DIA≈Dow 30, etc., plus
// the SPDR sector ETFs. The free "iex" feed is used by default (15-min delayed);
// set ALPACA_DATA_FEED=sip if the account has a paid SIP subscription.
const express = require('express');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
// Reuse the exact screener engine the Indian screener uses — it operates on raw
// daily candles, which is precisely the shape Alpaca bars produce.
const { SCREENER_FIELDS, computeScreenerRow, validateConditions, evaluateConditions } = require('./screener/engine');
const { getSP500, getNasdaq100 } = require('./usUniverses');
const { getEtfHoldings } = require('./etfHoldings');
const MIN_SCREENER_BARS = 60;

// Supabase for persisting US user data (baskets, virtual portfolios, screens).
// Reads env that server.js already loaded via dotenv before requiring this file.
const { createClient } = require('@supabase/supabase-js');
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const requireDb = (res) => { if (!supabase) { res.status(503).json({ error: 'Supabase not configured' }); return false; } return true; };

const DATA_BASE = 'https://data.alpaca.markets/v2';
// Trading API base — used only for read-only asset metadata (company names).
// Paper keys work against the paper host; override if using a live account.
const TRADING_BASE = process.env.ALPACA_TRADING_BASE || 'https://paper-api.alpaca.markets';
const FEED = process.env.ALPACA_DATA_FEED || 'iex';

const API_KEY = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID;
const API_SECRET = process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY;
const isConfigured = () => Boolean(API_KEY && API_SECRET);

// Broad-market index proxies, shown as headline cards.
const BROAD_INDICES = [
  { symbol: 'SPY', label: 'S&P 500',      proxyFor: 'S&P 500 Index' },
  { symbol: 'QQQ', label: 'Nasdaq 100',   proxyFor: 'Nasdaq 100 Index' },
  { symbol: 'DIA', label: 'Dow 30',       proxyFor: 'Dow Jones Industrial Avg' },
  { symbol: 'IWM', label: 'Russell 2000', proxyFor: 'Russell 2000 Index' },
  { symbol: 'VTI', label: 'Total Market', proxyFor: 'US Total Stock Market' },
];

// SPDR sector ETFs — a clean 1:1 mapping to the 11 GICS sectors.
const SECTOR_ETFS = [
  { symbol: 'XLK',  label: 'Technology' },
  { symbol: 'XLF',  label: 'Financials' },
  { symbol: 'XLV',  label: 'Health Care' },
  { symbol: 'XLY',  label: 'Consumer Discretionary' },
  { symbol: 'XLP',  label: 'Consumer Staples' },
  { symbol: 'XLE',  label: 'Energy' },
  { symbol: 'XLI',  label: 'Industrials' },
  { symbol: 'XLB',  label: 'Materials' },
  { symbol: 'XLRE', label: 'Real Estate' },
  { symbol: 'XLU',  label: 'Utilities' },
  { symbol: 'XLC',  label: 'Communication Services' },
];

const META_BY_SYMBOL = {};
for (const m of [...BROAD_INDICES, ...SECTOR_ETFS]) META_BY_SYMBOL[m.symbol] = m;

// ─── Tiny in-memory cache (keyed by request URL) ───────────────────────────
const cache = {}; // url -> { data, ts }
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

// ─── Company-name lookup (Alpaca asset metadata, 24h cache) ─────────────────
const assetNameCache = {}; // symbol -> { name, ts }
const ASSET_NAME_TTL = 24 * 60 * 60 * 1000;
async function fetchAssetName(symbol) {
  const sym = symbol.toUpperCase();
  const hit = assetNameCache[sym];
  if (hit && Date.now() - hit.ts < ASSET_NAME_TTL) return hit.name;
  if (!isConfigured()) return null;
  try {
    const resp = await fetch(`${TRADING_BASE}/v2/assets/${encodeURIComponent(sym)}`, {
      headers: { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET, 'Accept': 'application/json' },
    });
    if (!resp.ok) { assetNameCache[sym] = { name: null, ts: Date.now() }; return null; }
    const a = await resp.json();
    const name = a?.name || null;
    assetNameCache[sym] = { name, ts: Date.now() };
    return name;
  } catch {
    return null;
  }
}

// ─── Sector / industry lookup (Yahoo assetProfile, 7-day cache) ─────────────
// Works across any US ticker (S&P, Nasdaq, baskets) — not just GICS members.
const assetSectorCache = {}; // symbol -> { sector, industry, ts }
const ASSET_SECTOR_TTL = 7 * 24 * 60 * 60 * 1000;
async function fetchAssetSector(symbol) {
  const sym = symbol.toUpperCase();
  const hit = assetSectorCache[sym];
  if (hit && Date.now() - hit.ts < ASSET_SECTOR_TTL) return hit;
  try {
    const r = await yf.quoteSummary(sym, { modules: ['assetProfile'] }, { validateResult: false });
    const p = r?.assetProfile || {};
    const out = { sector: p.sector || null, industry: p.industry || null, ts: Date.now() };
    assetSectorCache[sym] = out;
    return out;
  } catch {
    const out = { sector: null, industry: null, ts: Date.now() };
    assetSectorCache[sym] = out; // negative-cache so a bad symbol isn't retried each scan
    return out;
  }
}

// Build a quote summary { last, prevClose, change, changePct, high, low, volume }
// from an Alpaca snapshot object.
function summariseSnapshot(snap) {
  if (!snap) return null;
  const daily = snap.dailyBar || {};
  const prev = snap.prevDailyBar || {};
  const last = snap.latestTrade?.p ?? daily.c ?? null;
  const prevClose = prev.c ?? null;
  const change = last != null && prevClose != null ? last - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
  return {
    last,
    prevClose,
    change,
    changePct,
    open: daily.o ?? null,
    high: daily.h ?? null,
    low: daily.l ?? null,
    volume: daily.v ?? null,
    asOf: snap.latestTrade?.t || daily.t || null,
  };
}

// Map a UI range string to an Alpaca timeframe + lookback start date.
function rangeToQuery(range) {
  const now = new Date();
  const start = new Date(now);
  switch (range) {
    case '1D': start.setDate(now.getDate() - 4);  return { timeframe: '15Min', start };
    case '5D': start.setDate(now.getDate() - 8);  return { timeframe: '1Hour', start };
    case '1W': start.setDate(now.getDate() - 9);  return { timeframe: '1Day', start };
    case '1M': start.setMonth(now.getMonth() - 1); return { timeframe: '1Day', start };
    case '3M': start.setMonth(now.getMonth() - 3); return { timeframe: '1Day', start };
    case '6M': start.setMonth(now.getMonth() - 6); return { timeframe: '1Day', start };
    case '1Y': start.setFullYear(now.getFullYear() - 1); return { timeframe: '1Day', start };
    case '2Y': start.setFullYear(now.getFullYear() - 2); return { timeframe: '1Day', start };
    case '3Y': start.setFullYear(now.getFullYear() - 3); return { timeframe: '1Day', start };
    case '4Y': start.setFullYear(now.getFullYear() - 4); return { timeframe: '1Day', start };
    case '5Y': start.setFullYear(now.getFullYear() - 5); return { timeframe: '1Week', start };
    default:   start.setMonth(now.getMonth() - 6); return { timeframe: '1Day', start };
  }
}

const router = express.Router();

// Lets the frontend decide whether to render data or a "configure keys" CTA.
router.get('/config', (req, res) => {
  res.json({
    configured: isConfigured(),
    feed: FEED,
    indices: BROAD_INDICES,
    sectors: SECTOR_ETFS,
  });
});

// Headline overview: one snapshot call for every tracked symbol, summarised.
router.get('/overview', async (req, res) => {
  try {
    const symbols = [...BROAD_INDICES, ...SECTOR_ETFS].map(m => m.symbol);
    const data = await alpacaGet('/stocks/snapshots', { symbols: symbols.join(',') }, 60_000);
    const snaps = data || {};
    const decorate = (m) => ({ ...m, quote: summariseSnapshot(snaps[m.symbol]) });
    res.json({
      indices: BROAD_INDICES.map(decorate),
      sectors: SECTOR_ETFS.map(decorate),
      feed: FEED,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

// Single-symbol snapshot (detail page header).
router.get('/snapshot/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const [data, name] = await Promise.all([
      alpacaGet(`/stocks/${encodeURIComponent(symbol)}/snapshot`, {}, 30_000),
      fetchAssetName(symbol),
    ]);
    res.json({
      symbol,
      name: name || null,
      meta: META_BY_SYMBOL[symbol] || { symbol, label: symbol },
      quote: summariseSnapshot(data),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

// Historical bars for charting, normalised to the app's {date,open,high,low,close,volume} shape.
router.get('/bars/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const range = req.query.range || '6M';
  const { timeframe, start } = rangeToQuery(range);
  // Daily/weekly bars are cheap to cache for a while; intraday should be fresher.
  const ttl = timeframe.includes('Min') || timeframe.includes('Hour') ? 60_000 : 10 * 60_000;
  try {
    let allBars = [];
    let pageToken = null;
    // Paginate (Alpaca caps at 10k bars/page) — only matters for long intraday ranges.
    do {
      const params = { timeframe, start: start.toISOString(), limit: 10000, adjustment: 'all' };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGet(`/stocks/${encodeURIComponent(symbol)}/bars`, params, ttl);
      if (Array.isArray(data?.bars)) allBars = allBars.concat(data.bars);
      pageToken = data?.next_page_token || null;
    } while (pageToken && allBars.length < 20000);

    const bars = allBars.map(b => ({
      date: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
    res.json({ symbol, range, timeframe, bars });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Kite-shaped mirror endpoints for the US Indices Performance page + drilldown.
// These return the SAME response envelopes the Indian Sector-Indices/Sector-
// Detail pages consume (quotes, historical-full, rrg, sector-constituents), with
// the ticker symbol standing in for Kite's numeric instrument_token. That lets
// the US pages reuse the exact returns/RSI/momentum/RRG logic unchanged.
// ════════════════════════════════════════════════════════════════════════════

// RRG universe — the sector + industry ETFs rotated against the benchmark.
const RRG_US_KEYS = [
  'XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLC',
  'SMH', 'XBI', 'KRE', 'ITB', 'XOP', 'XRT', 'IYT', 'GDX', 'IGV',
];

// Labels for everything the US pages can show (indices, sectors, industries,
// and drilldown constituents) so names render without a second lookup.
const US_LABELS = {
  SPY: 'S&P 500', QQQ: 'Nasdaq 100', DIA: 'Dow 30', IWM: 'Russell 2000',
  VTI: 'Total Market', RSP: 'S&P 500 Equal Wt', MDY: 'S&P MidCap 400',
  IJR: 'S&P SmallCap 600', IWB: 'Russell 1000',
  XLK: 'Technology', XLF: 'Financials', XLV: 'Health Care',
  XLY: 'Consumer Discretionary', XLP: 'Consumer Staples', XLE: 'Energy',
  XLI: 'Industrials', XLB: 'Materials', XLRE: 'Real Estate', XLU: 'Utilities',
  XLC: 'Communication Services', SMH: 'Semiconductors', XBI: 'Biotech',
  KRE: 'Regional Banks', ITB: 'Homebuilders', XOP: 'Oil & Gas E&P',
  XRT: 'Retail', IYT: 'Transports', GDX: 'Gold Miners', IGV: 'Software',
};

// Curated top holdings per ETF (drilldown constituents). Broad indices drill
// into the sector ETFs; sector/industry ETFs drill into representative names.
const US_CONSTITUENTS = {
  SPY:  ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB'],
  QQQ:  ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'AVGO', 'META', 'GOOGL', 'TSLA', 'COST', 'NFLX', 'AMD'],
  DIA:  ['UNH', 'GS', 'MSFT', 'HD', 'CAT', 'AMGN', 'CRM', 'V', 'AXP', 'JPM'],
  IWM:  ['SMCI', 'MSTR', 'FTAI', 'INSM', 'SFM', 'CVNA', 'APP', 'ANF', 'RKLB', 'DUOL'],
  VTI:  ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB'],
  RSP:  ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB'],
  MDY:  ['XLK', 'XLF', 'XLV', 'XLY', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB'],
  IJR:  ['XLK', 'XLF', 'XLV', 'XLY', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB'],
  IWB:  ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB'],
  XLK:  ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'AMD', 'CSCO', 'ACN', 'ADBE', 'QCOM'],
  XLF:  ['BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'AXP', 'MS', 'SPGI', 'BLK'],
  XLV:  ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'ISRG', 'AMGN', 'PFE'],
  XLY:  ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG', 'LOW', 'TJX', 'NKE', 'SBUX', 'CMG'],
  XLP:  ['COST', 'WMT', 'PG', 'KO', 'PEP', 'PM', 'MO', 'MDLZ', 'CL', 'TGT'],
  XLE:  ['XOM', 'CVX', 'COP', 'WMB', 'EOG', 'KMI', 'SLB', 'OKE', 'PSX', 'MPC'],
  XLI:  ['GE', 'CAT', 'RTX', 'UBER', 'HON', 'BA', 'UNP', 'ETN', 'DE', 'LMT'],
  XLB:  ['LIN', 'SHW', 'ECL', 'FCX', 'NEM', 'APD', 'CTVA', 'DOW', 'NUE', 'DD'],
  XLRE: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG', 'PSA', 'O', 'DLR', 'CCI', 'CBRE'],
  XLU:  ['NEE', 'SO', 'DUK', 'CEG', 'AEP', 'SRE', 'D', 'EXC', 'PEG', 'XEL'],
  XLC:  ['META', 'GOOGL', 'GOOG', 'NFLX', 'DIS', 'T', 'VZ', 'TMUS', 'CMCSA', 'EA'],
  SMH:  ['NVDA', 'TSM', 'AVGO', 'AMD', 'QCOM', 'TXN', 'AMAT', 'LRCX', 'KLAC', 'MU'],
  XBI:  ['VRTX', 'GILD', 'INSM', 'ALNY', 'NBIX', 'EXEL', 'HALO', 'UTHR', 'IONS', 'ARWR'],
  KRE:  ['WAL', 'EWBC', 'RF', 'KEY', 'CFG', 'HBAN', 'FITB', 'PNC', 'TFC', 'ZION'],
  ITB:  ['DHI', 'LEN', 'PHM', 'NVR', 'HD', 'LOW', 'SHW', 'BLDR', 'MAS', 'TOL'],
  XOP:  ['COP', 'EOG', 'FANG', 'DVN', 'OXY', 'MRO', 'HES', 'APA', 'CTRA', 'OVV'],
  XRT:  ['ANF', 'ORLY', 'AZO', 'GPS', 'DKS', 'BBY', 'ULTA', 'TJX', 'ROST', 'KSS'],
  IYT:  ['UBER', 'UNP', 'UPS', 'CSX', 'NSC', 'FDX', 'ODFL', 'DAL', 'UAL', 'JBHT'],
  GDX:  ['NEM', 'AEM', 'GOLD', 'WPM', 'FNV', 'KGC', 'GFI', 'AU', 'PAAS', 'HMY'],
  IGV:  ['CRM', 'ORCL', 'ADBE', 'NOW', 'PLTR', 'PANW', 'CRWD', 'MSFT', 'INTU', 'SNOW'],
};

const labelFor = (sym) => US_LABELS[sym] || sym;

// ─── Daily bars cache (4y) keyed by symbol, with coalescing ─────────────────
const dailyBarsCache = {};     // symbol -> { data, ts }
const dailyBarsInflight = {};  // symbol -> Promise
const DAILY_BARS_TTL = 60 * 60 * 1000; // 1h

async function fetchDailyBars(symbol, years = 4) {
  const sym = symbol.toUpperCase();
  const hit = dailyBarsCache[sym];
  if (hit && Date.now() - hit.ts < DAILY_BARS_TTL) return hit.data;
  if (dailyBarsInflight[sym]) return dailyBarsInflight[sym];

  dailyBarsInflight[sym] = (async () => {
    const start = new Date();
    start.setFullYear(start.getFullYear() - years);
    let allBars = [];
    let pageToken = null;
    do {
      const params = { timeframe: '1Day', start: start.toISOString(), limit: 10000, adjustment: 'all' };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGet(`/stocks/${encodeURIComponent(sym)}/bars`, params, DAILY_BARS_TTL);
      if (Array.isArray(data?.bars)) allBars = allBars.concat(data.bars);
      pageToken = data?.next_page_token || null;
    } while (pageToken && allBars.length < 12000);
    const bars = allBars.map(b => ({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
    if (bars.length > 0) dailyBarsCache[sym] = { data: bars, ts: Date.now() };
    return bars;
  })().finally(() => { delete dailyBarsInflight[sym]; });

  return dailyBarsInflight[sym];
}

// ─── RRG math (ported from the backend's Kite RRG so output is identical) ────
function resampleToWeekly(dailyCandles) {
  const weeks = [];
  let currentWeek = null;
  for (const c of dailyCandles) {
    const d = new Date(c.date);
    const day = d.getDay();
    const friday = new Date(d);
    friday.setDate(d.getDate() + (5 - day));
    const weekKey = friday.toISOString().split('T')[0];
    if (!currentWeek || currentWeek.key !== weekKey) {
      currentWeek = { key: weekKey, close: c.close, date: c.date };
      weeks.push(currentWeek);
    } else {
      currentWeek.close = c.close;
      currentWeek.date = c.date;
    }
  }
  return weeks;
}
function computeEMA(values, period) {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) ema.push(values[i] * k + ema[i - 1] * (1 - k));
  return ema;
}
function computeSMA(values, period) {
  const sma = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { sma.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    sma.push(sum / period);
  }
  return sma;
}

// ─── POST /api/us/quotes — Kite get_quotes shape ────────────────────────────
router.post('/quotes', async (req, res) => {
  try {
    const instruments = Array.isArray(req.body?.instruments) ? req.body.instruments : [];
    const symbols = instruments.map(s => String(s).toUpperCase());
    if (symbols.length === 0) return res.json({ content: [{ type: 'text', text: '{}' }] });
    const data = await alpacaGet('/stocks/snapshots', { symbols: symbols.join(',') }, 60_000);
    const out = {};
    for (const sym of symbols) {
      const snap = data?.[sym];
      const daily = snap?.dailyBar || {};
      const prev = snap?.prevDailyBar || {};
      const last = snap?.latestTrade?.p ?? daily.c ?? null;
      const prevClose = prev.c ?? null;
      out[sym] = {
        instrument_token: sym,
        last_price: last,
        net_change: last != null && prevClose != null ? last - prevClose : null,
        ohlc: { open: daily.o ?? null, high: daily.h ?? null, low: daily.l ?? null, close: prevClose },
      };
    }
    res.json({ content: [{ type: 'text', text: JSON.stringify(out) }] });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

// ─── POST /api/us/historical-full/cached — which symbols are already warm ────
router.post('/historical-full/cached', (req, res) => {
  const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens.map(s => String(s).toUpperCase()) : [];
  const now = Date.now();
  const cachedTokens = tokens.filter(t => dailyBarsCache[t] && now - dailyBarsCache[t].ts < DAILY_BARS_TTL);
  res.json({ cachedTokens });
});

// ─── GET /api/us/historical-full/:symbol — 4y daily, Kite envelope ──────────
router.get('/historical-full/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const wasCached = !!(dailyBarsCache[sym] && Date.now() - dailyBarsCache[sym].ts < DAILY_BARS_TTL);
    const data = await fetchDailyBars(sym, 4);
    res.json({ cached: wasCached, content: [{ type: 'text', text: JSON.stringify(data || []) }] });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

// ─── GET /api/us/rrg — relative rotation graph vs benchmark ─────────────────
router.get('/rrg', async (req, res) => {
  try {
    const benchmark = (req.query.benchmark || 'SPY').toUpperCase();
    let keys = RRG_US_KEYS;
    if (req.query.securities) {
      const raw = decodeURIComponent(req.query.securities);
      keys = (raw.startsWith('[') ? JSON.parse(raw) : raw.split(',')).map(s => String(s).trim().toUpperCase());
    }

    const benchDaily = await fetchDailyBars(benchmark, 4);
    if (!benchDaily || benchDaily.length === 0) {
      return res.json({ ready: false, benchmark, sectors: [], message: 'Benchmark history unavailable' });
    }
    const benchWeekly = resampleToWeekly(benchDaily);
    const benchMap = {};
    for (const w of benchWeekly) benchMap[w.key] = w.close;

    const sectors = [];
    for (const key of keys) {
      let daily;
      try { daily = await fetchDailyBars(key, 4); } catch { continue; }
      if (!daily || daily.length === 0) continue;
      const weekly = resampleToWeekly(daily);

      const aligned = [];
      for (const sw of weekly) {
        const bClose = benchMap[sw.key];
        if (bClose && bClose > 0) aligned.push({ weekKey: sw.key, sectorClose: sw.close, benchClose: bClose });
      }
      if (aligned.length < 26) continue;

      const ratioSmaWindow = aligned.length >= 52 ? 52 : 26;
      const momSmaWindow = aligned.length >= 52 ? 26 : 13;
      const rawRS = aligned.map(a => (a.sectorClose / a.benchClose) * 100);
      const rsSmooth = computeEMA(rawRS, 10);
      const rsSmoothSMA = computeSMA(rsSmooth, ratioSmaWindow);
      const rsRatio = rsSmooth.map((v, i) => (rsSmoothSMA[i] == null || rsSmoothSMA[i] === 0) ? null : (v / rsSmoothSMA[i]) * 100);

      const firstValidIdx = rsRatio.findIndex(v => v !== null && v !== 0);
      const rsMomentum = rsRatio.map(() => null);
      if (firstValidIdx >= 0) {
        const validSlice = rsRatio.slice(firstValidIdx);
        const validSliceSMA = computeSMA(validSlice, momSmaWindow);
        for (let i = 0; i < validSlice.length; i++) {
          const v = validSlice[i], sma = validSliceSMA[i];
          if (v == null || v === 0 || sma == null || sma === 0) continue;
          rsMomentum[firstValidIdx + i] = (v / sma) * 100;
        }
      }

      const series = [];
      for (let i = aligned.length - 1; i >= 0 && series.length < 52; i--) {
        if (rsRatio[i] !== null && rsRatio[i] !== 0 && rsMomentum[i] !== null) {
          series.unshift({
            date: aligned[i].weekKey,
            rsRatio: parseFloat(rsRatio[i].toFixed(2)),
            rsMomentum: parseFloat(rsMomentum[i].toFixed(2)),
          });
        }
      }
      if (series.length === 0) continue;

      const latest = series[series.length - 1];
      let quadrant = 'Lagging';
      if (latest.rsRatio >= 100 && latest.rsMomentum >= 100) quadrant = 'Leading';
      else if (latest.rsRatio >= 100 && latest.rsMomentum < 100) quadrant = 'Weakening';
      else if (latest.rsRatio < 100 && latest.rsMomentum >= 100) quadrant = 'Improving';

      sectors.push({ name: labelFor(key), key, token: key, quadrant, series });
    }

    const ready = sectors.length >= Math.min(keys.length, Math.ceil(keys.length * 0.7));
    res.json({ ready, benchmark, generatedAt: new Date().toISOString(), sectors });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

// ─── GET /api/us/sector-constituents/:symbol — drilldown holdings ───────────
// SPDR sector ETFs drill into their FULL GICS membership from the S&P 500
// (e.g. XLK → all ~74 Information Technology names), not a curated top-10.
const SECTOR_ETF_TO_GICS = {
  XLK: 'Information Technology', XLF: 'Financials', XLV: 'Health Care',
  XLY: 'Consumer Discretionary', XLP: 'Consumer Staples', XLE: 'Energy',
  XLI: 'Industrials', XLB: 'Materials', XLRE: 'Real Estate',
  XLU: 'Utilities', XLC: 'Communication Services',
};
const mkConstituent = (s, name) => ({ key: s, symbol: s, token: s, tradingsymbol: s, instrument_token: s, name: name || s, exchange: 'US' });

// Industry/thematic ETFs whose drilldown shows real, full membership fetched
// live (see etfHoldings.js). Broad indices and GICS sector ETFs are handled
// above and intentionally excluded.
const LIVE_HOLDINGS_FUNDS = new Set(['SMH', 'XBI', 'KRE', 'ITB', 'XOP', 'XRT', 'IYT', 'GDX', 'IGV', 'DIA']);

// Industry/thematic universes the screener can scan in addition to the 11 GICS
// sectors. Each resolves to its ETF's live holdings (see resolveUsUniverse).
const US_INDUSTRY_ETFS = ['SMH', 'XBI', 'KRE', 'ITB', 'XOP', 'XRT', 'IYT', 'GDX', 'IGV'];

router.get('/sector-constituents/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    // Full GICS sector membership (names already come from the index scrape).
    const gics = SECTOR_ETF_TO_GICS[sym];
    if (gics) {
      const members = (await getSP500()).filter(x => (x.sector || '').toLowerCase() === gics.toLowerCase());
      return res.json({
        sector: { key: sym, name: `${labelFor(sym)} (S&P 500)` },
        constituents: members.map(m => mkConstituent(m.symbol, m.name)),
      });
    }
    // QQQ drills into the full Nasdaq 100.
    if (sym === 'QQQ') {
      const members = await getNasdaq100();
      return res.json({
        sector: { key: sym, name: 'Nasdaq 100' },
        constituents: members.map(m => mkConstituent(m.symbol, m.name)),
      });
    }
    // Industry/thematic ETFs → live, full holdings from the issuer (SSGA xlsx)
    // or StockAnalysis. Broad indices (SPY, VTI, …) deliberately stay mapped to
    // their sector ETFs via the curated list below, so they're excluded here.
    if (LIVE_HOLDINGS_FUNDS.has(sym)) {
      const live = await getEtfHoldings(sym).catch(() => null);
      if (live?.length) {
        return res.json({
          sector: { key: sym, name: labelFor(sym) },
          constituents: live.map(h => mkConstituent(h.symbol, h.name)),
        });
      }
    }
    // Everything else (and the live fallback) → curated list with names.
    const list = US_CONSTITUENTS[sym];
    if (!list) return res.status(404).json({ error: `No constituents defined for ${sym}` });
    const names = await Promise.all(list.map(s => fetchAssetName(s).catch(() => null)));
    res.json({
      sector: { key: sym, name: labelFor(sym) },
      constituents: list.map((s, i) => mkConstituent(s, names[i])),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/us/search — US ticker/name search (Yahoo) ─────────────────────
const US_EXCHANGES = new Set(['NMS', 'NYQ', 'PCX', 'ASE', 'NGM', 'NCM', 'BATS', 'BTS']);
const searchCache = {}; // q -> { data, ts }
const SEARCH_TTL = 5 * 60 * 1000;
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const key = q.toLowerCase();
  const hit = searchCache[key];
  if (hit && Date.now() - hit.ts < SEARCH_TTL) return res.json(hit.data);
  try {
    const r = await yf.search(q, { quotesCount: 15, newsCount: 0, enableFuzzyQuery: false }, { validateResult: false });
    const allowed = new Set(['EQUITY', 'ETF']);
    const results = (r.quotes || [])
      .filter(x => x.symbol && allowed.has(x.quoteType) && (US_EXCHANGES.has(x.exchange) || !x.symbol.includes('.')))
      .map(x => ({
        symbol: x.symbol,
        name: x.shortname || x.longname || x.symbol,
        exchange: x.exchDisp || x.exchange || '',
        type: x.quoteType === 'ETF' ? 'ETF' : 'EQ',
      }))
      .slice(0, 10);
    const payload = { results };
    searchCache[key] = { data: payload, ts: Date.now() };
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/us/global-indices — world markets performance (Yahoo) ─────────
const GLOBAL_INDICES = [
  // Americas
  { symbol: '^GSPC', label: 'S&P 500', region: 'Americas', country: 'United States' },
  { symbol: '^DJI', label: 'Dow Jones', region: 'Americas', country: 'United States' },
  { symbol: '^IXIC', label: 'Nasdaq Composite', region: 'Americas', country: 'United States' },
  { symbol: '^RUT', label: 'Russell 2000', region: 'Americas', country: 'United States' },
  { symbol: '^GSPTSE', label: 'S&P/TSX Composite', region: 'Americas', country: 'Canada' },
  { symbol: '^BVSP', label: 'Bovespa', region: 'Americas', country: 'Brazil' },
  { symbol: '^MXX', label: 'IPC Mexico', region: 'Americas', country: 'Mexico' },
  // Europe
  { symbol: '^GDAXI', label: 'DAX', region: 'Europe', country: 'Germany' },
  { symbol: '^FTSE', label: 'FTSE 100', region: 'Europe', country: 'United Kingdom' },
  { symbol: '^FCHI', label: 'CAC 40', region: 'Europe', country: 'France' },
  { symbol: '^STOXX50E', label: 'Euro Stoxx 50', region: 'Europe', country: 'Eurozone' },
  { symbol: '^IBEX', label: 'IBEX 35', region: 'Europe', country: 'Spain' },
  { symbol: 'FTSEMIB.MI', label: 'FTSE MIB', region: 'Europe', country: 'Italy' },
  { symbol: '^SSMI', label: 'SMI', region: 'Europe', country: 'Switzerland' },
  { symbol: '^AEX', label: 'AEX', region: 'Europe', country: 'Netherlands' },
  { symbol: '^OMX', label: 'OMX Stockholm 30', region: 'Europe', country: 'Sweden' },
  // Asia-Pacific
  { symbol: '^N225', label: 'Nikkei 225', region: 'Asia-Pacific', country: 'Japan' },
  { symbol: '^HSI', label: 'Hang Seng', region: 'Asia-Pacific', country: 'Hong Kong' },
  { symbol: '000001.SS', label: 'Shanghai Composite', region: 'Asia-Pacific', country: 'China' },
  { symbol: '^STI', label: 'Straits Times', region: 'Asia-Pacific', country: 'Singapore' },
  { symbol: '^KS11', label: 'KOSPI', region: 'Asia-Pacific', country: 'South Korea' },
  { symbol: '^TWII', label: 'Taiwan Weighted', region: 'Asia-Pacific', country: 'Taiwan' },
  { symbol: '^AXJO', label: 'S&P/ASX 200', region: 'Asia-Pacific', country: 'Australia' },
  { symbol: '^JKSE', label: 'Jakarta Composite', region: 'Asia-Pacific', country: 'Indonesia' },
  { symbol: '^SET.BK', label: 'SET Index', region: 'Asia-Pacific', country: 'Thailand' },
  { symbol: '^NZ50', label: 'NZX 50', region: 'Asia-Pacific', country: 'New Zealand' },
  { symbol: '^BSESN', label: 'BSE Sensex', region: 'Asia-Pacific', country: 'India' },
  { symbol: '^NSEI', label: 'Nifty 50', region: 'Asia-Pacific', country: 'India' },
  // Middle East & Africa
  { symbol: '^TASI.SR', label: 'Tadawul All Share', region: 'Middle East & Africa', country: 'Saudi Arabia' },
  { symbol: 'XU100.IS', label: 'BIST 100', region: 'Middle East & Africa', country: 'Turkey' },
  { symbol: '^TA125.TA', label: 'TA-125', region: 'Middle East & Africa', country: 'Israel' },
  { symbol: '^J203.JO', label: 'JSE All Share', region: 'Middle East & Africa', country: 'South Africa' },
];

function computeIdxReturns(closes, dates) {
  if (!closes || closes.length === 0) return {};
  const last = closes[closes.length - 1];
  const anchor = (n) => { const i = closes.length - 1 - n; return i >= 0 ? closes[i] : null; };
  const pct = (old) => (old ? +(((last - old) / old) * 100).toFixed(2) : null);
  let ytd = null;
  const yr = new Date(dates[dates.length - 1]).getUTCFullYear();
  for (let i = 0; i < dates.length; i++) {
    if (new Date(dates[i]).getUTCFullYear() === yr) { ytd = pct(closes[i]); break; }
  }
  return {
    ret1W: pct(anchor(5)), ret1M: pct(anchor(22)), ret3M: pct(anchor(66)),
    ret6M: pct(anchor(132)), retYTD: ytd, ret1Y: pct(anchor(252)),
    ret3Y: pct(anchor(756)), ret4Y: pct(anchor(1008)), ret5Y: pct(anchor(1260)),
  };
}

const globalCache = { data: null, ts: 0 };
const GLOBAL_TTL = 10 * 60 * 1000;
router.get('/global-indices', async (req, res) => {
  if (globalCache.data && Date.now() - globalCache.ts < GLOBAL_TTL) return res.json({ ...globalCache.data, cached: true });
  try {
    const syms = GLOBAL_INDICES.map(g => g.symbol);
    const quotes = {};
    try {
      const q = await yf.quote(syms, {}, { validateResult: false });
      (Array.isArray(q) ? q : [q]).forEach(x => { if (x?.symbol) quotes[x.symbol] = x; });
    } catch { /* fall back to chart-derived 1D below */ }

    const now = new Date();
    const start = new Date(now); start.setFullYear(now.getFullYear() - 6); // covers up to the 5Y return column
    const retBySym = {};
    for (let i = 0; i < syms.length; i += 8) {
      const chunk = syms.slice(i, i + 8);
      await Promise.all(chunk.map(async s => {
        try {
          const ch = await yf.chart(s, { period1: start, interval: '1d' }, { validateResult: false });
          const bars = (ch?.quotes || []).filter(b => b.close != null);
          retBySym[s] = computeIdxReturns(bars.map(b => b.close), bars.map(b => b.date));
        } catch { /* leave returns blank for this index */ }
      }));
    }

    const rows = GLOBAL_INDICES.map(g => {
      const q = quotes[g.symbol] || {};
      return {
        ...g,
        price: q.regularMarketPrice ?? null,
        change1D: q.regularMarketChangePercent ?? null,
        currency: q.currency || null,
        ...(retBySym[g.symbol] || {}),
      };
    });
    const data = { rows, asOf: new Date().toISOString() };
    globalCache.data = data; globalCache.ts = Date.now();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/us/fundamentals/:symbol — Yahoo Finance fundamentals ──────────
const fundamentalsCache = {}; // sym -> { data, ts }
const FUND_TTL = 60 * 60 * 1000; // 1h
router.get('/fundamentals/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = fundamentalsCache[sym];
  if (hit && Date.now() - hit.ts < FUND_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const modules = ['price', 'summaryDetail', 'defaultKeyStatistics', 'financialData', 'assetProfile'];
    let q;
    try { q = await yf.quoteSummary(sym, { modules }); }
    catch { q = await yf.quoteSummary(sym, { modules: ['price', 'summaryDetail'] }); }
    const price = q.price || {}, sd = q.summaryDetail || {}, ks = q.defaultKeyStatistics || {}, fd = q.financialData || {}, ap = q.assetProfile || {};
    const pct = (v) => (v != null ? v * 100 : null);
    const data = {
      symbol: sym,
      name: price.longName || price.shortName || labelFor(sym),
      quoteType: price.quoteType || null,
      currency: price.currency || 'USD',
      sector: ap.sector || null, industry: ap.industry || null, website: ap.website || null,
      country: ap.country || null, employees: ap.fullTimeEmployees || null, summary: ap.longBusinessSummary || null,
      price: {
        last: fd.currentPrice ?? price.regularMarketPrice ?? null,
        marketCap: price.marketCap ?? sd.marketCap ?? null,
        sharesOut: ks.sharesOutstanding ?? null,
        beta: sd.beta ?? ks.beta ?? null,
        week52High: sd.fiftyTwoWeekHigh ?? null, week52Low: sd.fiftyTwoWeekLow ?? null,
        avgVolume: sd.averageVolume ?? null,
      },
      valuation: {
        trailingPE: sd.trailingPE ?? null, forwardPE: sd.forwardPE ?? ks.forwardPE ?? null,
        pegRatio: ks.pegRatio ?? null, priceToBook: ks.priceToBook ?? null,
        priceToSales: sd.priceToSalesTrailing12Months ?? null,
        evToEbitda: ks.enterpriseToEbitda ?? null, evToRevenue: ks.enterpriseToRevenue ?? null,
        enterpriseValue: ks.enterpriseValue ?? null,
      },
      profitability: {
        roe: pct(fd.returnOnEquity), roa: pct(fd.returnOnAssets),
        grossMargin: pct(fd.grossMargins), operatingMargin: pct(fd.operatingMargins),
        profitMargin: pct(fd.profitMargins ?? ks.profitMargins),
      },
      growth: { revenue: pct(fd.revenueGrowth), earnings: pct(fd.earningsGrowth) },
      financials: {
        totalRevenue: fd.totalRevenue ?? null, ebitda: fd.ebitda ?? null,
        grossProfits: fd.grossProfits ?? null, freeCashflow: fd.freeCashflow ?? null,
        totalCash: fd.totalCash ?? null, totalDebt: fd.totalDebt ?? null,
        debtToEquity: fd.debtToEquity ?? null, currentRatio: fd.currentRatio ?? null,
      },
      dividend: { yield: pct(sd.dividendYield), rate: sd.dividendRate ?? null, payoutRatio: pct(sd.payoutRatio) },
      eps: { trailing: ks.trailingEps ?? null, forward: ks.forwardEps ?? null },
      analyst: {
        targetMean: fd.targetMeanPrice ?? null, targetHigh: fd.targetHighPrice ?? null,
        targetLow: fd.targetLowPrice ?? null, recommendation: fd.recommendationKey ?? null,
        analysts: fd.numberOfAnalystOpinions ?? null,
      },
    };
    fundamentalsCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/us/pnl/:symbol — annual + quarterly income statement (Yahoo) ──
const pnlCache = {}; // sym -> { data, ts }
const PNL_TTL = 6 * 60 * 60 * 1000; // 6h — statements rarely change intraday
router.get('/pnl/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = pnlCache[sym];
  if (hit && Date.now() - hit.ts < PNL_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const now = new Date();
    const period1 = new Date(now.getFullYear() - 5, 0, 1);
    const pct = (a, b) => (a != null && b ? (a / b) * 100 : null);
    const mapRow = (r, isQuarter) => {
      const d = r.date ? new Date(r.date) : null;
      const revenue = r.totalRevenue ?? null;
      const grossProfit = r.grossProfit ?? (revenue != null && r.costOfRevenue != null ? revenue - r.costOfRevenue : null);
      const operatingIncome = r.operatingIncome ?? null;
      const netIncome = r.netIncome ?? null;
      const label = d
        ? (isQuarter ? `Q${Math.floor(d.getUTCMonth() / 3) + 1} '${String(d.getUTCFullYear()).slice(2)}` : `FY ${d.getUTCFullYear()}`)
        : '—';
      return {
        label, endDate: d ? d.toISOString().slice(0, 10) : null, sortKey: d ? d.getTime() : 0,
        revenue,
        costOfRevenue: r.costOfRevenue ?? null,
        grossProfit,
        operatingExpense: r.operatingExpense ?? null,
        operatingIncome,
        interestExpense: r.interestExpense ?? r.netInterestIncome ?? null,
        pretaxIncome: r.pretaxIncome ?? null,
        tax: r.taxProvision ?? null,
        netIncome,
        eps: r.dilutedEPS ?? r.basicEPS ?? null,
        grossMargin: pct(grossProfit, revenue),
        operatingMargin: pct(operatingIncome, revenue),
        netMargin: pct(netIncome, revenue),
      };
    };
    const fetchTS = async (type) => {
      try {
        const rows = await yf.fundamentalsTimeSeries(sym, { period1, period2: now, type, module: 'financials' });
        return (rows || []).map(r => mapRow(r, type === 'quarterly')).filter(r => r.revenue != null || r.netIncome != null).sort((a, b) => a.sortKey - b.sortKey);
      } catch { return []; }
    };
    const [annual, quarterly] = await Promise.all([fetchTS('annual'), fetchTS('quarterly')]);
    const data = { symbol: sym, currency: 'USD', annual, quarterly };
    pnlCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── US Screener ────────────────────────────────────────────────────────────
// Fetch daily bars for many symbols using Alpaca's multi-symbol bars endpoint
// (one request per ~100 symbols), then run the shared screener engine per stock.
async function fetchBarsMulti(symbols, start) {
  const out = {}; // symbol -> candles[]
  const CHUNK = 100;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    let pageToken = null, guard = 0;
    do {
      const params = { symbols: chunk.join(','), timeframe: '1Day', start: start.toISOString(), limit: 10000, adjustment: 'all' };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGet('/stocks/bars', params, 60 * 60 * 1000);
      const bars = data?.bars || {};
      for (const s of Object.keys(bars)) {
        (out[s] = out[s] || []).push(...bars[s].map(b => ({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
      }
      pageToken = data?.next_page_token || null;
    } while (pageToken && ++guard < 60);
  }
  return out;
}

async function resolveUsUniverse(scope) {
  if (scope.type === 'nasdaq100') return { label: 'Nasdaq 100', symbols: (await getNasdaq100()).map(x => x.symbol) };
  if (scope.type === 'sector') {
    const want = String(scope.sector || '').toLowerCase();
    // Industry/thematic universe (e.g. "Semiconductors") → that ETF's live
    // holdings; falls back to the curated stub if the live fetch fails.
    const etf = US_INDUSTRY_ETFS.find(k => labelFor(k).toLowerCase() === want);
    if (etf) {
      const holdings = await getEtfHoldings(etf).catch(() => null);
      const syms = holdings?.length ? holdings.map(h => h.symbol) : (US_CONSTITUENTS[etf] || []);
      return { label: labelFor(etf), symbols: [...new Set(syms.map(s => String(s).toUpperCase()))] };
    }
    // Otherwise a GICS sector → its S&P 500 members.
    const symbols = (await getSP500()).filter(x => (x.sector || '').toLowerCase() === want).map(x => x.symbol);
    return { label: `${scope.sector} (S&P 500)`, symbols };
  }
  if (scope.type === 'custom') {
    return { label: scope.name || 'Custom basket', symbols: [...new Set((scope.symbols || []).map(s => String(s).toUpperCase()))] };
  }
  return { label: 'S&P 500', symbols: (await getSP500()).map(x => x.symbol) };
}

const usScreenerJobs = {};
let usScreenerSeq = 0;

async function runUsScreenerJob(job, { scope, conditions }) {
  const { label, symbols } = await resolveUsUniverse(scope);
  job.progress.total = symbols.length;
  job.progress.symbol = 'fetching price history…';
  const start = new Date(); start.setFullYear(start.getFullYear() - 2); // ~500 sessions: enough for SMA200 / 52w / 1Y return
  const barsBySym = await fetchBarsMulti(symbols, start);
  const matches = [], notReady = [];
  for (const sym of symbols) {
    job.progress.symbol = sym;
    try {
      const candles = barsBySym[sym];
      if (!Array.isArray(candles) || candles.length < MIN_SCREENER_BARS) { notReady.push(sym); }
      else {
        const values = computeScreenerRow(candles);
        if (evaluateConditions(values, conditions)) matches.push({ symbol: sym, token: sym, values });
      }
    } catch { notReady.push(sym); }
    finally { job.progress.loaded++; }
  }
  // Resolve company name + sector/industry for the matched set only (cached;
  // chunked to be gentle on the upstream APIs).
  job.progress.symbol = 'resolving names…';
  for (let i = 0; i < matches.length; i += 25) {
    const chunk = matches.slice(i, i + 25);
    const [names, sectors] = await Promise.all([
      Promise.all(chunk.map(m => fetchAssetName(m.symbol).catch(() => null))),
      Promise.all(chunk.map(m => fetchAssetSector(m.symbol).catch(() => null))),
    ]);
    chunk.forEach((m, j) => {
      m.name = names[j] || m.symbol;
      m.sector = sectors[j]?.sector || null;
      m.industry = sectors[j]?.industry || null;
    });
  }
  return { label, scope, conditions, matches, scanned: symbols.length - notReady.length, total: symbols.length, notReady, generatedAt: new Date().toISOString() };
}

router.get('/screener/fields', (req, res) => {
  res.json({ fields: SCREENER_FIELDS.map(f => (f.key === 'price' ? { ...f, label: 'Price ($)' } : f)) });
});

router.get('/screener/sectors', async (req, res) => {
  try {
    const gics = [...new Set((await getSP500()).map(x => x.sector).filter(Boolean))].sort();
    const industries = US_INDUSTRY_ETFS.map(k => labelFor(k));
    res.json({ gics, industries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/screener/run', async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Alpaca keys not configured', configured: false });
  const { scope, conditions } = req.body || {};
  if (!scope?.type) return res.status(400).json({ error: 'scope.type is required' });
  if (scope.type === 'custom' && (!scope.symbols || scope.symbols.length === 0)) return res.status(400).json({ error: 'Basket is empty' });
  try { validateConditions(conditions); } catch (e) { return res.status(400).json({ error: e.message }); }

  // Prune old finished jobs.
  for (const id of Object.keys(usScreenerJobs)) {
    if (usScreenerJobs[id].status !== 'running' && Date.now() - usScreenerJobs[id].createdAt > 10 * 60 * 1000) delete usScreenerJobs[id];
  }
  const jobId = `us${++usScreenerSeq}-${Date.now().toString(36)}`;
  const job = { id: jobId, status: 'running', progress: { loaded: 0, total: 0, symbol: null }, result: null, error: null, createdAt: Date.now() };
  usScreenerJobs[jobId] = job;
  runUsScreenerJob(job, { scope, conditions })
    .then(r => { job.result = r; job.status = 'done'; })
    .catch(e => { job.status = 'error'; job.error = e.message; console.error('[us-screener]', e.message); });
  res.json({ jobId });
});

// Resolve {key,symbol,token,name} for an arbitrary symbol list (basket detail).
router.post('/basket-constituents', async (req, res) => {
  const symbols = [...new Set((req.body?.symbols || []).map(s => String(s).toUpperCase()))];
  const names = await Promise.all(symbols.map(s => fetchAssetName(s).catch(() => null)));
  res.json({
    constituents: symbols.map((s, i) => ({ key: s, symbol: s, token: s, instrument_token: s, name: names[i] || s, exchange: 'US' })),
  });
});

// Compute screener-style metric rows for an arbitrary symbol list (thematic
// baskets). Reuses the multi-symbol bar fetch + shared engine + name lookup.
router.post('/basket-rows', async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Alpaca keys not configured', configured: false });
  const symbols = [...new Set((req.body?.symbols || []).map(s => String(s).toUpperCase()))];
  if (symbols.length === 0) return res.json({ rows: [], notReady: [] });
  try {
    const start = new Date(); start.setFullYear(start.getFullYear() - 2);
    const barsBySym = await fetchBarsMulti(symbols, start);
    const rows = [], notReady = [];
    for (const sym of symbols) {
      const candles = barsBySym[sym];
      if (!Array.isArray(candles) || candles.length < MIN_SCREENER_BARS) { notReady.push(sym); continue; }
      try { rows.push({ symbol: sym, token: sym, values: computeScreenerRow(candles) }); } catch { notReady.push(sym); }
    }
    for (let i = 0; i < rows.length; i += 25) {
      const chunk = rows.slice(i, i + 25);
      const names = await Promise.all(chunk.map(r => fetchAssetName(r.symbol).catch(() => null)));
      chunk.forEach((r, j) => { r.name = names[j] || r.symbol; });
    }
    res.json({ rows, notReady });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/screener/run/:jobId', (req, res) => {
  const job = usScreenerJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found (jobs are in-memory and pruned on restart)' });
  res.json({
    status: job.status, progress: job.progress,
    ...(job.status === 'done' ? { result: job.result } : {}),
    ...(job.status === 'error' ? { error: job.error } : {}),
  });
});

// ─── Persistence: US baskets / virtual portfolios / saved screens (Supabase) ─
// jsonb-per-entity tables (see migrate_us_tables.js). Each list endpoint returns
// newest-first; mutations return the affected row.
const dbErr = (res, error) => res.status(500).json({ error: error.message || String(error) });

// Baskets — { id, name, symbols: [] }
router.get('/baskets', async (req, res) => {
  if (!requireDb(res)) return;
  const { data, error } = await supabase.from('us_baskets').select('*').order('created_at', { ascending: true });
  if (error) return dbErr(res, error);
  res.json({ baskets: data || [] });
});
router.get('/baskets/:id', async (req, res) => {
  if (!requireDb(res)) return;
  const { data, error } = await supabase.from('us_baskets').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json({ basket: data });
});
router.post('/baskets', async (req, res) => {
  if (!requireDb(res)) return;
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase.from('us_baskets').insert({ name, symbols: req.body?.symbols || [] }).select().single();
  if (error) return dbErr(res, error);
  res.json({ basket: data });
});
router.patch('/baskets/:id', async (req, res) => {
  if (!requireDb(res)) return;
  const patch = {};
  if (req.body?.name != null) patch.name = String(req.body.name).trim();
  if (req.body?.symbols != null) patch.symbols = req.body.symbols;
  const { data, error } = await supabase.from('us_baskets').update(patch).eq('id', req.params.id).select().single();
  if (error) return dbErr(res, error);
  res.json({ basket: data });
});
router.delete('/baskets/:id', async (req, res) => {
  if (!requireDb(res)) return;
  const { error } = await supabase.from('us_baskets').delete().eq('id', req.params.id);
  if (error) return dbErr(res, error);
  res.json({ ok: true });
});

// Virtual portfolios — { id, name, holdings: [{id,symbol,name,avgCost,quantity}] }
router.get('/portfolios', async (req, res) => {
  if (!requireDb(res)) return;
  const { data, error } = await supabase.from('us_virtual_portfolios').select('*').order('created_at', { ascending: true });
  if (error) return dbErr(res, error);
  res.json({ portfolios: data || [] });
});
router.get('/portfolios/:id', async (req, res) => {
  if (!requireDb(res)) return;
  const { data, error } = await supabase.from('us_virtual_portfolios').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json({ portfolio: data });
});
router.post('/portfolios', async (req, res) => {
  if (!requireDb(res)) return;
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase.from('us_virtual_portfolios').insert({ name, holdings: req.body?.holdings || [] }).select().single();
  if (error) return dbErr(res, error);
  res.json({ portfolio: data });
});
router.patch('/portfolios/:id', async (req, res) => {
  if (!requireDb(res)) return;
  const patch = {};
  if (req.body?.name != null) patch.name = String(req.body.name).trim();
  if (req.body?.holdings != null) patch.holdings = req.body.holdings;
  const { data, error } = await supabase.from('us_virtual_portfolios').update(patch).eq('id', req.params.id).select().single();
  if (error) return dbErr(res, error);
  res.json({ portfolio: data });
});
router.delete('/portfolios/:id', async (req, res) => {
  if (!requireDb(res)) return;
  const { error } = await supabase.from('us_virtual_portfolios').delete().eq('id', req.params.id);
  if (error) return dbErr(res, error);
  res.json({ ok: true });
});

// Saved screens — { id, name, scope, conditions }
router.get('/screens', async (req, res) => {
  if (!requireDb(res)) return;
  const { data, error } = await supabase.from('us_screens').select('*').order('created_at', { ascending: true });
  if (error) return dbErr(res, error);
  res.json({ screens: data || [] });
});
router.post('/screens', async (req, res) => {
  if (!requireDb(res)) return;
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase.from('us_screens').insert({ name, scope: req.body?.scope || {}, conditions: req.body?.conditions || [] }).select().single();
  if (error) return dbErr(res, error);
  res.json({ screen: data });
});
router.delete('/screens/:id', async (req, res) => {
  if (!requireDb(res)) return;
  const { error } = await supabase.from('us_screens').delete().eq('id', req.params.id);
  if (error) return dbErr(res, error);
  res.json({ ok: true });
});

module.exports = { alpacaRouter: router, isAlpacaConfigured: isConfigured };
