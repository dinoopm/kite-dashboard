// ─── Alpaca US market-data integration ─────────────────────────────────────
// A self-contained Express router that tracks US indices / sectors via Alpaca's
// market-data API (https://data.alpaca.markets/v2). This is DATA-ONLY: it never
// touches the trading API (no account, positions, or orders), so the only
// credentials it needs are a free Alpaca API key + secret (a paper-account
// signup is enough to get data keys).
//
// Alpaca's stock data API serves equities/ETFs, not raw index symbols, so we
// track liquid ETF proxies: SPY≈S&P 500, QQQ≈Nasdaq 100, DIA≈Dow 30, etc., plus
// the SPDR sector ETFs. Data feeds differ by endpoint because the free tier
// permits different feeds on each (and "iex" is a partial-volume feed that
// excludes the closing auction, so its daily close — and thus today's-change
// sign — can be wrong): historical BARS use "sip" (free tier serves full
// consolidated history older than 15 min), while live SNAPSHOTS use
// "delayed_sip" (full-volume, 15-min-delayed; plain "sip" is blocked for recent
// data on the free tier). Paid SIP accounts can override both via env.
const express = require('express');
const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
// Reuse the exact screener engine the Indian screener uses — it operates on raw
// daily candles, which is precisely the shape Alpaca bars produce.
const { SCREENER_FIELDS, computeScreenerRow, validateConditions, evaluateConditions } = require('./screener/engine');
const { computeVcpScore, computeVcpContractions } = require('./screener/vcp');
const { getSP500, getNasdaq100 } = require('./usUniverses');
const { hvSpike } = require('./volMath');
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
const FEED = process.env.ALPACA_DATA_FEED || 'sip';                 // historical bars
const SNAPSHOT_FEED = process.env.ALPACA_SNAPSHOT_FEED || 'delayed_sip'; // live snapshots

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
  // Regular-session close first (see /quotes) — after-hours latestTrade only as fallback.
  const last = daily.c ?? snap.latestTrade?.p ?? null;
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
    case 'YTD': return { timeframe: '1Day', start: new Date(now.getFullYear(), 0, 1) };
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
    const data = await alpacaGet('/stocks/snapshots', { symbols: symbols.join(','), feed: SNAPSHOT_FEED }, 60_000);
    const snaps = data || {};
    const decorate = (m) => ({ ...m, quote: summariseSnapshot(snaps[m.symbol]) });
    res.json({
      indices: BROAD_INDICES.map(decorate),
      sectors: SECTOR_ETFS.map(decorate),
      feed: SNAPSHOT_FEED,
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
      alpacaGet(`/stocks/${encodeURIComponent(symbol)}/snapshot`, { feed: SNAPSHOT_FEED }, 30_000),
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

// Alpaca SIP bars occasionally carry an off-exchange misprint in a wick
// (seen live: SPY 2026-02-02 daily low of 68.64 against a 686–693 body — a
// dropped digit). A wick more than 2× away from the open/close body on either
// side is treated as a bad print and clamped to the body: real extremes that
// large drag the close with them, misprints don't. Applied at every point
// where raw Alpaca bars are normalised, so charts, indicators, red flags and
// the screener all see clean data.
const sanitizeBar = (b) => {
  const bodyLo = Math.min(b.open, b.close), bodyHi = Math.max(b.open, b.close);
  const low = (b.low <= 0 || b.low < bodyLo * 0.5) ? bodyLo : b.low;
  const high = b.high > bodyHi * 2 ? bodyHi : b.high;
  return (low === b.low && high === b.high) ? b : { ...b, low, high };
};

// Is an ISO timestamp inside the US regular session (9:30 AM–4:00 PM ET)?
// DST-safe via the America/New_York timezone. Alpaca's intraday bars include
// pre/post-market prints, which otherwise leak into the "1D" chart and its
// Period Return — making them disagree with the header's regular-session
// change (the header comes from the snapshot's regular-session daily bar).
const isRegularHours = (iso) => {
  const et = new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = et.split(':').map(Number);
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960; // 09:30 → 16:00 ET (bar start times)
};

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

    let bars = allBars.map(b => sanitizeBar({
      date: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
    // Drop extended-hours prints from intraday charts so the 1D view and its
    // Period Return track the regular session (matching the header change).
    if (timeframe.includes('Min') || timeframe.includes('Hour')) {
      bars = bars.filter(b => isRegularHours(b.date));
    }
    // "1D" fetches a 4-day window of 15-min bars only to be sure the latest
    // session is present (weekends/holidays). Trim to that latest session so the
    // chart and the "(1D)" period stats reflect a single day — not 3–4. US
    // trading days don't cross UTC midnight, so the UTC date keys one session.
    if (range === '1D' && bars.length) {
      const lastDay = bars[bars.length - 1].date.slice(0, 10);
      bars = bars.filter(b => b.date.slice(0, 10) === lastDay);
    }
    res.json({ symbol, range, timeframe, bars });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

// Symbol-scoped manipulation red flags for the US instrument page. Mirrors
// /api/red-flags/:symbol (India, backend/picks/redFlags.js) in response shape,
// but the data source differs by necessity: the US market has no delivery-%
// or bulk-deal-disclosure equivalents, so every check here is derived from
// Alpaca daily bars (price/volume behaviour only).
router.get('/red-flags/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  try {
    const all = await fetchDailyBars(sym, 1);
    const bars = all.slice(-60);
    const flags = [];
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
    const r1 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(1));

    if (bars.length >= 25) {
      const last20 = bars.slice(-20);

      // 1) Thin liquidity — easiest stock to manipulate is one nobody trades.
      const dollarVol = median(last20.map(b => b.close * b.volume));
      if (dollarVol != null && dollarVol < 1e6) {
        flags.push({
          id: 'thin-liquidity', severity: 'amber',
          title: `Thin liquidity (~$${(dollarVol / 1e6).toFixed(2)}M/day median)`,
          detail: 'Median dollar volume under $1M/day — wide spreads, easy to ramp, hard to exit. Micro-float names are the primary pump-and-dump vehicle in the US.',
        });
      }

      // 2) Pump-and-fade — vertical ramp followed by a break from the peak.
      const win = bars.slice(-30);
      let peakIdx = 0;
      win.forEach((b, i) => { if (b.close > win[peakIdx].close) peakIdx = i; });
      const preIdx = Math.max(0, peakIdx - 10);
      const ramp = win[preIdx].close > 0 ? win[peakIdx].close / win[preIdx].close - 1 : 0;
      const offPeak = win[peakIdx].close > 0 ? 1 - win[win.length - 1].close / win[peakIdx].close : 0;
      if (ramp >= 0.4 && offPeak >= 0.2) {
        flags.push({
          id: 'pump-fade', severity: 'red',
          title: 'Pump-and-fade pattern',
          detail: `Price ran +${r1(ramp * 100)}% into a peak within ~10 sessions, then dropped ${r1(offPeak * 100)}% from it — the footprint of a promoted ramp being distributed.`,
        });
      }

      // 3) Rising price on fading volume (distribution; volume is the best
      //    US proxy — there is no delivery % here).
      const run20 = last20[0].close > 0 ? last20[last20.length - 1].close / last20[0].close - 1 : 0;
      const volRecent = mean(last20.slice(-5).map(b => b.volume));
      const volPrior = mean(last20.slice(0, 15).map(b => b.volume));
      if (run20 >= 0.15 && volPrior > 0 && volRecent < volPrior * 0.65) {
        flags.push({
          id: 'fading-volume', severity: 'amber',
          title: 'Price rising on fading volume',
          detail: `Price +${r1(run20 * 100)}% over ~20 sessions while volume fell ${r1((1 - volRecent / volPrior) * 100)}% — fewer real buyers behind each new high.`,
        });
      }

      // 4) Gap-and-fade days — gapped open sold into all day.
      let gapFades = 0;
      for (let i = bars.length - 15; i < bars.length; i++) {
        const prev = bars[i - 1];
        if (prev && bars[i].open >= prev.close * 1.03 && bars[i].close <= bars[i].open * 0.985) gapFades++;
      }
      if (gapFades >= 3) {
        flags.push({
          id: 'gap-fade', severity: 'amber',
          title: `Repeated gap-and-fade sessions (${gapFades} of last 15)`,
          detail: 'Opens gapped up 3%+ then closed below the open — excitement at the open is being sold into, a common promoted-stock signature.',
        });
      }

      // 5) Volume spikes with no price move — churn/crossing prints.
      const medVol = median(last20.map(b => b.volume));
      let quietSpikes = 0;
      for (let i = bars.length - 10; i < bars.length; i++) {
        const prev = bars[i - 1];
        if (prev && medVol > 0 && bars[i].volume >= 5 * medVol && Math.abs(bars[i].close / prev.close - 1) < 0.015) quietSpikes++;
      }
      if (quietSpikes >= 2) {
        flags.push({
          id: 'quiet-volume-spike', severity: 'amber',
          title: `Volume spikes without price movement (${quietSpikes} day(s))`,
          detail: '5×+ normal volume with the price barely moving — block crossings or churn, not directional buying.',
        });
      }
    }

    // 6) Volatility spike — daily swings far outside the stock's own past
    // year (computed on the full 1y series, not the 60-bar slice). Abnormal
    // vol is the backdrop of every pattern above — the "look closer" cue.
    const spike = hvSpike(all.map(b => b.close));
    if (spike && spike.pctile >= 90) {
      const span = spike.points >= 200 ? 'past year' : `last ~${spike.points} sessions`;
      flags.push({
        id: 'vol-spike', severity: 'amber',
        title: `Volatility spike — swings bigger than ${Math.min(99, Math.round(spike.pctile))}% of its ${span}`,
        detail: `20-day realized volatility is ${r1(spike.hv20)}% annualized (≈±${r1(spike.hv20 / Math.sqrt(252))}%/day), near the top of its range over the ${span}. Something changed — check news and earnings before adding, and size smaller.`,
      });
    }

    res.json({
      symbol: sym, market: 'US',
      source: 'Alpaca daily bars (price/volume only — no delivery-% or bulk-deal data exists for US stocks)',
      asOf: bars.length ? bars[bars.length - 1].date.slice(0, 10) : null,
      checks: ['thin liquidity', 'pump-and-fade', 'fading volume', 'gap-and-fade', 'quiet volume spikes', 'volatility spike'],
      flags,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Volatility Contraction Pattern for one US symbol — same deterministic module
// as the India screener/instrument, fed Alpaca daily bars.
router.get('/vcp/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const bars = await fetchDailyBars(symbol, 2);
    if (!Array.isArray(bars) || bars.length < 60) {
      return res.status(422).json({ error: `Insufficient history for VCP (${bars?.length || 0} bars, need >= 60)` });
    }
    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume || 0);
    const score = computeVcpScore({ closes, highs, lows, volumes });
    const anatomy = computeVcpContractions({ closes, highs, lows, volumes });
    res.json({
      symbol,
      vcp: {
        score: score.vcpScore,
        setup: score.vcpSetup,
        gatePassed: score.gatePassed,
        gateFailReason: score.gateFailReason,
        components: score.components,
        contractions: anatomy.contractions,
        tightening: anatomy.tightening,
        verdict: score.gatePassed ? anatomy.verdict : `no valid VCP: ${score.gateFailReason}`,
      },
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
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
    const bars = allBars.map(b => sanitizeBar({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
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
    const data = await alpacaGet('/stocks/snapshots', { symbols: symbols.join(','), feed: SNAPSHOT_FEED }, 60_000);
    const out = {};
    for (const sym of symbols) {
      const snap = data?.[sym];
      const daily = snap?.dailyBar || {};
      const prev = snap?.prevDailyBar || {};
      // Prefer the regular-session close (dailyBar.c) — during the session it
      // tracks the live price, and once closed it's the official close that
      // Google/Yahoo headline. latestTrade.p is only a fallback: it includes
      // pre/after-hours prints, which distort (and on thin sessions can flip)
      // today's change vs the standard regular-session number.
      const last = daily.c ?? snap?.latestTrade?.p ?? null;
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

// ─── Software index members (widens the IGV drilldown) ──────────────────────
// IGV's live holdings come from StockAnalysis, whose free tier caps at the top
// ~25 by weight (see etfHoldings.js), so the Software drilldown was a weight
// cutoff rather than a sector view. Union those holdings with the software
// members of the S&P 500 and Nasdaq 100.
//
// S&P 500 rows carry a GICS sub-industry from the Wikipedia scrape, which is
// exact — GICS has no "Software" sector, only these two sub-industries.
// Nasdaq-100-only names have no sub-industry, so they fall back to Yahoo's
// industry label ("Software - Infrastructure" / "Software - Application").
// Only ~15 names take that path, and each is cached for 7 days.
const GICS_SOFTWARE_SUB = new Set(['application software', 'systems software']);
const SOFTWARE_TTL = 24 * 60 * 60 * 1000;
let softwareCache = null;    // { data: Map<symbol, name>, ts }
let softwareInflight = null; // Promise (coalesce concurrent rebuilds)

async function computeSoftwareIndexMembers() {
  const [sp, ndx] = await Promise.all([getSP500().catch(() => []), getNasdaq100().catch(() => [])]);
  const out = new Map();
  for (const m of sp) {
    if (GICS_SOFTWARE_SUB.has((m.subIndustry || '').toLowerCase())) out.set(m.symbol, m.name);
  }
  const spSet = new Set(sp.map(m => m.symbol));
  const ndxOnly = ndx.filter(m => !spSet.has(m.symbol));
  for (let i = 0; i < ndxOnly.length; i += 10) {
    const chunk = ndxOnly.slice(i, i + 10);
    const inds = await Promise.all(chunk.map(m => fetchAssetSector(m.symbol).catch(() => null)));
    chunk.forEach((m, j) => {
      if (/^software/i.test(inds[j]?.industry || '')) out.set(m.symbol, m.name);
    });
  }
  return out;
}

function getSoftwareIndexMembers() {
  if (softwareCache && Date.now() - softwareCache.ts < SOFTWARE_TTL) return Promise.resolve(softwareCache.data);
  if (softwareInflight) return softwareInflight;
  softwareInflight = computeSoftwareIndexMembers()
    .then(data => { softwareCache = { data, ts: Date.now() }; return data; })
    .finally(() => { softwareInflight = null; });
  return softwareInflight;
}

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
        const merged = new Map(live.map(h => [h.symbol, h.name]));
        // Software is capped at the top ~25 by weight upstream; widen it with
        // the S&P 500 / Nasdaq 100 software members the cap left out.
        if (sym === 'IGV') {
          const extra = await getSoftwareIndexMembers().catch(() => new Map());
          for (const [s, n] of extra) if (!merged.has(s)) merged.set(s, n);
        }
        return res.json({
          sector: { key: sym, name: labelFor(sym) },
          constituents: [...merged].map(([s, n]) => mkConstituent(s, n)),
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
  { symbol: '^KLSE', label: 'FTSE Bursa Malaysia KLCI', region: 'Asia-Pacific', country: 'Malaysia' },
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

// ─── GET /api/us/breadth — % of index members above 50/200-day SMA ──────────
// ?universe=sp500 (default, ~10-15 Alpaca requests cold) | ndx100 (1-2).
// Cached 30 min per universe with in-flight coalescing.
const BREADTH_TTL = 30 * 60 * 1000;
const BREADTH_UNIVERSES = { sp500: getSP500, ndx100: getNasdaq100 };
const breadthCache = {};    // universe -> { data, ts }
const breadthInflight = {}; // universe -> Promise

async function computeBreadth(universe) {
  const symbols = (await BREADTH_UNIVERSES[universe]()).map(x => x.symbol);
  const start = new Date(Date.now() - 310 * 24 * 60 * 60 * 1000);
  const bars = await fetchBarsMulti(symbols, start);
  let above50 = 0, above200 = 0, total = 0, asOf = '';
  for (const sym of symbols) {
    const candles = bars[sym];
    if (!candles || candles.length < 200) continue;
    const closes = candles.map(c => c.close);
    const last = closes[closes.length - 1];
    const sma = (p) => closes.slice(-p).reduce((a, b) => a + b, 0) / p;
    total++;
    if (last > sma(50)) above50++;
    if (last > sma(200)) above200++;
    const d = String(candles[candles.length - 1].date).slice(0, 10);
    if (d > asOf) asOf = d;
  }
  if (!total) throw new Error(`breadth(${universe}): no symbols with enough history`);
  return {
    pctAbove50: +(above50 / total * 100).toFixed(1),
    pctAbove200: +(above200 / total * 100).toFixed(1),
    above50, above200, total, asOf,
  };
}

router.get('/breadth', async (req, res) => {
  try {
    const universe = req.query.universe || 'sp500';
    if (!BREADTH_UNIVERSES[universe]) {
      return res.status(400).json({ error: `unknown universe "${universe}" — use ${Object.keys(BREADTH_UNIVERSES).join(' | ')}` });
    }
    const hit = breadthCache[universe];
    if (hit && Date.now() - hit.ts < BREADTH_TTL) {
      return res.json({ ...hit.data, cached: true });
    }
    if (!breadthInflight[universe]) {
      breadthInflight[universe] = computeBreadth(universe)
        .then(data => { breadthCache[universe] = { data, ts: Date.now() }; return data; })
        .finally(() => { delete breadthInflight[universe]; });
    }
    const data = await breadthInflight[universe];
    res.json({ ...data, cached: false });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ─── GET /api/us/events/:symbol — next earnings + ex-dividend (Yahoo) ───────
const usEventsCache = {}; // sym -> { data, ts }
const US_EVENTS_TTL = 12 * 60 * 60 * 1000;
router.get('/events/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = usEventsCache[sym];
  if (hit && Date.now() - hit.ts < US_EVENTS_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const q = await yf.quoteSummary(sym, { modules: ['calendarEvents'] });
    const ce = q.calendarEvents || {};
    const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    // earningsDate is a 1–2 element window (Yahoo gives a range until
    // confirmed) — and when the NEXT report isn't scheduled yet, Yahoo hands
    // back the LAST one. Only report a window that hasn't fully passed.
    const earningsDates = (ce.earnings?.earningsDate || []).map(iso).filter(Boolean);
    const todayIso = new Date().toISOString().slice(0, 10);
    const upcoming = earningsDates.length && earningsDates[earningsDates.length - 1] >= todayIso;
    const data = {
      symbol: sym,
      earnings: upcoming ? { from: earningsDates[0], to: earningsDates[earningsDates.length - 1] } : null,
      exDividendDate: iso(ce.exDividendDate),
      dividendDate: iso(ce.dividendDate),
      source: 'Yahoo Finance calendarEvents',
    };
    usEventsCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

// ─── GET /api/us/treasury-10y — US 10Y Treasury yield series ─────────────────
// The risk-free rate that drives equity valuations and FII flows. The LIVE
// value + today's change come from CNBC's US10Y quote (real-time, matches
// cnbc.com/Google); Yahoo ^TNX is only used for the historical series shape
// because its live index lags a full session. The CNBC live point is appended
// so the chart line reaches the current level.
const { cnbcUs10y } = require('./cnbcQuote');
const tnxCache = {}; // range -> { data, ts }

router.get('/treasury-10y', async (req, res) => {
  const range = (req.query.range || '6M').toUpperCase();
  const hit = tnxCache[range];
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return res.json({ ...hit.data, cached: true });
  try {
    const now = new Date();
    const back = (days) => new Date(now.getTime() - days * 864e5);
    const cfg = {
      '1M': { period1: back(31), interval: '1d' },
      '3M': { period1: back(93), interval: '1d' },
      '6M': { period1: back(186), interval: '1d' },
      '1Y': { period1: back(370), interval: '1d' },
      '5Y': { period1: back(5 * 366), interval: '1wk' },
      '10Y': { period1: back(10 * 366), interval: '1wk' },
    }[range] || { period1: back(186), interval: '1d' };

    // History from Yahoo; live value from CNBC (independent — either can fail).
    const [chartR, liveR] = await Promise.allSettled([
      yf.chart('^TNX', { period1: cfg.period1, interval: cfg.interval }, { validateResult: false }),
      cnbcUs10y(),
    ]);
    let series = (chartR.status === 'fulfilled' ? chartR.value.quotes || [] : [])
      .filter(q => q.close != null)
      .map(q => ({ t: q.date.toISOString(), y: +q.close.toFixed(3) }));

    const live = liveR.status === 'fulfilled' ? liveR.value : null;
    // Reach the live level: append (new session) or replace (same day) the
    // final point with CNBC's real-time value so the line ends at "now".
    if (live?.last != null && series.length) {
      const liveDay = (live.time || now.toISOString()).slice(0, 10);
      if (series[series.length - 1].t.slice(0, 10) < liveDay) series.push({ t: new Date().toISOString(), y: live.last });
      else series[series.length - 1] = { t: series[series.length - 1].t, y: live.last };
    }

    const current = live?.last ?? (series.length ? series[series.length - 1].y : null);
    const first = series.length ? series[0].y : null;
    const data = {
      range,
      current,
      // 1D-equivalent move comes straight from CNBC; longer ranges vs the series start.
      changeBps: current != null && first != null ? Math.round((current - first) * 100) : null,
      todayBps: live?.change != null ? Math.round(live.change * 100) : null,
      series,
      asOf: live?.time || null,
      source: live ? 'Live: CNBC US10Y · history: Yahoo ^TNX' : 'Yahoo ^TNX (CNBC live value unavailable)',
    };
    tnxCache[range] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

// ─── GET /api/us/news/:symbol — Yahoo headline RSS for the News tab ─────────
const { fetchYahooNews } = require('./yahooNews');
const usNewsCache = {}; // sym -> { data, ts }
const US_NEWS_TTL = 15 * 60 * 1000;
router.get('/news/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = usNewsCache[sym];
  if (hit && Date.now() - hit.ts < US_NEWS_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const items = await fetchYahooNews(sym);
    const data = { symbol: sym, items, source: 'Yahoo Finance' };
    usNewsCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── GET /api/us/earnings-calendar — upcoming earnings across S&P500+NDX ────
// Yahoo's multi-symbol quote endpoint carries earningsTimestampStart/End per
// symbol, so ~600 names cost 6 batched calls instead of 600 quoteSummary
// calls. Note earningsTimestamp (no suffix) can be stale — Start/End are the
// live fields. "mine" flags symbols present in any US basket or virtual
// portfolio (the US side has no brokerage holdings).
let earningsCalCache = { data: null, ts: 0 };
const EARNINGS_CAL_TTL = 12 * 60 * 60 * 1000;
router.get('/earnings-calendar', async (req, res) => {
  if (earningsCalCache.data && Date.now() - earningsCalCache.ts < EARNINGS_CAL_TTL) {
    return res.json({ ...earningsCalCache.data, cached: true });
  }
  try {
    const [sp, ndx] = await Promise.all([getSP500().catch(() => []), getNasdaq100().catch(() => [])]);
    const symbols = [...new Set([...sp, ...ndx].map(x => x.symbol))];

    // Yahoo uses dashes for share classes (BRK-B), the universe lists use
    // dots (BRK.B) — query in Yahoo form, report in the app's form. Dotted
    // symbols also return stub objects that fail the lib's schema validation
    // and would kill the whole chunk, hence validateResult: false.
    const appSymbol = new Map(symbols.map(s => [s.replace(/\./g, '-'), s]));
    const rows = [];
    const ySymbols = [...appSymbol.keys()];
    for (let i = 0; i < ySymbols.length; i += 100) {
      try {
        const quotes = await yf.quote(ySymbols.slice(i, i + 100), {}, { validateResult: false });
        for (const q of Array.isArray(quotes) ? quotes : [quotes]) {
          const start = q.earningsTimestampStart, end = q.earningsTimestampEnd;
          if (!start) continue;
          const d = new Date(start);
          rows.push({
            symbol: appSymbol.get(q.symbol) || q.symbol,
            name: q.shortName || q.longName || q.symbol,
            date: d.toISOString().slice(0, 10),
            // NYSE/Nasdaq regular session starts 13:30/14:30 UTC — a slot
            // before that is pre-market, after ~20:00 UTC is post-close.
            session: d.getUTCHours() < 13 ? 'before open' : d.getUTCHours() >= 20 ? 'after close' : 'during market',
            estimated: end && new Date(end).toISOString().slice(0, 10) !== d.toISOString().slice(0, 10),
            marketCap: q.marketCap ?? null,
          });
        }
      } catch (e) { console.warn('[earnings-calendar] chunk failed:', e.message); }
    }

    // "Your" US symbols: union of basket symbol arrays + portfolio holdings.
    const mine = new Set();
    if (supabase) {
      const [bk, pf] = await Promise.all([
        supabase.from('us_baskets').select('symbols'),
        supabase.from('us_virtual_portfolios').select('holdings'),
      ]);
      for (const b of bk.data || []) for (const s of b.symbols || []) mine.add(String(s).toUpperCase());
      for (const p of pf.data || []) for (const h of p.holdings || []) if (h?.symbol) mine.add(String(h.symbol).toUpperCase());
    }

    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 60);
    const hz = horizon.toISOString().slice(0, 10);
    const events = rows
      .filter(r => r.date >= today && r.date <= hz)
      .map(r => ({ ...r, mine: mine.has(r.symbol) }))
      .sort((a, b) => a.date.localeCompare(b.date) || (b.marketCap ?? 0) - (a.marketCap ?? 0));

    const data = { events, universe: symbols.length, source: 'Yahoo batched quotes over S&P 500 + Nasdaq 100' };
    earningsCalCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

// ─── GET /api/us/earnings-reaction/:symbol — how it moves on report days ────
// Historical earnings dates come from SEC EDGAR: an 8-K with Item 2.02
// ("Results of Operations") is filed the day results are announced — exact,
// official, free. Reaction per report = the larger of the filing-day and
// next-day close-to-close moves, because the filing doesn't say whether the
// release was pre-market (reaction lands day D) or post-close (day D+1); the
// earnings move dominates that session, so max-abs picks the right one.
const SEC_UA = { 'User-Agent': 'kite-dashboard/1.0 dinoopm@gmail.com' };
let cikMapCache = { map: null, ts: 0 };
const earningsReactionCache = {}; // sym -> { data, ts }
const EARN_REACT_TTL = 24 * 60 * 60 * 1000;

async function getCikMap() {
  if (cikMapCache.map && Date.now() - cikMapCache.ts < EARN_REACT_TTL) return cikMapCache.map;
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_UA });
  if (!r.ok) throw new Error(`SEC ticker map HTTP ${r.status}`);
  const j = await r.json();
  const map = new Map(Object.values(j).map(t => [t.ticker.toUpperCase(), String(t.cik_str).padStart(10, '0')]));
  cikMapCache = { map, ts: Date.now() };
  return map;
}

router.get('/earnings-reaction/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = earningsReactionCache[sym];
  if (hit && Date.now() - hit.ts < EARN_REACT_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const cik = (await getCikMap()).get(sym.replace(/\./g, '-')) || (await getCikMap()).get(sym);
    if (!cik) return res.status(404).json({ error: `No SEC CIK found for ${sym}` });
    const sub = await (await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: SEC_UA })).json();
    const rec = sub.filings?.recent || {};
    const reportDates = [];
    for (let i = 0; i < (rec.form || []).length; i++) {
      if (rec.form[i] === '8-K' && (rec.items[i] || '').includes('2.02')) reportDates.push(rec.filingDate[i]);
    }
    if (!reportDates.length) return res.status(404).json({ error: 'No earnings 8-Ks on file' });

    const bars = await fetchDailyBars(sym, 4);
    const idx = new Map(bars.map((b, i) => [b.date.slice(0, 10), i]));
    const dates = bars.map(b => b.date.slice(0, 10));
    const reactions = [];
    for (const d of reportDates) {
      // Only filings inside the price window — older ones would snap to the
      // window edge and count an unrelated day as a reaction.
      if (d < dates[0]) continue;
      // filing date may be a non-session day — snap to the first session ≥ d
      let i = idx.get(d);
      if (i == null) { i = dates.findIndex(x => x >= d); if (i === -1) continue; }
      const ret = (j) => (j > 0 && j < bars.length ? (bars[j].close / bars[j - 1].close - 1) * 100 : null);
      const r0 = ret(i), r1 = ret(i + 1);
      const move = [r0, r1].filter(v => v != null).sort((a, b) => Math.abs(b) - Math.abs(a))[0];
      if (move != null) reactions.push({ date: d, movePct: +move.toFixed(2) });
    }
    if (reactions.length < 2) return res.status(404).json({ error: 'Not enough price history around past reports' });

    const moves = reactions.map(r => r.movePct);
    const data = {
      symbol: sym,
      n: reactions.length,
      avgAbsPct: +(moves.reduce((s, v) => s + Math.abs(v), 0) / moves.length).toFixed(2),
      worst: Math.min(...moves),
      best: Math.max(...moves),
      pctUp: Math.round((moves.filter(v => v > 0).length / moves.length) * 100),
      recent: reactions.slice(0, 8),
      source: 'SEC EDGAR 8-K (Item 2.02) filing dates × Alpaca daily closes',
    };
    earningsReactionCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

// ─── GET /api/us/holders/:symbol — institutional ownership (Yahoo 13F) ──────
// Mirrors /api/institutional/:symbol (India, backend/picks/institutional.js)
// in spirit: official positions + a deterministic verdict. US positions come
// from quarterly 13F filings (up to 45 days late by rule), so the panel
// carries the as-of quarter honestly; netSharePurchaseActivity is Yahoo's
// rolling ~6m aggregate and is the freshest institutional signal free data has.
const holdersCache = {}; // sym -> { data, ts }
const HOLDERS_TTL = 12 * 60 * 60 * 1000; // 12h — 13F data moves quarterly
router.get('/holders/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = holdersCache[sym];
  if (hit && Date.now() - hit.ts < HOLDERS_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const q = await yf.quoteSummary(sym, { modules: ['majorHoldersBreakdown', 'institutionOwnership', 'fundOwnership', 'netSharePurchaseActivity'] });
    const mhb = q.majorHoldersBreakdown || {};
    const nsp = q.netSharePurchaseActivity || {};
    const pct = (v) => (v != null ? +(v * 100).toFixed(2) : null);
    const mapOwner = (o) => ({
      org: o.organization,
      pct: pct(o.pctHeld),
      shares: o.position ?? null,
      value: o.value ?? null,
      pctChange: o.pctChange != null ? +(o.pctChange * 100).toFixed(2) : null,
      reportDate: o.reportDate ? new Date(o.reportDate).toISOString().slice(0, 10) : null,
    });
    const topInstitutions = (q.institutionOwnership?.ownershipList || []).slice(0, 10).map(mapOwner);
    const topFunds = (q.fundOwnership?.ownershipList || []).slice(0, 10).map(mapOwner);
    const asOf = topInstitutions[0]?.reportDate || topFunds[0]?.reportDate || null;

    const netInstBuyingPct = nsp.netInstBuyingPercent != null ? +(nsp.netInstBuyingPercent * 100).toFixed(2) : null;
    const changes = topInstitutions.map(o => o.pctChange).filter(v => v != null);
    const rising = changes.filter(v => v >= 0).length;
    const lagNote = asOf ? ` Positions as of ${asOf} (13F filings run up to 45 days late).` : '';
    let verdict = { label: 'NO CLEAR FOOTPRINT', tone: 'neutral', detail: `No decisive institutional pattern in the latest filings.${lagNote}` };
    if (netInstBuyingPct != null && netInstBuyingPct > 0.3 && changes.length >= 5 && rising > changes.length / 2) {
      verdict = {
        label: 'ACCUMULATION FOOTPRINT', tone: 'good',
        detail: `Institutions net-bought ${netInstBuyingPct}% of shares over ~6 months and ${rising} of the top ${changes.length} holders grew their stake.${lagNote}`,
      };
    } else if (netInstBuyingPct != null && netInstBuyingPct < -0.3 && changes.length >= 5 && rising < changes.length / 2) {
      verdict = {
        label: 'DISTRIBUTION FOOTPRINT', tone: 'warn',
        detail: `Institutions net-sold ${Math.abs(netInstBuyingPct)}% of shares over ~6 months and ${changes.length - rising} of the top ${changes.length} holders cut their stake.${lagNote}`,
      };
    }

    const data = {
      symbol: sym, market: 'US', asOf,
      source: 'Yahoo Finance (13F quarterly filings + ~6m net-activity aggregate)',
      summary: {
        instPct: pct(mhb.institutionsPercentHeld),
        instFloatPct: pct(mhb.institutionsFloatPercentHeld),
        instCount: mhb.institutionsCount ?? null,
        insiderPct: pct(mhb.insidersPercentHeld),
      },
      netActivity: {
        period: nsp.period || null,
        netInstBuyingPct,
        insiderBuys: nsp.buyInfoShares ?? null,
        insiderSells: nsp.sellInfoShares ?? null,
        insiderNetShares: nsp.netInfoShares ?? null,
      },
      topInstitutions, topFunds, verdict,
    };
    holdersCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
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

// ─── POST /api/us/holdings-fundamentals — bulk P/E + analyst target (Yahoo) ─
// Bulk P/E + analyst target for the US holdings table (Yahoo, $). Cached per symbol.
const usHoldingsFundCache = {}; // sym -> { data, ts }
const US_HOLDINGS_FUND_TTL = 60 * 60 * 1000; // 1h

router.post('/holdings-fundamentals', async (req, res) => {
  const { symbols = [] } = req.body || {};
  if (!Array.isArray(symbols) || !symbols.length) return res.json({});
  const uniq = [...new Set(symbols.map(s => String(s).toUpperCase()))];
  const out = {};
  const CONCURRENCY = 6;
  let i = 0;
  const worker = async () => {
    while (i < uniq.length) {
      const sym = uniq[i++];
      const hit = usHoldingsFundCache[sym];
      if (hit && Date.now() - hit.ts < US_HOLDINGS_FUND_TTL) { out[sym] = hit.data; continue; }
      try {
        const q = await yf.quoteSummary(sym,
          { modules: ['summaryDetail', 'financialData', 'price'] }, { validateResult: false });
        const sd = q.summaryDetail || {}, fd = q.financialData || {}, price = q.price || {};
        const data = {
          pe: sd.trailingPE ?? null,
          targetMean: fd.targetMeanPrice ?? null,
          currentPrice: fd.currentPrice ?? price.regularMarketPrice ?? null,
        };
        usHoldingsFundCache[sym] = { data, ts: Date.now() };
        out[sym] = data;
      } catch { out[sym] = { pe: null, targetMean: null, currentPrice: null }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniq.length) }, worker));
  res.json(out);
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

// ─── GET /api/us/cashflow/:symbol — annual cash-flow statement (Yahoo) ──────
// CFO / CFI / CFF + derived Net and Free Cash Flow, oldest→newest, so the
// US Instrument Cashflow tab mirrors the Indian one (which is screener-backed).
const cashflowCache = {}; // sym -> { data, ts }
const CASHFLOW_TTL = 6 * 60 * 60 * 1000; // 6h — statements rarely change intraday
router.get('/cashflow/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = cashflowCache[sym];
  if (hit && Date.now() - hit.ts < CASHFLOW_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const now = new Date();
    const period1 = new Date(now.getFullYear() - 6, 0, 1);
    const rows = await yf.fundamentalsTimeSeries(sym, { period1, period2: now, type: 'annual', module: 'all' });
    const years = (rows || []).map(r => {
      const d = r.date ? new Date(r.date) : null;
      const cfo = r.operatingCashFlow ?? null;
      const cfi = r.investingCashFlow ?? null;
      const cff = r.financingCashFlow ?? null;
      // Yahoo sometimes omits freeCashFlow → derive from CFO − capex.
      const capex = r.capitalExpenditure ?? null;
      const fcf = r.freeCashFlow ?? (cfo != null && capex != null ? cfo + capex : null); // capex is negative
      const net = r.changesInCash ?? ((cfo ?? 0) + (cfi ?? 0) + (cff ?? 0));
      return {
        fyLabel: d ? `FY ${d.getUTCFullYear()}` : '—',
        sortKey: d ? d.getTime() : 0,
        operatingCashFlow: cfo, investingCashFlow: cfi, financingCashFlow: cff,
        netCashFlow: (cfo == null && cfi == null && cff == null) ? null : net,
        freeCashFlow: fcf,
      };
    }).filter(y => y.operatingCashFlow != null || y.investingCashFlow != null || y.financingCashFlow != null)
      .sort((a, b) => a.sortKey - b.sortKey);
    const data = { symbol: sym, currency: 'USD', years };
    cashflowCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/us/balance-sheet/:symbol — annual balance sheet (Yahoo) ───────
// Curated asset / liability & equity line items + totals, oldest→newest, so the
// US Instrument Balance Sheet tab mirrors the Indian one (which is screener-backed).
const balanceSheetCache = {}; // sym -> { data, ts }
const BS_TTL = 6 * 60 * 60 * 1000; // 6h
router.get('/balance-sheet/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = balanceSheetCache[sym];
  if (hit && Date.now() - hit.ts < BS_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const now = new Date();
    const period1 = new Date(now.getFullYear() - 6, 0, 1);
    const rows = await yf.fundamentalsTimeSeries(sym, { period1, period2: now, type: 'annual', module: 'all' });
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const years = (rows || []).map(r => {
      const d = r.date ? new Date(r.date) : null;
      const equity = r.stockholdersEquity ?? r.totalEquityGrossMinorityInterest ?? r.commonStockEquity ?? null;
      const intangibles = r.goodwillAndOtherIntangibleAssets
        ?? ((r.goodwill ?? null) != null || (r.otherIntangibleAssets ?? null) != null
            ? (r.goodwill ?? 0) + (r.otherIntangibleAssets ?? 0) : null);
      // Yahoo's totalLiabilitiesNetMinorityInterest is (assets − permanent equity),
      // which lumps in redeemable/convertible preferred stock carried OUTSIDE
      // stockholders' equity (mezzanine / "temporary equity" — common pre-IPO).
      // That isn't a real liability, so split it out: real liabilities exclude it
      // and the preferred shows as its own line. Then the balance sheet reconciles
      // as Liabilities + Redeemable Preferred + Equity = Total Assets.
      const preferred = num(r.preferredSecuritiesOutsideStockEquity);
      const rawLiab = num(r.totalLiabilitiesNetMinorityInterest);
      const totalLiabilities = rawLiab == null ? null : rawLiab - (preferred ?? 0);
      return {
        fyLabel: d ? `FY ${d.getUTCFullYear()}` : '—',
        fy: d ? d.getUTCFullYear() : null,
        sortKey: d ? d.getTime() : 0,
        // Assets — "Cash & Investments" prefers the cash + short-term-investments
        // total so it matches its label (plain cash alone understates names that
        // park most liquidity in marketable securities).
        cash: num(r.cashCashEquivalentsAndShortTermInvestments ?? r.cashAndCashEquivalents),
        receivables: num(r.receivables ?? r.accountsReceivable),
        inventory: num(r.inventory),
        currentAssets: num(r.currentAssets ?? r.totalCurrentAssets),
        netPPE: num(r.netPPE),
        intangibles: num(intangibles),
        longTermInvestments: num(r.investmentsAndAdvances ?? r.longTermInvestments),
        totalAssets: num(r.totalAssets),
        // Liabilities & equity — prefer the narrow "Accounts payable" line so it
        // matches the 10-K (Yahoo's `payables` rolls in other current payables;
        // e.g. AAPL FY25 payables $82.9B vs accountsPayable $69.9B).
        payables: num(r.accountsPayable ?? r.payables),
        currentLiabilities: num(r.currentLiabilities ?? r.totalCurrentLiabilities),
        longTermDebt: num(r.longTermDebt),
        totalLiabilities,
        redeemablePreferred: preferred, // mezzanine equity; null/absent for most names
        retainedEarnings: num(r.retainedEarnings),
        equity: num(equity),
        // Derived inputs for the snapshot
        totalDebt: num(r.totalDebt),
      };
    }).filter(y => y.totalAssets != null || y.equity != null || y.totalLiabilities != null)
      .sort((a, b) => a.sortKey - b.sortKey);
    const data = { symbol: sym, currency: 'USD', years };
    balanceSheetCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/us/analysts/:symbol — Wall Street analyst coverage (Yahoo) ─────
// Recommendation distribution + trend over time, price targets, EPS/revenue
// estimates, and recent rating changes — everything the Analysts tab graphs.
const analystCache = {}; // sym -> { data, ts }
const ANALYST_TTL = 60 * 60 * 1000; // 1h
router.get('/analysts/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = analystCache[sym];
  if (hit && Date.now() - hit.ts < ANALYST_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const modules = ['price', 'financialData', 'recommendationTrend', 'upgradeDowngradeHistory', 'earningsTrend'];
    let q;
    try { q = await yf.quoteSummary(sym, { modules }); }
    catch { q = await yf.quoteSummary(sym, { modules: ['price', 'financialData', 'recommendationTrend'] }); }
    const price = q.price || {}, fd = q.financialData || {};
    const rt = q.recommendationTrend || {}, ud = q.upgradeDowngradeHistory || {}, et = q.earningsTrend || {};

    // Recommendation trend: newest period first ('0m' = current). Keep only the
    // five rating buckets and a total so the client can normalise the bars.
    const trend = (rt.trend || []).map(t => ({
      period: t.period,
      strongBuy: t.strongBuy ?? 0, buy: t.buy ?? 0, hold: t.hold ?? 0,
      sell: t.sell ?? 0, strongSell: t.strongSell ?? 0,
      total: (t.strongBuy ?? 0) + (t.buy ?? 0) + (t.hold ?? 0) + (t.sell ?? 0) + (t.strongSell ?? 0),
    })).filter(t => t.total > 0);

    // EPS / revenue consensus per forward period (0q, +1q, 0y, +1y).
    const estimates = (et.trend || []).map(t => ({
      period: t.period, endDate: t.endDate || null,
      growth: t.growth != null ? t.growth * 100 : null,
      eps: t.earningsEstimate ? {
        avg: t.earningsEstimate.avg ?? null, low: t.earningsEstimate.low ?? null,
        high: t.earningsEstimate.high ?? null, yearAgo: t.earningsEstimate.yearAgoEps ?? null,
        analysts: t.earningsEstimate.numberOfAnalysts ?? null,
        growth: t.earningsEstimate.growth != null ? t.earningsEstimate.growth * 100 : null,
      } : null,
      revenue: t.revenueEstimate ? {
        avg: t.revenueEstimate.avg ?? null, low: t.revenueEstimate.low ?? null,
        high: t.revenueEstimate.high ?? null, yearAgo: t.revenueEstimate.yearAgoRevenue ?? null,
        analysts: t.revenueEstimate.numberOfAnalysts ?? null,
        growth: t.revenueEstimate.growth != null ? t.revenueEstimate.growth * 100 : null,
      } : null,
    })).filter(e => ['0q', '+1q', '0y', '+1y'].includes(e.period));

    // Recent upgrades / downgrades, newest first, capped to the latest 12.
    const ratings = (ud.history || [])
      .map(h => ({
        date: h.epochGradeDate ? new Date(h.epochGradeDate).toISOString().slice(0, 10) : null,
        firm: h.firm || '—', toGrade: h.toGrade || '—', fromGrade: h.fromGrade || null,
        action: h.action || null,
      }))
      .filter(h => h.date)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 12);

    const data = {
      symbol: sym,
      name: price.longName || price.shortName || labelFor(sym),
      currency: price.currency || 'USD',
      currentPrice: fd.currentPrice ?? price.regularMarketPrice ?? null,
      target: {
        mean: fd.targetMeanPrice ?? null, median: fd.targetMedianPrice ?? null,
        high: fd.targetHighPrice ?? null, low: fd.targetLowPrice ?? null,
      },
      recommendationMean: fd.recommendationMean ?? null,
      recommendationKey: fd.recommendationKey ?? null,
      analysts: fd.numberOfAnalystOpinions ?? null,
      trend, estimates, ratings,
    };
    analystCache[sym] = { data, ts: Date.now() };
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
        (out[s] = out[s] || []).push(...bars[s].map(b => sanitizeBar({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
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

// ─── US-only analyst screener fields ────────────────────────────────────────
// These come from Yahoo's financialData module (one request per symbol, unlike
// the bulk-fetchable candles), so they're kept OUT of the shared screener engine
// and merged into the row separately, after the cheap technical pass. Conditions
// on these fields are validated/evaluated here, not by engine.js.
const US_ANALYST_FIELDS = [
  { key: 'consensusRating', label: 'Consensus Rating',       type: 'enum', enumValues: ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'], group: 'Analyst' },
  { key: 'recScore',        label: 'Analyst score (1=Buy…5=Sell)', type: 'number', group: 'Analyst' },
  { key: 'targetUpsidePct', label: '12-mo target upside %',  type: 'number', group: 'Analyst' },
  { key: 'numAnalysts',     label: '# of analysts',          type: 'number', group: 'Analyst' },
];
const US_ANALYST_BY_KEY = Object.fromEntries(US_ANALYST_FIELDS.map(f => [f.key, f]));
const US_NUMBER_OPS = ['gt', 'gte', 'lt', 'lte'];
const US_ENUM_OPS = ['is', 'isnot'];

// Validate analyst conditions (engine.validateConditions only knows technical
// fields and throws on these). Mirrors its number/enum rules.
function validateAnalystConditions(conds) {
  for (const c of conds) {
    const f = US_ANALYST_BY_KEY[c.field];
    if (f.type === 'number') {
      if (!US_NUMBER_OPS.includes(c.op)) throw new Error(`Invalid operator "${c.op}" for ${f.label}`);
      if (!Number.isFinite(Number(c.value))) throw new Error(`${f.label}: value must be a number`);
    } else {
      if (!US_ENUM_OPS.includes(c.op)) throw new Error(`Invalid operator "${c.op}" for ${f.label}`);
      if (!f.enumValues.includes(c.value)) throw new Error(`${f.label}: value must be one of ${f.enumValues.join(', ')}`);
    }
  }
}
function evaluateAnalystConditions(values, conds) {
  for (const c of conds) {
    const v = values[c.field];
    if (v == null) return false; // missing coverage never matches
    const target = US_ANALYST_BY_KEY[c.field].type === 'number' ? Number(c.value) : c.value;
    switch (c.op) {
      case 'gt': if (!(v > target)) return false; break;
      case 'gte': if (!(v >= target)) return false; break;
      case 'lt': if (!(v < target)) return false; break;
      case 'lte': if (!(v <= target)) return false; break;
      case 'is': if (v !== target) return false; break;
      case 'isnot': if (v === target) return false; break;
      default: return false;
    }
  }
  return true;
}

// Split a condition list into technical (engine) vs. analyst (US-only) buckets.
const splitConditions = (conditions = []) => ({
  tech: conditions.filter(c => !US_ANALYST_BY_KEY[c.field]),
  analyst: conditions.filter(c => US_ANALYST_BY_KEY[c.field]),
});

// Lightweight per-symbol analyst snapshot for the screener — just price +
// financialData (far cheaper than the full Analysts-tab payload). Cached 6h.
const analystScreenerCache = {}; // sym -> { v, ts }
const ANALYST_SCR_TTL = 6 * 60 * 60 * 1000;
const recBucket = (m) => m == null ? null
  : m <= 1.5 ? 'STRONG_BUY' : m <= 2.5 ? 'BUY' : m <= 3.5 ? 'HOLD' : m <= 4.5 ? 'SELL' : 'STRONG_SELL';
async function fetchAnalystScreenerData(sym) {
  const hit = analystScreenerCache[sym];
  if (hit && Date.now() - hit.ts < ANALYST_SCR_TTL) return hit.v;
  let v = { consensusRating: null, recScore: null, targetUpsidePct: null, numAnalysts: null };
  try {
    const q = await yf.quoteSummary(sym, { modules: ['price', 'financialData'] });
    const fd = q.financialData || {}, price = q.price || {};
    const mean = fd.recommendationMean ?? null;
    const cur = fd.currentPrice ?? price.regularMarketPrice ?? null;
    const tgt = fd.targetMeanPrice ?? null;
    v = {
      consensusRating: recBucket(mean),
      recScore: mean != null ? +mean.toFixed(2) : null,
      targetUpsidePct: (tgt != null && cur) ? +(((tgt - cur) / cur) * 100).toFixed(2) : null,
      numAnalysts: fd.numberOfAnalystOpinions ?? null,
    };
  } catch { /* leave nulls — no coverage */ }
  analystScreenerCache[sym] = { v, ts: Date.now() };
  return v;
}

// Run an async mapper over items with a bounded concurrency (keeps Yahoo happy).
async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

const usScreenerJobs = {};
let usScreenerSeq = 0;

async function runUsScreenerJob(job, { scope, conditions }) {
  const { label, symbols } = await resolveUsUniverse(scope);
  const { tech, analyst } = splitConditions(conditions);
  job.progress.total = symbols.length;
  job.progress.symbol = 'fetching price history…';
  const start = new Date(); start.setFullYear(start.getFullYear() - 2); // ~500 sessions: enough for SMA200 / 52w / 1Y return
  const barsBySym = await fetchBarsMulti(symbols, start);
  let matches = [];
  const notReady = [];
  for (const sym of symbols) {
    job.progress.symbol = sym;
    try {
      const candles = barsBySym[sym];
      if (!Array.isArray(candles) || candles.length < MIN_SCREENER_BARS) { notReady.push(sym); }
      else {
        const values = computeScreenerRow(candles);
        // Technical pass only here; analyst conditions are applied below after a
        // per-symbol Yahoo fetch restricted to the technical survivors.
        if (evaluateConditions(values, tech)) matches.push({ symbol: sym, token: sym, values });
      }
    } catch { notReady.push(sym); }
    finally { job.progress.loaded++; }
  }

  // Analyst pass — only when the scan uses an analyst field. Fetches ratings for
  // the technical survivors (concurrency-limited, cached), merges them into the
  // row, then filters. A pure analyst-only scan has tech=[] so every ready
  // symbol survives the technical pass and gets fetched.
  if (analyst.length > 0) {
    let done = 0;
    job.progress.symbol = `fetching analyst ratings… (0/${matches.length})`;
    await mapWithConcurrency(matches, 8, async (m) => {
      Object.assign(m.values, await fetchAnalystScreenerData(m.symbol));
      job.progress.symbol = `fetching analyst ratings… (${++done}/${matches.length})`;
    });
    matches = matches.filter(m => evaluateAnalystConditions(m.values, analyst));
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
  const technical = SCREENER_FIELDS.map(f => (f.key === 'price' ? { ...f, label: 'Price ($)' } : f));
  res.json({ fields: [...technical, ...US_ANALYST_FIELDS] });
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
  // Validate technical conditions via the shared engine and analyst conditions
  // via the US-only validator (the engine doesn't know analyst fields).
  try {
    if (!Array.isArray(conditions) || conditions.length === 0) throw new Error('At least one condition is required');
    if (conditions.length > 12) throw new Error('Too many conditions (max 12)');
    const { tech, analyst } = splitConditions(conditions);
    if (tech.length) validateConditions(tech);
    validateAnalystConditions(analyst);
  } catch (e) { return res.status(400).json({ error: e.message }); }

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
