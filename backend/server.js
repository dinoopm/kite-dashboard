const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SMA, EMA, RSI, MACD, BollingerBands, ATR, VWAP, ADX } = require('technicalindicators');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const cheerio = require('cheerio');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
// Alpaca US market-data router (required after dotenv so it sees the keys).
const { alpacaRouter } = require('./alpaca');
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

let mcpClient = null;
let mcpTransport = null;

// ─── In-memory cache ───────────────────────────────────────────
const historyCache = {};   // { instrument_token: [ {date, open, high, low, close, volume} ] }
const historicalFullCache = {};  // { token: { data: [...], timestamp: Date.now() } } — 1hr TTL for sector indices
const HISTORICAL_FULL_TTL = 60 * 60 * 1000; // 1 hour
const todayRefreshAt = {}; // { token: timestamp } — last time we pulled today's partial bar
const TODAY_REFRESH_COOLDOWN_MS = 60 * 1000; // don't hammer Kite for intraday refresh more than 1×/min/token
let holdingsCache = [];    // raw holdings array
let cacheReady = false;
let cacheWarming = false;

// ─── Helpers ───────────────────────────────────────────────────
const toYahooSymbol = (symbol) => {
  if (!symbol) return '';
  // Remove NSE: or BSE: prefix if present
  let cleanSymbol = symbol.replace(/^(NSE|BSE):/, '');
  
  // Strip NSE series suffixes (like -BE for Book Entry) before querying Yahoo
  cleanSymbol = cleanSymbol.replace(/-(BE|SM|EQ)$/i, '');

  // Unless it's an index or explicitly a global ticker, append .NS for Indian equities
  // (We assume NSE as default for Kite stocks if not specified)
  if (!cleanSymbol.includes('.') && cleanSymbol !== 'NIFTY 50' && cleanSymbol !== 'NIFTY BANK') {
    return `${cleanSymbol}.NS`;
  }
  return cleanSymbol;
};

const formatDate = (d, isEnd) => {
  const dateStr = d.toISOString().split('T')[0];
  return `${dateStr} ${isEnd ? '23:59:59' : '00:00:00'}`;
};

function parseMcpText(result) {
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text); } catch (e) { }
  }
  return null;
}

// Global rate limiter for Kite historical calls. Kite Connect allows ~3
// requests/sec for historical candles; we pace starts ~2.9/sec. This is the
// single choke point for EVERY history fetch, so callers can run in parallel
// (e.g. the screener) and never collectively exceed Kite's limit — replacing
// the scattered ad-hoc setTimeout delays that previously throttled serially.
const KITE_HIST_MIN_MS = 345;
let _histNextSlot = 0;
function reserveHistSlot() {
  const now = Date.now();
  const start = Math.max(now, _histNextSlot);
  _histNextSlot = start + KITE_HIST_MIN_MS;
  const wait = start - now;
  return wait > 0 ? new Promise(r => setTimeout(r, wait)) : Promise.resolve();
}

async function fetchHistorical(token, fromDate, toDate, interval = 'day') {
  await reserveHistSlot();
  const result = await mcpClient.callTool({
    name: "get_historical_data",
    arguments: {
      instrument_token: parseInt(token, 10),
      from_date: formatDate(fromDate, false),
      to_date: formatDate(toDate, true),
      interval,
      continuous: false,
      oi: false
    }
  });
  if (result.isError) return null;
  return parseMcpText(result);
}

// Refresh today's partial daily candle for a single token if the cached tail
// is stale (older than today) or if we haven't polled within the cooldown.
// Replaces cached[last] if its date matches today, else appends.
async function refreshTodayCandle(token) {
  const now = Date.now();
  const last = todayRefreshAt[token] || 0;
  if (now - last < TODAY_REFRESH_COOLDOWN_MS) return;
  todayRefreshAt[token] = now;

  try {
    const cached = historyCache[token];
    if (!cached || cached.length === 0) return;

    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    const tailKey = (cached[cached.length - 1]?.date || '').slice(0, 10);

    // Pull a 2-day window so we always get today's bar (if market is open/closed today).
    const from = new Date(today);
    from.setDate(today.getDate() - 1);
    const data = await fetchHistorical(token, from, today, 'day');
    if (!Array.isArray(data) || data.length === 0) return;

    const latest = data[data.length - 1];
    const latestKey = (latest?.date || '').slice(0, 10);
    if (!latestKey) return;

    if (latestKey === tailKey) {
      cached[cached.length - 1] = latest;
    } else if (latestKey > tailKey) {
      cached.push(latest);
    }
  } catch (err) {
    // Non-fatal: fall through with stale cache.
    console.log(`  ⚠️  refreshTodayCandle(${token}) failed: ${err.message}`);
  }
}

// Refresh today's partial daily candle in historicalFullCache (used by sector-alerts).
async function refreshTodayCandle_FullHistory(token) {
  const now = Date.now();
  const last = todayRefreshAt[token] || 0;
  if (now - last < TODAY_REFRESH_COOLDOWN_MS) return;
  todayRefreshAt[token] = now;

  try {
    const cached = historicalFullCache[token]?.data;
    if (!Array.isArray(cached) || cached.length === 0) return;

    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    const tailKey = (cached[cached.length - 1]?.date || '').slice(0, 10);

    // Pull a 2-day window so we always get today's bar (if market is open/closed today).
    const from = new Date(today);
    from.setDate(today.getDate() - 1);
    const data = await fetchHistorical(token, from, today, 'day');
    if (!Array.isArray(data) || data.length === 0) return;

    const latest = data[data.length - 1];
    const latestKey = (latest?.date || '').slice(0, 10);
    if (!latestKey) return;

    if (latestKey === tailKey) {
      cached[cached.length - 1] = latest;
    } else if (latestKey > tailKey) {
      cached.push(latest);
    }
  } catch (err) {
    // Non-fatal: fall through with stale cache.
    console.log(`  ⚠️  refreshTodayCandle_FullHistory(${token}) failed: ${err.message}`);
  }
}

// Sector lookup via Yahoo Finance, cached in-memory for the life of the process.
// First /api/alerts call after boot pays one Yahoo round-trip per holding;
// subsequent calls are instant. `null` is a valid cached value (lookup failed).
const sectorCache = {}; // symbol -> { sector, industry } (null fields on lookup failure)
async function getSectorMeta(symbol) {
  if (sectorCache[symbol] !== undefined) return sectorCache[symbol];
  try {
    const yahooSym = toYahooSymbol(symbol);
    const q = await yahooFinance.quoteSummary(yahooSym, { modules: ['assetProfile'] });
    sectorCache[symbol] = { sector: q?.assetProfile?.sector || null, industry: q?.assetProfile?.industry || null };
  } catch {
    sectorCache[symbol] = { sector: null, industry: null };
  }
  return sectorCache[symbol];
}
// Back-compat helper (the alert engine wants just the sector string).
async function getSectorCached(symbol) {
  return (await getSectorMeta(symbol)).sector;
}

// Surface sectors where ≥3 holdings are flagged AVOID/SELL — concentration risk.
function computeSectorConcentration(alerts) {
  const bySector = {};
  for (const a of alerts) {
    const sec = a.sector || 'Unknown';
    if (!bySector[sec]) bySector[sec] = { total: 0, flagged: 0, symbols: [] };
    bySector[sec].total += 1;
    if (a.tradePlan?.action === 'AVOID' || a.tradePlan?.action === 'SELL (AT RANGE)') {
      bySector[sec].flagged += 1;
      bySector[sec].symbols.push(a.symbol);
    }
  }
  return Object.entries(bySector)
    .filter(([, v]) => v.flagged >= 3)
    .map(([sector, v]) => ({ sector, flagged: v.flagged, total: v.total, symbols: v.symbols }));
}

// Kite MCP returns at most ~1 year of daily candles per request.
// To get multi-year data we fetch in 1-year chunks and concatenate.
async function fetchHistoricalMultiYear(token, years = 5) {
  const tok = parseInt(token, 10);
  const allCandles = [];
  const now = new Date();

  const dedupeSort = (arr) => {
    const seen = new Set();
    const out = [];
    for (const c of arr) {
      if (c && c.date && !seen.has(c.date)) { seen.add(c.date); out.push(c); }
    }
    return out.sort((a, b) => new Date(a.date) - new Date(b.date));
  };

  for (let y = years; y > 0; y--) {
    const chunkEnd = new Date(now);
    chunkEnd.setFullYear(now.getFullYear() - (y - 1));
    const chunkStart = new Date(now);
    chunkStart.setFullYear(now.getFullYear() - y);

    // fetchHistorical returns null on an MCP error (e.g. a transient rate
    // limit). A dropped chunk silently punches a hole in the series; when it's
    // the most-recent chunk the cached history is left a full year stale (this
    // is what made ASHOKLEY's 1W–1Y returns all read 0.00%). Retry before
    // giving up so a single flaky call doesn't poison the 1h cache.
    let data = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        data = await fetchHistorical(tok, chunkStart, chunkEnd, 'day');
      } catch (err) {
        console.log(`  ⚠️  Chunk ${y}Y-${y - 1}Y attempt ${attempt} threw for token ${token}: ${err.message}`);
      }
      if (Array.isArray(data) && data.length > 0) break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 600 * attempt));
    }
    if (Array.isArray(data) && data.length > 0) {
      allCandles.push(...data);
    } else {
      console.log(`  ⚠️  Chunk ${y}Y-${y - 1}Y empty for token ${token} after retries`);
    }
    // Pacing is handled globally by reserveHistSlot() inside fetchHistorical.
  }

  let deduped = dedupeSort(allCandles);

  // Self-heal a stale tail. If the most-recent chunk still came back empty, the
  // newest bar will sit well behind today even though the instrument is trading.
  // A single recent-window daily call is the request Kite serves most reliably,
  // so fetch it once and merge — this guarantees fresh short-window returns even
  // when a yearly chunk fails. Healthy series (tail within a week) skip this.
  const last = deduped.length ? new Date(deduped[deduped.length - 1].date) : null;
  const staleDays = last ? (now - last) / 86400000 : Infinity;
  if (staleDays > 7) {
    const recentStart = new Date(now);
    recentStart.setDate(now.getDate() - 400);
    try {
      const recent = await fetchHistorical(tok, recentStart, now, 'day');
      if (Array.isArray(recent) && recent.length > 0) {
        deduped = dedupeSort([...deduped, ...recent]);
      }
    } catch (err) {
      console.log(`  ⚠️  Recent-window catch-up failed for token ${token}: ${err.message}`);
    }
  }

  return deduped;
}

// ─── Cache warm-up ─────────────────────────────────────────────
async function warmCache(retries = 3) {
  if (cacheReady || cacheWarming) return;
  cacheWarming = true;

  console.log("⏳ Warming cache: fetching holdings...");
  try {
    let holdings = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      const holdResult = await mcpClient.callTool({
        name: "get_holdings",
        arguments: {}
      });

      if (holdResult.isError) {
        console.log(`  ⚠️  Holdings fetch attempt ${attempt} returned error, retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      holdings = parseMcpText(holdResult);
      if (holdings && holdings.data) holdings = holdings.data;
      if (Array.isArray(holdings)) break;

      console.log(`  ⚠️  Holdings parse attempt ${attempt} failed, retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      holdings = null;
    }

    if (!Array.isArray(holdings)) {
      console.error("❌ Could not parse holdings after retries. Cache warm-up aborted.");
      return;
    }
    holdingsCache = holdings;

    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - (365 * 3)); // 3 years of daily data to satisfy 3Y MAX requests

    let cached = 0;
    for (const h of holdings) {
      const token = h.instrument_token;
      try {
        console.log(`  📊 Fetching history for ${h.tradingsymbol} (${token})...`);
        const data = await fetchHistorical(token, fromDate, toDate, 'day');
        if (Array.isArray(data) && data.length > 0) {
          historyCache[token] = data;
          cached++;
        } else {
          console.log(`  ⚠️  No data for ${h.tradingsymbol}`);
        }
      } catch (err) {
        console.log(`  ⚠️  Failed for ${h.tradingsymbol}: ${err.message}`);
      }
      // Rate limit: wait 1s between requests
      await new Promise(r => setTimeout(r, 1000));
    }
    cacheReady = true;
    cacheWarming = false;
    console.log(`✅ Cache warm-up complete: ${cached}/${holdings.length} instruments cached`);

    // Fire-and-forget: warm the index history cache so the Indices Performance
    // page sees complete data on first open instead of partial/flickering rows.
    prewarmRrgHistoricalCache().catch(e => console.error("Index prewarm error:", e.message));
    // Keep it warm: re-run before the 1h historical-full TTL lapses. Guarded so
    // reconnects don't stack intervals; the prewarm itself skips still-fresh tokens.
    if (!indexPrewarmTimer) {
      indexPrewarmTimer = setInterval(
        () => prewarmRrgHistoricalCache().catch(e => console.error("Index prewarm (timer) error:", e.message)),
        50 * 60 * 1000,
      );
    }
  } catch (err) {
    cacheWarming = false;
    console.error("❌ Cache warm-up failed:", err.message);
  }
}

// ─── MCP Connection ────────────────────────────────────────────
let isReconnecting = false;

async function connectToKiteMcp() {
  console.log("Connecting to Kite MCP server...");
  mcpTransport = new StdioClientTransport({
    command: "npx",
    args: ["--yes", "mcp-remote", "https://mcp.kite.trade/mcp"],
  });

  mcpClient = new Client(
    { name: "kite-dashboard-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await mcpClient.connect(mcpTransport);
    console.log("Successfully connected to Kite MCP!");
    // Proactively warm the Indices history cache once the MCP is up — independent
    // of the holdings warm-up (which a flaky get_holdings can block), so the
    // Indices Performance page is fast even on a direct first visit. Right after a
    // (re)connect the session can be slow to answer get_quotes (token resolution),
    // so retry with backoff until the cache actually has entries. Idempotent.
    const kickIndexPrewarm = (attempt = 0) => {
      prewarmRrgHistoricalCache()
        .catch(e => console.error("Index prewarm (connect) error:", e.message))
        .finally(() => {
          if (Object.keys(historicalFullCache).length === 0 && attempt < 5) {
            setTimeout(() => kickIndexPrewarm(attempt + 1), 30000);
          }
        });
    };
    setTimeout(() => kickIndexPrewarm(), 12000);
    if (!indexPrewarmTimer) {
      indexPrewarmTimer = setInterval(
        () => prewarmRrgHistoricalCache().catch(e => console.error("Index prewarm (timer) error:", e.message)),
        50 * 60 * 1000,
      );
    }
  } catch (err) {
    console.error("Failed to connect to MCP:", err);
  }
}

async function reconnectMcp() {
  if (isReconnecting) {
    console.log("⏳ Reconnection already in progress, waiting...");
    // Wait for the in-progress reconnection to finish
    while (isReconnecting) await new Promise(r => setTimeout(r, 500));
    return;
  }
  isReconnecting = true;
  console.log("🔄 Auto-reconnecting MCP client...");

  // Tear down existing connection
  try {
    if (mcpTransport) await mcpTransport.close();
  } catch (e) { /* ignore */ }

  try {
    require('child_process').execSync('pkill -f "mcp-remote"');
  } catch (e) { /* ignore if no process */ }

  mcpClient = null;
  mcpTransport = null;

  // Clear API caches so stale data doesn't persist
  Object.keys(apiCache || {}).forEach(k => {
    if (apiCache[k]) { apiCache[k].data = null; apiCache[k].timestamp = 0; }
  });

  await new Promise(r => setTimeout(r, 1500)); // let processes die cleanly
  await connectToKiteMcp();
  isReconnecting = false;
  console.log("✅ MCP reconnected successfully.");
}

// ─── API Routes ────────────────────────────────────────────────

async function largeDealsHandler(req, res) {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const symbol = req.params.symbol;
    const { from, to, search, deal_category } = req.query;
    // Default limit 1000 when no symbol path; preserves rich histories for
    // the /market-data/large-deals page while keeping payloads bounded.
    const limit = Math.min(parseInt(req.query.limit, 10) || (symbol ? 1000 : 1000), 5000);

    let query = supabase
      .from('large_deals')
      .select('*')
      .order('trade_date', { ascending: false });

    if (symbol) query = query.eq('symbol', symbol.toUpperCase());
    if (deal_category) query = query.eq('deal_category', deal_category.toUpperCase());
    if (from) query = query.gte('trade_date', from);
    if (to)   query = query.lte('trade_date', to);
    // Search is a substring filter on symbol or client_name (case-insensitive).
    if (search) query = query.or(`symbol.ilike.%${search}%,client_name.ilike.%${search}%`);

    query = query.limit(limit);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/large-deals', largeDealsHandler);
app.get('/api/large-deals/:symbol', largeDealsHandler);

app.get('/api/top-gainers-losers', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const { category, index_name, from, to, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    let query = supabase
      .from('top_gainers_losers')
      .select('*')
      .order('trade_date', { ascending: false })
      .order('pct_change', { ascending: category === 'LOSER' });

    if (category) query = query.eq('category', category.toUpperCase());
    if (index_name) query = query.eq('index_name', index_name);
    // Preserve legacy default: when no date or index filter is given,
    // restrict to the 'allSec' index so the dashboard widget keeps working.
    if (!index_name && !from && !to) query = query.eq('index_name', 'allSec');
    if (from) query = query.gte('trade_date', from);
    if (to)   query = query.lte('trade_date', to);
    if (search) query = query.ilike('symbol', `%${search}%`);

    query = query.limit(limit);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fiidii', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    // Default to just the latest row (the dashboard widget only renders one).
    // The /market-data/fii-dii page passes ?limit=1000 with optional ?from
    // and ?to date filters to populate a full historical table. Limit is
    // capped at 1000 to keep payloads bounded — that's ~4 years of trading
    // days, plenty for the UI's date-range needs.
    const limit = Math.min(parseInt(req.query.limit, 10) || 1, 1000);
    const { from, to } = req.query;
    let q = supabase
      .from('fii_dii_activity')
      .select('*')
      .order('trade_date', { ascending: false });
    if (from) q = q.gte('trade_date', from);
    if (to)   q = q.lte('trade_date', to);
    q = q.limit(limit);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/participant-oi', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    // Default to the latest 20 rows (back-compat). The FII/DII dashboard passes
    // ?from/?to with ?limit up to 1000 to chart the long/short trend, and may
    // narrow to a single ?client_type (FII / DII / Pro / Client).
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 1000);
    const { from, to, client_type } = req.query;
    let q = supabase
      .from('participant_oi')
      .select('*')
      .order('trade_date', { ascending: false });
    if (from) q = q.gte('trade_date', from);
    if (to)   q = q.lte('trade_date', to);
    if (client_type) q = q.eq('client_type', client_type.toUpperCase());
    q = q.limit(limit);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FII/DII Overview (institutional dashboard) ─────────────────
// One aggregating fetch for the FII/DII visual dashboard: daily cash-market
// flows (fii_dii_activity) + FII/DII index-futures positioning (participant_oi)
// + aligned daily closes for three market-cap segments (Nifty 50 / Midcap 100 /
// Smallcap 250) so flows can be read against price across the cap spectrum.
// The index overlays are best-effort: if Kite is unreachable the endpoint still
// returns flows + OI, with each index field null and marked unavailable in meta.
const fiidiiOverviewCache = {};            // { 'from|to': { data, timestamp } }
const FIIDII_OVERVIEW_TTL = 10 * 60 * 1000; // 10 min

// Cap-segment overlays. `field` is the per-flow-row key the frontend charts on.
const FLOW_OVERLAY_INDICES = [
  { key: 'NSE:NIFTY 50',          field: 'nifty50_close',    label: 'Nifty 50' },
  { key: 'NSE:NIFTY MIDCAP 100',  field: 'midcap100_close',  label: 'Midcap 100' },
  { key: 'NSE:NIFTY SMLCAP 250',  field: 'smallcap250_close', label: 'Smallcap 250' },
];

const indexTokenCache = {}; // { 'NSE:...': token }
async function resolveIndexTokens(keys) {
  // Seed from the RRG cache where it already resolved the same key.
  for (const k of keys) if (!indexTokenCache[k] && rrgTokenCache[k]) indexTokenCache[k] = rrgTokenCache[k];
  const missing = keys.filter(k => !indexTokenCache[k]);
  if (missing.length) {
    const q = await callWithTimeout({ name: 'get_quotes', arguments: { instruments: missing } });
    const quotes = parseMcpText(q) || {};
    for (const k of missing) if (quotes[k]?.instrument_token) indexTokenCache[k] = String(quotes[k].instrument_token);
  }
  return keys.map(k => ({ key: k, token: indexTokenCache[k] || null }));
}

app.get('/api/fiidii-overview', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const { from, to } = req.query;
    const cacheKey = `${from || ''}|${to || ''}`;
    const cachedHit = fiidiiOverviewCache[cacheKey];
    if (cachedHit && Date.now() - cachedHit.timestamp < FIIDII_OVERVIEW_TTL) {
      return res.json(cachedHit.data);
    }

    // 1. Cash-market flows, ascending by date for charting.
    let fq = supabase.from('fii_dii_activity').select('*').order('trade_date', { ascending: true });
    if (from) fq = fq.gte('trade_date', from);
    if (to)   fq = fq.lte('trade_date', to);
    const { data: flowsRaw, error: fErr } = await fq.limit(1500);
    if (fErr) throw fErr;

    // 2. FII + DII index-futures positioning, reshaped to one row per date.
    let oq = supabase.from('participant_oi').select('*')
      .in('client_type', ['FII', 'DII'])
      .order('trade_date', { ascending: true });
    if (from) oq = oq.gte('trade_date', from);
    if (to)   oq = oq.lte('trade_date', to);
    const { data: oiRaw, error: oErr } = await oq.limit(3000);
    if (oErr) throw oErr;

    const oiByDate = new Map();
    for (const r of oiRaw || []) {
      let row = oiByDate.get(r.trade_date);
      if (!row) { row = { trade_date: r.trade_date }; oiByDate.set(r.trade_date, row); }
      const p = r.client_type === 'FII' ? 'fii' : 'dii';
      row[`${p}_fut_idx_long`]  = r.future_index_long;
      row[`${p}_fut_idx_short`] = r.future_index_short;
    }
    const oi = [...oiByDate.values()];

    // 3. Cap-segment daily closes per trade_date — best-effort, never fails the
    // response. Each index gets its own date→close map; a failure for one index
    // leaves only that overlay null.
    const closeMaps = {};                 // field -> Map(date -> close)
    const indicesMeta = FLOW_OVERLAY_INDICES.map(i => ({ field: i.field, label: i.label, available: false, lastClose: null, token: null }));
    try {
      if (mcpClient) {
        const resolved = await resolveIndexTokens(FLOW_OVERLAY_INDICES.map(i => i.key));
        for (let i = 0; i < FLOW_OVERLAY_INDICES.length; i++) {
          const cfg = FLOW_OVERLAY_INDICES[i];
          const token = resolved[i].token;
          if (!token) continue;
          try {
            const { data: bars } = await getOrFetchFullHistory(token);
            if (Array.isArray(bars) && bars.length > 0) {
              const m = new Map();
              for (const b of bars) if (b?.date && b.close != null) m.set(String(b.date).slice(0, 10), b.close);
              if (m.size > 0) {
                closeMaps[cfg.field] = m;
                indicesMeta[i] = { field: cfg.field, label: cfg.label, available: true, lastClose: bars[bars.length - 1].close, token };
              }
            }
          } catch (e) {
            console.warn(`fiidii-overview: ${cfg.label} overlay unavailable:`, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('fiidii-overview: index token resolve failed:', e.message);
    }

    const flows = (flowsRaw || []).map(r => {
      const day = String(r.trade_date).slice(0, 10);
      const row = {
        trade_date: r.trade_date,
        fii_buy: r.fii_buy, fii_sell: r.fii_sell, fii_net: r.fii_net,
        dii_buy: r.dii_buy, dii_sell: r.dii_sell, dii_net: r.dii_net,
      };
      for (const cfg of FLOW_OVERLAY_INDICES) row[cfg.field] = closeMaps[cfg.field]?.get(day) ?? null;
      return row;
    });

    const anyIndexAvailable = indicesMeta.some(m => m.available);
    const allIndicesAvailable = indicesMeta.every(m => m.available);
    const payload = {
      flows,
      oi,
      indices: indicesMeta,
      meta: { from: from || null, to: to || null, indicesAvailable: anyIndexAvailable },
    };
    // Only cache a fully-populated payload. If any overlay was unavailable
    // (e.g. broker session briefly down), skip caching so the next request
    // self-heals rather than serving a degraded result for the full TTL.
    if (allIndicesAvailable) {
      fiidiiOverviewCache[cacheKey] = { data: payload, timestamp: Date.now() };
    }
    res.json(payload);
  } catch (err) {
    console.error('fiidii-overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/surveillance', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const { measure, search } = req.query;
    let query = supabase.from('surveillance_stocks').select('*').order('symbol', { ascending: true });
    if (measure) query = query.eq('measure', measure.toUpperCase());
    if (search) query = query.ilike('symbol', `%${search}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NSE 52-week high/low daily snapshot — daily-keyed time series.
app.get('/api/52wk-high-low', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const { from, to, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    let query = supabase
      .from('nse_52_week_high_low')
      .select('*')
      .order('trade_date', { ascending: false })
      .order('symbol', { ascending: true });
    if (from) query = query.gte('trade_date', from);
    if (to)   query = query.lte('trade_date', to);
    if (search) query = query.or(`symbol.ilike.%${search}%,company_name.ilike.%${search}%`);
    query = query.limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NSE volume gainers — daily snapshot of stocks with unusual volume.
app.get('/api/volume-gainers', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const { from, to, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    let query = supabase
      .from('volume_gainers')
      .select('*')
      .order('trade_date', { ascending: false })
      .order('week1_vol_change', { ascending: false, nullsFirst: false });
    if (from) query = query.gte('trade_date', from);
    if (to)   query = query.lte('trade_date', to);
    if (search) query = query.or(`symbol.ilike.%${search}%,company_name.ilike.%${search}%`);
    query = query.limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cache-status', (req, res) => {
  res.json({
    ready: cacheReady,
    instrumentsCached: Object.keys(historyCache).length,
    totalHoldings: holdingsCache.length
  });
});

app.post('/api/disconnect', async (req, res) => {
  console.log("🔄 Disconnecting MCP client and clearing caches...");

  // 1. Clear caches
  Object.keys(historyCache).forEach(k => delete historyCache[k]);
  Object.keys(historicalFullCache).forEach(k => delete historicalFullCache[k]);
  holdingsCache.length = 0;
  cacheReady = false;

  Object.keys(apiCache).forEach(k => {
    apiCache[k].data = null;
    apiCache[k].timestamp = 0;
  });

  // 2. Shut down connection to MCP
  try {
    if (mcpTransport) {
      await mcpTransport.close();
    }
  } catch (err) {
    console.error("Error closing transport:", err.message);
  }

  try {
    // Force kill any dangling mcp-remote child processes to prevent Invalid Session conflicts
    require('child_process').execSync('pkill -f "mcp-remote"');
  } catch (e) {
    // Ignore if no process found
  }

  mcpClient = null;
  mcpTransport = null;

  // 3. Restart MCP process (with delay to ensure clean kill)
  setTimeout(() => {
    connectToKiteMcp().catch(e => console.error(e));
  }, 1000);

  res.json({ success: true, message: "Disconnected successfully" });
});

app.post('/api/login', async (req, res) => {
  try {
    // If MCP is dead, try reconnecting first
    if (!mcpClient) {
      console.log("⚡ MCP not connected, reconnecting before login...");
      await reconnectMcp();
    }
    if (!mcpClient) return res.status(500).json({ error: "MCP reconnection failed. Please try again." });

    // Clear all API caches so the next fetch gets fresh data after authentication
    Object.keys(apiCache).forEach(k => {
      apiCache[k].data = null;
      apiCache[k].timestamp = 0;
    });

    try {
      const result = await callWithTimeout({ name: "login", arguments: {} }, 30000);
      res.json(result);
    } catch (err) {
      // If it timed out, the MCP connection is likely stale — auto-reconnect and retry once
      if (err.message.includes('Timed out') || err.message.includes('timed out')) {
        console.log("⚡ Login timed out, auto-reconnecting MCP and retrying...");
        await reconnectMcp();
        if (!mcpClient) return res.status(500).json({ error: "MCP reconnection failed after timeout. Please try again." });
        const result = await callWithTimeout({ name: "login", arguments: {} }, 30000);
        res.json(result);
      } else {
        throw err;
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Allow frontend to explicitly trigger a reconnect without server restart
app.post('/api/reconnect', async (req, res) => {
  try {
    await reconnectMcp();
    res.json({ success: true, message: "MCP reconnected successfully." });
  } catch (err) {
    res.status(500).json({ error: "Reconnection failed: " + err.message });
  }
});

// Cache map to prevent MCP hammering from rapid React Navigation
const CACHE_TTL = 60000; // 60 seconds
const apiCache = {
  profile: { data: null, timestamp: 0 },
  holdings: { data: null, timestamp: 0 },
  mfHoldings: { data: null, timestamp: 0 },
  margins: { data: null, timestamp: 0 }
};
const apiPromises = {
  profile: null, holdings: null, mfHoldings: null, margins: null
};

// Detect upstream Kite rate-limit errors so we can return a structured 429
// to the frontend (which uses `Retry-After` to back off polling).
function detectRateLimit(err) {
  if (!err) return null;
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes('too many requests') || msg.includes('rate limit') || msg.includes('429')) {
    const m = msg.match(/retry[\s-]?after[^0-9]*(\d+)/);
    return { retryAfter: m ? parseInt(m[1], 10) : 5 };
  }
  return null;
}

// Timeout for MCP client calls (15s) to avoid hanging forever when mcp-remote hangs
const callWithTimeout = (cmdObj, ms = 15000) => {
  if (!mcpClient) return Promise.reject(new Error("MCP not connected"));
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`MCP Request Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([
    mcpClient.callTool(cmdObj),
    timeoutPromise
  ]).finally(() => clearTimeout(timeoutId)).catch(err => {
    const rl = detectRateLimit(err);
    if (rl) {
      const e = new Error('rate_limited');
      e.statusCode = 429;
      e.retryAfter = rl.retryAfter;
      throw e;
    }
    throw err;
  });
};

// Track instrument indicator fetches to prevent duplicate/race conditions
const indicatorPromises = {};

// Coalesce concurrent /api/historical-full fetches for the same token. Without this,
// multiple parallel callers each launch their own fetchHistoricalMultiYear MCP storm.
const historicalFullPromises = {};   // { token: Promise<data[]> }
const historicalFullWarming = { active: false, total: 0, loaded: 0, startedAt: null };
let indexPrewarmTimer = null;        // periodic re-warm so the 1h TTL never lapses cold

async function getOrFetchFullHistory(token) {
  const cached = historicalFullCache[token];
  if (cached && (Date.now() - cached.timestamp < HISTORICAL_FULL_TTL)) {
    return { data: cached.data, cached: true };
  }
  if (historicalFullPromises[token]) {
    return { data: await historicalFullPromises[token], cached: false };
  }
  // Fetch 4 calendar years (not 3): the 3Y table column anchors at 756 trading
  // days back, but 3 calendar years of NSE sessions is only ~745–750 bars, so a
  // 3-year fetch left the 3Y column permanently blank. The extra year guarantees
  // >756 bars without affecting shorter lookbacks.
  historicalFullPromises[token] = fetchHistoricalMultiYear(token, 4)
    .then(data => {
      if (Array.isArray(data) && data.length > 0) {
        historicalFullCache[token] = { data, timestamp: Date.now() };
      }
      return data || [];
    })
    .finally(() => { delete historicalFullPromises[token]; });
  return { data: await historicalFullPromises[token], cached: false };
}

// Lighter history for the screener: it only needs ~2 years (SMA200 + 1Y return
// / 52w-high all fit in <500 NSE sessions), so a cold symbol fetches 2 one-year
// chunks instead of 4 — halving the Kite calls per symbol. Reuses the richer 4Y
// cache whenever it's already warm (it's a superset), and keeps its own 2Y cache
// for repeat scans, so other features' deeper history is never downgraded.
const screenerHistCache = {};    // token -> { data, timestamp } (2Y depth)
const screenerHistPromises = {}; // token -> Promise<data[]>
async function getScreenerHistory(token) {
  const full = historicalFullCache[token];
  if (full && (Date.now() - full.timestamp < HISTORICAL_FULL_TTL)) return full.data;
  const sc = screenerHistCache[token];
  if (sc && (Date.now() - sc.timestamp < HISTORICAL_FULL_TTL)) return sc.data;
  if (screenerHistPromises[token]) return screenerHistPromises[token];
  screenerHistPromises[token] = fetchHistoricalMultiYear(token, 2)
    .then(data => {
      if (Array.isArray(data) && data.length > 0) screenerHistCache[token] = { data, timestamp: Date.now() };
      return data || [];
    })
    .finally(() => { delete screenerHistPromises[token]; });
  return screenerHistPromises[token];
}

async function fetchWithCache(toolName, cacheKey, args = {}) {
  const now = Date.now();
  if (apiCache[cacheKey].data && (now - apiCache[cacheKey].timestamp < CACHE_TTL)) {
    return apiCache[cacheKey].data;
  }
  if (apiPromises[cacheKey]) return apiPromises[cacheKey];

  apiPromises[cacheKey] = callWithTimeout({ name: toolName, arguments: args }, 15000)
    .then(result => {
      // Only cache successful responses — never cache errors
      if (!result.isError) {
        apiCache[cacheKey] = { data: result, timestamp: Date.now() };
      }
      apiPromises[cacheKey] = null;
      return result;
    })
    .catch(err => {
      apiPromises[cacheKey] = null;
      throw err;
    });

  return apiPromises[cacheKey];
}

app.get('/api/profile', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const result = await fetchWithCache("get_profile", "profile", {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Instrument metadata (company name from Kite, not Yahoo) ────
// Kite's search_instruments(filter_on=id, query=NSE:SYMBOL) returns the cash
// market row with the proper company name ("HINDUSTAN ZINC", "RELIANCE
// INDUSTRIES", etc.). Yahoo's longName is slower and sometimes missing for
// Indian tickers, so we prefer Kite as the canonical source.
const instrumentInfoCache = {}; // symbol -> { data, ts }
const INSTRUMENT_INFO_TTL = 24 * 60 * 60 * 1000; // 24h — company names don't change

// Reusable company-name lookup (Kite search_instruments, shares the cache with
// the /api/instrument-info route). Returns the name string or null. Used by the
// screener to label matches that don't already carry a name (e.g. holdings).
async function resolveInstrumentName(symbol, exchange = 'NSE') {
  const sym = String(symbol).toUpperCase();
  const cacheKey = `${exchange}:${sym}`;
  const hit = instrumentInfoCache[cacheKey];
  if (hit && Date.now() - hit.ts < INSTRUMENT_INFO_TTL) return hit.data?.name || null;
  try {
    const result = await callWithTimeout({ name: 'search_instruments', arguments: { query: cacheKey, filter_on: 'id', limit: 20 } }, 8000);
    let info = { symbol: sym, exchange, name: null, isin: null, tradingsymbol: sym, instrument_token: null };
    if (result?.content?.[0]?.text) {
      const rows = (JSON.parse(result.content[0].text)?.data) || [];
      const row = rows.find(r => r.id === cacheKey)
        || rows.find(r => (r.tradingsymbol || '').toUpperCase() === sym && (r.exchange || '').toUpperCase() === exchange)
        || rows[0];
      if (row) info = { symbol: sym, exchange, name: row.name || null, isin: row.isin || null, tradingsymbol: row.tradingsymbol || sym, instrument_token: row.instrument_token || null };
    }
    instrumentInfoCache[cacheKey] = { data: info, ts: Date.now() };
    return info.name;
  } catch {
    return null;
  }
}

app.get('/api/instrument-info/:symbol', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  const symbol = req.params.symbol.toUpperCase();
  const exchange = (req.query.exchange || 'NSE').toUpperCase();
  const cacheKey = `${exchange}:${symbol}`;
  const now = Date.now();
  if (instrumentInfoCache[cacheKey] && now - instrumentInfoCache[cacheKey].ts < INSTRUMENT_INFO_TTL) {
    return res.json(instrumentInfoCache[cacheKey].data);
  }
  try {
    const result = await callWithTimeout({
      name: "search_instruments",
      arguments: { query: cacheKey, filter_on: "id", limit: 20 }
    }, 8000);
    let info = { symbol, exchange, name: null, isin: null, instrument_token: null };
    if (result?.content?.[0]?.text) {
      const parsed = JSON.parse(result.content[0].text);
      // Kite's id search is a PREFIX match — querying "NSE:NTPC" also returns
      // "NSE:NTPCGREEN" and can rank it first, so taking data[0] resolved NTPC
      // to NTPC GREEN ENERGY. Pick the EXACT id (or exchange+tradingsymbol)
      // match; only fall back to the first result when nothing matches exactly.
      const rows = parsed?.data || [];
      const row = rows.find(r => r.id === cacheKey)
        || rows.find(r => (r.tradingsymbol || '').toUpperCase() === symbol && (r.exchange || '').toUpperCase() === exchange)
        || rows[0];
      if (row) {
        info = {
          symbol,
          exchange,
          name: row.name || null,
          isin: row.isin || null,
          tradingsymbol: row.tradingsymbol || symbol,
          // Needed by the Market Data tables to deep-link cells into the
          // Instrument page (which routes by numeric token, not symbol).
          instrument_token: row.instrument_token || null,
        };
      }
    }
    instrumentInfoCache[cacheKey] = { data: info, ts: now };
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message, symbol });
  }
});

// ─── Search instruments (navbar autocomplete) ────────────────────
// Kite's search_instruments returns F&O options first when filtering on name
// (242 RELIANCE matches, most of them strikes). We over-fetch then filter to
// cash equities (NSE/BSE, instrument_type=EQ) so the navbar dropdown only
// shows stocks. Cached briefly per-query so a typing user doesn't hammer MCP.
const instrumentSearchCache = {}; // queryKey -> { data, ts }
const INSTRUMENT_SEARCH_TTL = 5 * 60 * 1000; // 5 min

app.get('/api/search-instruments', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  const cacheKey = q.toLowerCase();
  const now = Date.now();
  if (instrumentSearchCache[cacheKey] && now - instrumentSearchCache[cacheKey].ts < INSTRUMENT_SEARCH_TTL) {
    return res.json(instrumentSearchCache[cacheKey].data);
  }

  // Heuristic: short uppercase token → search tradingsymbol; otherwise name.
  // Empirically name-search works for both ("RELI" matches "RELIANCE INDUSTRIES"
  // because Kite name-matches are substring-based), so default to name.
  const filterOn = /^[A-Z0-9]{2,15}$/.test(q) ? 'tradingsymbol' : 'name';

  try {
    const result = await callWithTimeout({
      name: "search_instruments",
      arguments: { query: q, filter_on: filterOn, limit: 60 }
    }, 8000);

    let rows = [];
    if (result?.content?.[0]?.text) {
      const parsed = JSON.parse(result.content[0].text);
      rows = parsed?.data || [];
    }

    // Cash equities only — drop F&O, currency, MCX, mutual funds.
    const equities = rows
      .filter(r => (r.exchange === 'NSE' || r.exchange === 'BSE')
                && r.instrument_type === 'EQ'
                && r.active !== false)
      // NSE first (more liquid), then alphabetical
      .sort((a, b) => {
        if (a.exchange !== b.exchange) return a.exchange === 'NSE' ? -1 : 1;
        return a.tradingsymbol.localeCompare(b.tradingsymbol);
      })
      .slice(0, 12)
      .map(r => ({
        symbol: r.tradingsymbol,
        name: r.name,
        exchange: r.exchange,
        token: String(r.instrument_token),
        isin: r.isin || null,
      }));

    const payload = { results: equities };
    instrumentSearchCache[cacheKey] = { data: payload, ts: now };
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/holdings', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const result = await fetchWithCache("get_holdings", "holdings", {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/mf-holdings', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const result = await fetchWithCache("get_mf_holdings", "mfHoldings", {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/margins', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const result = await fetchWithCache("get_margins", "margins", {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/positions', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const result = await mcpClient.callTool({ name: "get_positions", arguments: {} });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/historical/:token', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const { token } = req.params;
    const { tf = '1M' } = req.query;

    // For intraday, always fetch live
    if (tf === '1D') {
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - 5);
      const result = await mcpClient.callTool({
        name: "get_historical_data",
        arguments: {
          instrument_token: parseInt(token, 10),
          from_date: formatDate(fromDate, false),
          to_date: formatDate(toDate, true),
          interval: "5minute",
          continuous: false, oi: false
        }
      });
      if (result.isError) return res.json(result);
      let parsed = parseMcpText(result);
      if (Array.isArray(parsed)) {
        const closes = parsed.map(c => c.close);
        const sma20Func = SMA.calculate({ period: 20, values: closes });
        const sma5Func = SMA.calculate({ period: 5, values: closes });

        const alignedLive = parsed.map((c, i) => ({
          ...c,
          sma20: i >= 19 ? sma20Func[i - 19] : null,
          sma5: i >= 4 ? sma5Func[i - 4] : null
        }));
        return res.json({
          content: [{ type: "text", text: JSON.stringify(alignedLive) }]
        });
      }
      return res.json(result);
    }

    // For 4Y, neither the 3-year historyCache nor a single MCP call (Kite caps
    // ~1yr of daily candles per request) can cover the range. Serve from the
    // chunked 4-calendar-year fetch (cached + coalesced) the backtester and
    // screener already use, then align SMAs the same way as every other tf.
    if (tf === '4Y') {
      const { data } = await getOrFetchFullHistory(token);
      if (!Array.isArray(data) || data.length === 0) {
        return res.json({ content: [{ type: "text", text: "[]" }] });
      }
      const closes = data.map(c => c.close);
      const sma20Func = SMA.calculate({ period: 20, values: closes });
      const sma5Func = SMA.calculate({ period: 5, values: closes });
      const aligned = data.map((c, i) => ({
        ...c,
        sma20: i >= 19 ? sma20Func[i - 19] : null,
        sma5: i >= 4 ? sma5Func[i - 4] : null
      }));
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 1460); // ~4 years
      const filtered = aligned.filter(c => new Date(c.date) >= cutoff);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      return res.json({
        content: [{ type: "text", text: JSON.stringify(filtered.length ? filtered : aligned) }]
      });
    }

    // For daily timeframes, try serving from cache
    const cached = historyCache[token];
    if (cached && cached.length > 0) {
      // Calculate SMAs
      const closes = cached.map(c => c.close);
      const sma20Func = SMA.calculate({ period: 20, values: closes });
      const sma5Func = SMA.calculate({ period: 5, values: closes });

      const alignedCached = cached.map((c, i) => ({
        ...c,
        sma20: i >= 19 ? sma20Func[i - 19] : null,
        sma5: i >= 4 ? sma5Func[i - 4] : null
      }));

      const now = new Date();
      let daysBack = 30;
      if (tf === '1W') daysBack = 7;
      else if (tf === '1M') daysBack = 30;
      else if (tf === '3M') daysBack = 90;
      else if (tf === '6M') daysBack = 180;
      else if (tf === '1Y') daysBack = 365;
      else if (tf === '2Y') daysBack = 730;
      else if (tf === '3Y') daysBack = 1095;
      else if (tf === '5Y') daysBack = 1825;

      const cutoff = new Date();
      cutoff.setDate(now.getDate() - daysBack);

      const oldestDateInCache = new Date(cached[0].date);

      // Only use cache if it actually covers the requested timeframe
      if (oldestDateInCache <= cutoff) {
        const filtered = alignedCached.filter(c => {
          const d = new Date(c.date);
          return d >= cutoff;
        });

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        if (filtered && filtered.length > 0) {
          return res.json({
            content: [{ type: "text", text: JSON.stringify(filtered) }]
          });
        }
      }
    }

    // Cache miss: fetch live
    const toDate = new Date();
    const fromDate = new Date();
    let daysBack = 30;
    if (tf === '1W') daysBack = 10;
    else if (tf === '3M') daysBack = 90;
    else if (tf === '6M') daysBack = 180;
    else if (tf === '1Y') daysBack = 365;
    else if (tf === '2Y') daysBack = 730;
    else if (tf === '3Y') daysBack = 1095;
    else if (tf === '5Y') daysBack = 365 * 5;
    // For cache miss, fetch more data to compute SMAs (add 70 days)
    fromDate.setDate(toDate.getDate() - (daysBack + 70));

    const result = await mcpClient.callTool({
      name: "get_historical_data",
      arguments: {
        instrument_token: parseInt(token, 10),
        from_date: formatDate(fromDate, false),
        to_date: formatDate(toDate, true),
        interval: "day",
        continuous: false, oi: false
      }
    });

    if (result.isError) return res.json(result);

    let parsed = parseMcpText(result);
    if (!Array.isArray(parsed) && parsed && parsed.data && parsed.data.candles) {
      parsed = parsed.data.candles; // fallback
    }

    if (Array.isArray(parsed)) {
      const closes = parsed.map(c => c.close);
      const sma20Func = SMA.calculate({ period: 20, values: closes });
      const sma5Func = SMA.calculate({ period: 5, values: closes });

      const alignedLive = parsed.map((c, i) => ({
        ...c,
        sma20: i >= 19 ? sma20Func[i - 19] : null,
        sma5: i >= 4 ? sma5Func[i - 4] : null
      }));

      const now = new Date();
      let daysBack = 30;
      if (tf === '1W') daysBack = 7;
      else if (tf === '1M') daysBack = 30;
      else if (tf === '3M') daysBack = 90;
      else if (tf === '6M') daysBack = 180;
      else if (tf === '1Y') daysBack = 365;
      else if (tf === '2Y') daysBack = 730;
      else if (tf === '3Y') daysBack = 1095;
      else if (tf === '5Y') daysBack = 1825;

      const cutoff = new Date();
      cutoff.setDate(now.getDate() - daysBack);

      const filteredLive = alignedLive.filter(c => {
        const d = new Date(c.date);
        return d >= cutoff;
      });

      // Only overwrite the global cache if this newly fetched array contains MORE historical data.
      // This prevents short-timeframe fetches (like 1W/1M) from overriding the 2-year data needed
      // for mathematically stable RSI EMA smoothing.
      if (!historyCache[token] || parsed.length > historyCache[token].length) {
        historyCache[token] = parsed;
      }

      // Wrap back in MCP-like response so frontend parsing stays the same
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      return res.json({
        content: [{ type: "text", text: JSON.stringify(filteredLive) }]
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Technical Indicators ──────────────────────────────────────
app.get('/api/indicators/:token', async (req, res) => {
  const { token } = req.params;
  let cached = historyCache[token];

  if (!cached || cached.length === 0) {
    if (indicatorPromises[token]) {
      console.log(`⏳ Waiting for in-progress indicator fetch for ${token}...`);
      cached = await indicatorPromises[token];
    } else {
      console.log(`🔍 Cache miss for indicator ${token}, fetching on-the-fly...`);
      indicatorPromises[token] = (async () => {
        try {
          const toDate = new Date();
          const fromDate = new Date();
          fromDate.setDate(toDate.getDate() - 365); // 1 year for robust indicators
          const data = await fetchHistorical(parseInt(token, 10), fromDate, toDate, 'day');
          if (Array.isArray(data) && data.length > 0) {
            historyCache[token] = data;
            return data;
          }
        } catch (err) {
          console.error(`Failed to fetch on-the-fly history for ${token}:`, err.message);
        } finally {
          delete indicatorPromises[token];
        }
        return null;
      })();
      cached = await indicatorPromises[token];
    }
  }

  if (!cached || cached.length === 0) {
    return res.status(404).json({ error: "No historical data available to compute indicators." });
  }

  const closes = cached.map(c => c.close);
  const highs = cached.map(c => c.high);
  const lows = cached.map(c => c.low);

  try {
    // SMA
    const sma5 = SMA.calculate({ period: 5, values: closes });
    const sma20 = SMA.calculate({ period: 20, values: closes });
    const sma50 = SMA.calculate({ period: 50, values: closes });
    const sma200 = SMA.calculate({ period: 200, values: closes });

    // EMA
    const ema12 = EMA.calculate({ period: 12, values: closes });
    const ema26 = EMA.calculate({ period: 26, values: closes });

    // RSI
    const rsi14 = RSI.calculate({ period: 14, values: closes });

    // MACD
    const macdResult = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });

    // Bollinger Bands
    const bbResult = BollingerBands.calculate({
      period: 20,
      values: closes,
      stdDev: 2
    });

    // Return only the latest values for the summary
    const latest = (arr) => arr.length > 0 ? arr[arr.length - 1] : null;

    res.json({
      currentPrice: closes[closes.length - 1],
      dataPoints: closes.length,
      indicators: {
        sma: {
          sma5: latest(sma5),
          sma20: latest(sma20),
          sma50: latest(sma50),
          sma200: latest(sma200)
        },
        ema: {
          ema12: latest(ema12),
          ema26: latest(ema26)
        },
        rsi: {
          rsi14: latest(rsi14)
        },
        macd: latest(macdResult),
        bollingerBands: latest(bbResult)
      },
      // Full series for chart overlay (last 60 data points)
      series: {
        sma5: sma5.slice(-60),
        sma20: sma20.slice(-60),
        dates: cached.slice(-60).map(c => c.date)
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to compute indicators: " + err.message });
  }
});

// ─── Per-stock alert computation ──────────────────────────────
// Pure function over a candle series. Used by both /api/alerts (holdings) and
// /api/sector-alerts/:sectorId (sector drill-down). Returns the alert object,
// or null if the stock has no actionable signals.
// computeSuperTrend moved to ./backtest/indicators.js so the live alert engine,
// the backtester, and the screener share identical SuperTrend math (same
// iterative sticky-band semantics documented there).
const { computeSuperTrend } = require('./backtest/indicators');

//
// `holding` is the raw Kite holdings row when called from /api/alerts; pass
// undefined for the sector path to skip qty/PnL fields and the holdings-aware
// trade-plan overrides (BUY SEEN→ADD if owned, HOLD OVERBOUGHT→TRIM if +25%).
async function computeStockAlert({ symbol, token, lastPrice, previousClose, candles, holding, sector }) {
  if (!candles || candles.length < 15) return null;

  const currentPrice = lastPrice || candles[candles.length - 1].close;
  const workingCandles = [...candles];

  if (lastPrice) {
    const lastCandle = workingCandles[workingCandles.length - 1];
    const lastDate = new Date(lastCandle.date).toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);
    
    if (lastDate === todayStr) {
      const updatedCandle = { ...lastCandle, close: currentPrice };
      if (currentPrice > updatedCandle.high) updatedCandle.high = currentPrice;
      if (currentPrice < updatedCandle.low) updatedCandle.low = currentPrice;
      workingCandles[workingCandles.length - 1] = updatedCandle;
    } else {
      workingCandles.push({
        date: todayStr + 'T00:00:00+0530',
        open: lastPrice,
        high: lastPrice,
        low: lastPrice,
        close: lastPrice,
        volume: 0
      });
    }
  }

  const closes = workingCandles.map(c => c.close);
  const highs = workingCandles.map(c => c.high);
  const lows = workingCandles.map(c => c.low);

  const sma5Arr = SMA.calculate({ period: 5, values: closes });
  const sma20Arr = SMA.calculate({ period: 20, values: closes });
  const sma50Arr = SMA.calculate({ period: 50, values: closes });
  const sma200Arr = SMA.calculate({ period: 200, values: closes });
  const ema200Arr = EMA.calculate({ period: 200, values: closes });
  const rsi14Arr = RSI.calculate({ period: 14, values: closes });

  const atr14Arr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  // ATR(10) feeds the SuperTrend(10,3) — the existing ATR(14) stays for everything else.
  const atr10Arr = ATR.calculate({ high: highs, low: lows, close: closes, period: 10 });
  // ADX(14) — trend-strength gate for the Supertrend block. Below 25 = sideways
  // (signals suppressed). The library returns { adx, pdi, mdi } per bar; we
  // keep only the latest adx value.
  const adx14Arr = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });

  // SuperTrend(10, 3) — trend filter for long-horizon swing strategy.
  // Path-dependent (sticky bands), can't be vectorised. Returns one entry per
  // candle aligned to the END of the candles array; pre-ATR bars are skipped.
  const supertrendArr = computeSuperTrend(workingCandles, atr10Arr, 10, 3);
  const supertrendLatest = supertrendArr.length > 0 ? supertrendArr[supertrendArr.length - 1] : null;
  const supertrendPrev   = supertrendArr.length > 1 ? supertrendArr[supertrendArr.length - 2] : null;
  const supertrend = supertrendLatest ? {
    line: +supertrendLatest.value.toFixed(2),
    signal: supertrendLatest.direction, // 'BULL' | 'BEAR'
    flippedToBull: !!(supertrendLatest.direction === 'BULL' && supertrendPrev && supertrendPrev.direction === 'BEAR'),
    flippedToBear: !!(supertrendLatest.direction === 'BEAR' && supertrendPrev && supertrendPrev.direction === 'BULL'),
  } : null;
  const ema200 = ema200Arr.length > 0 ? +ema200Arr[ema200Arr.length - 1].toFixed(2) : null;

  // Calculate 20-period Anchored VWAP
  const recent20 = workingCandles.slice(-20);
  let vwap20 = null;
  let vwapDeviation = null;
  if (recent20.length === 20) {
    const vwapArr = VWAP.calculate({
      high: recent20.map(c => c.high),
      low: recent20.map(c => c.low),
      close: recent20.map(c => c.close),
      volume: recent20.map(c => c.volume || 1)
    });
    vwap20 = vwapArr.length > 0 ? vwapArr[vwapArr.length - 1] : null;
    if (vwap20) {
      vwapDeviation = ((currentPrice - vwap20) / vwap20) * 100;
    }
  }

  // Institutional Net Aggressor Proxy via Money Flow Multiplier (MFM)
  let aggressorDelta = 0;
  if (workingCandles.length >= 14) {
    const window = workingCandles.slice(-14);
    let totalMoneyFlowVolume = 0;
    let totalVolume = 0;
    window.forEach(c => {
      const range = c.high - c.low || 0.01;
      const multiplier = ((c.close - c.low) - (c.high - c.close)) / range;
      totalMoneyFlowVolume += (multiplier * (c.volume || 1));
      totalVolume += (c.volume || 1);
    });
    aggressorDelta = totalVolume > 0 ? totalMoneyFlowVolume / totalVolume : 0;
  }

  const sma5 = sma5Arr.length > 0 ? sma5Arr[sma5Arr.length - 1] : null;
  const sma20 = sma20Arr.length > 0 ? sma20Arr[sma20Arr.length - 1] : null;
  const sma50 = sma50Arr.length > 0 ? sma50Arr[sma50Arr.length - 1] : null;
  const sma200 = sma200Arr.length > 0 ? sma200Arr[sma200Arr.length - 1] : null;
  const rsi14 = rsi14Arr.length > 0 ? rsi14Arr[rsi14Arr.length - 1] : null;
  const atr = atr14Arr.length > 0 ? atr14Arr[atr14Arr.length - 1] : null;
  const adx14 = adx14Arr.length > 0 ? adx14Arr[adx14Arr.length - 1].adx : null;
  const rsiHistory = rsi14Arr.slice(-10).map(v => parseFloat(v.toFixed(1)));

  // Regime Classification & Divergence Detection
  let regime = "RANGE-BOUND";
  let trendDirection = "NEUTRAL";
  const isBullishAligned = (sma50 && sma200) && (
    (currentPrice > sma50 && sma50 > sma200) ||
    (currentPrice > sma50 && currentPrice > sma200 && Math.abs(sma50 - sma200) / sma200 < 0.02)
  );
  const isBearishAligned = (sma50 && sma200) && (
    (currentPrice < sma50 && sma50 < sma200) ||
    (currentPrice < sma50 && currentPrice < sma200 && Math.abs(sma50 - sma200) / sma200 < 0.02)
  );
  const isAlignedTrend = isBullishAligned || isBearishAligned;

  const todayBar = workingCandles[workingCandles.length - 1];
  const prevBarClose = workingCandles[workingCandles.length - 2]?.close ?? null;
  const todayTR = todayBar
    ? Math.max(
        (todayBar.high ?? 0) - (todayBar.low ?? 0),
        prevBarClose ? Math.abs((todayBar.high ?? 0) - prevBarClose) : 0,
        prevBarClose ? Math.abs((todayBar.low ?? 0) - prevBarClose) : 0
      )
    : 0;
  const todayRangePct = (todayBar?.close && todayTR) ? (todayTR / todayBar.close) : 0;

  if (atr14Arr.length > 20) {
    const atrSMA20 = atr14Arr.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const todayShockVsAtr = atr > 0 ? (todayTR / atr) : 0;
    if (atr > 1.5 * atrSMA20 || todayShockVsAtr > 2 || todayRangePct > 0.04) {
      regime = "WILD SWINGS";
    } else if (isAlignedTrend) {
      regime = "STRONG TREND";
    }
  } else if (isAlignedTrend) {
    regime = "STRONG TREND";
  }
  if (regime === "STRONG TREND") {
    trendDirection = isBullishAligned ? "BULL" : "BEAR";
  }

  let divergence = null;
  if (closes.length >= 20 && rsi14Arr.length >= 20) {
    const priceWindow = closes.slice(-20);
    const rsiWindow = rsi14Arr.slice(-20);
    const p1 = priceWindow[0], p2 = priceWindow[19];
    const r1 = rsiWindow[0], r2 = rsiWindow[19];
    if (p2 < p1 && r2 > r1 && r2 < 45) divergence = "BUY SETUP";
    if (p2 > p1 && r2 < r1 && r2 > 55) divergence = "SELL SETUP";
  }

  // Confidence score (0-100) — starts at 30 for wider dynamic range
  let confidence = 30;
  const confBreakdown = [{ label: 'Base', value: 30 }];
  const addConf = (label, value) => { confidence += value; confBreakdown.push({ label, value }); };
  if (rsi14 !== null) {
    if (rsi14 > 40 && rsi14 < 70) addConf('RSI in healthy zone', 10);
    if (rsi14 <= 30) addConf('RSI oversold (rebound setup)', 15);
  }
  if (sma5 && sma20 && sma5 > sma20) addConf('SMA5 > SMA20 (short-term momentum)', 15);
  if (sma50 && sma200 && sma50 > sma200) addConf('SMA50 > SMA200 (golden state)', 10);
  if (vwapDeviation !== null && vwapDeviation > 0) addConf('Price above 20d VWAP', 10);
  if (aggressorDelta > 0.3) addConf('Strong accumulation (money flow)', 10);
  if (regime === 'STRONG TREND') {
    if (trendDirection === 'BULL') addConf('Strong bullish trend', 5);
    else if (trendDirection === 'BEAR') addConf('Strong bearish trend', -5);
  }
  if (sma50 && sma200 && currentPrice > sma50 && currentPrice > sma200) addConf('Price leads both MAs', 10);
  if (rsi14 !== null && rsi14 >= 75) addConf('RSI severely overbought', -10);
  if (sma50 && sma200 && sma50 < sma200) {
    if (currentPrice > sma50 && currentPrice > sma200) addConf('Death cross (softened: price leads)', -5);
    else addConf('Death cross', -10);
  }
  if (sma5 && sma20 && sma5 < sma20) addConf('SMA5 < SMA20 (short-term bearish)', -5);
  if (vwapDeviation !== null && vwapDeviation < -2) addConf('Deep below 20d VWAP', -10);
  if (aggressorDelta < -0.2) addConf('Distribution (money flow)', -10);
  if (regime === 'WILD SWINGS') addConf('Volatile regime', -10);
  // SuperTrend BULL acts as a confidence floor — a stock in a confirmed
  // uptrend deserves at least 70% bias regardless of weaker secondary signals.
  if (supertrend?.signal === 'BULL' && confidence < 70) {
    addConf('SuperTrend(10,3) uptrend (floor)', 70 - confidence);
  }
  confidence = Math.min(100, Math.max(0, Math.round(confidence)));

  const stockAlerts = [];

  if (rsi14 !== null) {
    if (rsi14 <= 30) {
      stockAlerts.push({ type: 'rsi', severity: 'bullish', message: `RSI is ${rsi14.toFixed(1)} — Stock is oversold/undervalued. Potential buying opportunity.` });
    } else if (rsi14 >= 70) {
      stockAlerts.push({ type: 'rsi', severity: 'bearish', message: `RSI is ${rsi14.toFixed(1)} — Stock is overbought/overvalued. Consider booking profits.` });
    } else if (rsi14 <= 40) {
      stockAlerts.push({ type: 'rsi', severity: 'warning', message: `RSI is ${rsi14.toFixed(1)} — Approaching oversold zone. Watch for reversal.` });
    } else if (rsi14 >= 60) {
      stockAlerts.push({ type: 'rsi', severity: 'info', message: `RSI is ${rsi14.toFixed(1)} — Strong bullish momentum zone.` });
    }
  }

  if (sma5 !== null && sma20 !== null) {
    if (currentPrice > sma5 && currentPrice > sma20) {
      stockAlerts.push({ type: 'sma_short', severity: 'bullish', message: `Trading above SMA 5 (₹${sma5.toFixed(1)}) and SMA 20 (₹${sma20.toFixed(1)}) — Short-term momentum is bullish.` });
    } else if (currentPrice < sma5 && currentPrice < sma20) {
      stockAlerts.push({ type: 'sma_short', severity: 'bearish', message: `Trading below SMA 5 (₹${sma5.toFixed(1)}) and SMA 20 (₹${sma20.toFixed(1)}) — Short-term momentum is bearish.` });
    } else if (currentPrice > sma5 && currentPrice < sma20) {
      stockAlerts.push({ type: 'sma_short', severity: 'warning', message: `Trading above SMA 5 but below SMA 20 — Short-term recovery attempt; trend not yet confirmed.` });
    }
  }

  if (sma50 !== null && sma200 !== null) {
    if (currentPrice > sma50 && currentPrice > sma200) {
      stockAlerts.push({ type: 'sma_long', severity: 'bullish', message: `Trading above SMA 50 (₹${sma50.toFixed(1)}) and SMA 200 (₹${sma200.toFixed(1)}) — Long-term trend is strongly bullish.` });
    } else if (currentPrice < sma50 && currentPrice < sma200) {
      stockAlerts.push({ type: 'sma_long', severity: 'bearish', message: `Trading below SMA 50 (₹${sma50.toFixed(1)}) and SMA 200 (₹${sma200.toFixed(1)}) — Long-term trend is bearish. Caution.` });
    } else if (currentPrice > sma50 && currentPrice < sma200) {
      stockAlerts.push({ type: 'sma_long', severity: 'warning', message: `Trading above SMA 50 but below SMA 200 — Mid-term recovery, but long-term trend still bearish.` });
    }
    if (sma50Arr.length >= 6 && sma200Arr.length >= 6) {
      const prevSma50 = sma50Arr[sma50Arr.length - 6];
      const prevSma200 = sma200Arr[sma200Arr.length - 6];
      const wasSma50Above = prevSma50 > prevSma200;
      const isSma50Above = sma50 > sma200;

      const recentFive50 = sma50Arr.slice(-3);
      const recentFive200 = sma200Arr.slice(-3);
      const stable = recentFive50.every((v, i) => (v > recentFive200[i]) === isSma50Above);
      const gapPct = Math.abs(sma50 - sma200) / sma200;
      const confirmed = stable && gapPct >= 0.0025;

      if (isSma50Above && !wasSma50Above && confirmed) {
        stockAlerts.push({ type: 'cross', severity: 'bullish', message: `Golden Cross confirmed — SMA 50 (₹${sma50.toFixed(1)}) crossed above SMA 200 (₹${sma200.toFixed(1)}).` });
      } else if (!isSma50Above && wasSma50Above && confirmed) {
        stockAlerts.push({ type: 'cross', severity: 'bearish', message: `Death Cross confirmed — SMA 50 (₹${sma50.toFixed(1)}) crossed below SMA 200 (₹${sma200.toFixed(1)}).` });
      }
    }
  }

  // Multi-window breakout scan — largest to smallest — across the full 3-year cache.
  // Today's bar is excluded from every window so price can't self-confirm.
  const BREAKOUT_WINDOWS = [
    { key: '3y',  label: '3-year',  days: 756 },
    { key: '2y',  label: '2-year',  days: 504 },
    { key: '1y',  label: '1-year',  days: 252 },
    { key: '6m',  label: '6-month', days: 126 },
    { key: '3m',  label: '3-month', days: 63  },
    { key: '1m',  label: '1-month', days: 20  },
  ];

  const windowLevels = BREAKOUT_WINDOWS.map(({ key, label, days }) => {
    const slice = workingCandles.length > days
      ? workingCandles.slice(-(days + 1), -1)
      : workingCandles.slice(0, -1);
    const wHighs = slice.map(c => c.high).filter(v => v != null);
    const wLows  = slice.map(c => c.low).filter(v => v != null);
    const high = wHighs.length > 0 ? Math.max(...wHighs) : null;
    const low  = wLows.length  > 0 ? Math.min(...wLows)  : null;
    const isBreakingOut = !!(high && currentPrice >= high);
    const distancePct = high ? ((high - currentPrice) / high) * 100 : null;
    return { key, label, days, high, low, isBreakingOut, distancePct };
  });

  // Most significant active breakout (longest window where price cleared the ceiling).
  const activeBreakout = windowLevels.find(w => w.isBreakingOut) ?? null;
  const activeBreakoutIdx = activeBreakout ? windowLevels.indexOf(activeBreakout) : -1;
  // Next resistance = next larger window still overhead.
  const nextResWindow = activeBreakoutIdx > 0 ? windowLevels[activeBreakoutIdx - 1] : null;
  // Nearest window price is approaching but hasn't broken (within 3%).
  const approachingWindow = !activeBreakout
    ? windowLevels.find(w => w.distancePct !== null && w.distancePct > 0 && w.distancePct <= 3)
    : null;

  if (activeBreakout) {
    const nextNote = nextResWindow
      ? ` Next resistance: ${nextResWindow.label} high at ₹${nextResWindow.high.toFixed(1)} (${Math.abs(nextResWindow.distancePct).toFixed(1)}% away).`
      : '';
    stockAlerts.push({ type: 'breakout', severity: 'bullish', message: `${activeBreakout.label} high breakout at ₹${activeBreakout.high.toFixed(1)}.${nextNote}` });
  } else if (approachingWindow) {
    stockAlerts.push({ type: 'breakout_approaching', severity: 'info', message: `Within ${approachingWindow.distancePct.toFixed(1)}% of the ${approachingWindow.label} high (₹${approachingWindow.high.toFixed(1)}).` });
  }

  if (stockAlerts.length === 0) return null;

  // 20-day Donchian channels from the PRIOR 20 bars (excluding today) so an
  // intraday/EOD bar pressing against the ceiling isn't self-confirming.
  const prior20 = workingCandles.length > 20 ? workingCandles.slice(-21, -1) : workingCandles.slice(0, -1);
  const priorHighs = prior20.map(c => c.high).filter(v => v != null);
  const priorLows = prior20.map(c => c.low).filter(v => v != null);
  const priorVols = prior20.map(c => c.volume).filter(v => v != null && v > 0);
  const supportLvl = priorLows.length > 0 ? Math.min(...priorLows) : (atr ? currentPrice - 1.5 * atr : null);
  const resistanceLvl = priorHighs.length > 0 ? Math.max(...priorHighs) : (atr ? currentPrice + 1.5 * atr : null);

  const avgVol20 = priorVols.length > 0 ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length : 0;
  const todayVol = workingCandles[workingCandles.length - 1]?.volume || 0;
  const volSurge = avgVol20 > 0 ? todayVol / avgVol20 : 0;
  const volumeConfirmed = volSurge >= 1.5;

  const prevCloseBar = prevBarClose ?? todayBar?.open ?? null;
  const barDir = (prevCloseBar != null && currentPrice != null)
    ? (currentPrice > prevCloseBar ? 'up' : currentPrice < prevCloseBar ? 'down' : 'flat')
    : 'flat';
  const volumeConfirmedSide = volumeConfirmed ? barDir : null;
  const dayChangePct = (previousClose && currentPrice)
    ? +(((currentPrice - previousClose) / previousClose) * 100).toFixed(2)
    : (prevCloseBar && currentPrice)
      ? +(((currentPrice - prevCloseBar) / prevCloseBar) * 100).toFixed(2)
      : null;

  const isBreakout = !!(activeBreakout);
  const distanceToRes = (resistanceLvl && currentPrice) ? (resistanceLvl - currentPrice) / currentPrice : 0;

  const candidateSL = supportLvl ? +(supportLvl - (atr ? atr * 0.3 : 0)).toFixed(1) : null;
  const candidateTgtBreakout = resistanceLvl
    ? (currentPrice >= resistanceLvl
        ? +(currentPrice + (atr ? atr * 1.5 : 0)).toFixed(1)
        : +(resistanceLvl).toFixed(1))
    : null;
  const candidateTgtBuy = resistanceLvl ? +(resistanceLvl).toFixed(1) : null;
  const rrFor = (tgt, sl) => (tgt !== null && sl !== null && currentPrice > sl)
    ? +((tgt - currentPrice) / (currentPrice - sl)).toFixed(2)
    : null;

  const tradePlan = { action: 'HOLD / WAIT', sl: null, tgt: null, reason: 'Market structure currently yields no asymmetric edge.' };

  const breakoutLabel = activeBreakout
    ? `${activeBreakout.label} high (₹${activeBreakout.high.toFixed(1)})`
    : `20-day high (₹${resistanceLvl?.toFixed(1) ?? '—'})`;

  const nextResistanceNote = nextResWindow
    ? ` Next major resistance: ${nextResWindow.label} high at ₹${nextResWindow.high.toFixed(1)} (${Math.abs(nextResWindow.distancePct).toFixed(1)}% away).`
    : '';

  if (isBreakout && confidence >= 75 && volumeConfirmed) {
    tradePlan.action = 'BUY SEEN';
    tradePlan.reason = `Price broke above the ${breakoutLabel} on ${volSurge.toFixed(1)}× avg volume. Breakout confirmed.${nextResistanceNote}`;
  } else if (isBreakout && confidence >= 75 && !volumeConfirmed) {
    tradePlan.action = 'BREAKOUT (CAUTION)';
    tradePlan.reason = `Price crossed the ${breakoutLabel} with strong score ${confidence}%, but volume is only ${volSurge.toFixed(1)}× avg (<1.5×). Wait for volume confirmation.${nextResistanceNote}`;
  } else if (isBreakout && confidence >= 50 && volumeConfirmed) {
    tradePlan.action = 'BREAKOUT (CAUTION)';
    tradePlan.reason = `Price crossed the ${breakoutLabel} on ${volSurge.toFixed(1)}× volume, but conviction is moderate at ${confidence}%. Watch for follow-through.${nextResistanceNote}`;
  } else if (isBreakout && confidence >= 50) {
    tradePlan.action = 'BREAKOUT (WEAK)';
    tradePlan.reason = `Breakout above ${breakoutLabel} lacks both strong score (${confidence}%) and volume (${volSurge.toFixed(1)}×). High risk of a false breakout.${nextResistanceNote}`;
  } else if (isBreakout) {
    tradePlan.action = 'BREAKOUT (WEAK)';
    tradePlan.reason = `Price breached ${breakoutLabel} but underlying technicals are weak (score ${confidence}%). Likely bull trap.${nextResistanceNote}`;
  } else if (confidence >= 80 && distanceToRes > 0.02) {
    tradePlan.action = 'BUY SEEN';
    tradePlan.reason = `Momentum is high with ${(distanceToRes * 100).toFixed(1)}% room to run before the 20-day resistance ceiling.`;
  } else if (confidence >= 85 && regime !== 'RANGE-BOUND') {
    tradePlan.action = 'BUY SEEN';
    tradePlan.reason = 'Extreme conviction score in a trending regime. Strong breakout candidate.';
  }

  if (rsi14 !== null && rsi14 >= 70 && (tradePlan.action === 'BUY SEEN' || tradePlan.action === 'BREAKOUT (CAUTION)')) {
    tradePlan.action = 'HOLD (OVERBOUGHT)';
    tradePlan.reason = `Momentum is green, but RSI is stretched to ${rsi14.toFixed(0)} — buying now carries immediate pullback risk.`;
  }

  if (!isBreakout && (confidence <= 45 || regime === 'WILD SWINGS')) {
    tradePlan.action = 'AVOID';
    tradePlan.reason = regime === 'WILD SWINGS' ? 'Erratic price action (ATR expanded). High execution risk.' : 'Systemic technical levels are severely broken down.';
  }

  if (!isBreakout && regime === "RANGE-BOUND" && resistanceLvl && currentPrice >= resistanceLvl * 0.98 && confidence < 75) {
    tradePlan.action = 'SELL (AT RANGE)';
    tradePlan.reason = 'Price is compressing against a strict technical ceiling inside a sideways range.';
  }

  tradePlan.sl = candidateSL;
  tradePlan.tgt = (tradePlan.action === 'BUY SEEN' || tradePlan.action === 'ADD' || tradePlan.action.includes('BREAKOUT'))
    ? candidateTgtBreakout
    : candidateTgtBuy;

  tradePlan.rrRatio = rrFor(tradePlan.tgt, tradePlan.sl);
  if (tradePlan.action === 'BUY SEEN' && tradePlan.rrRatio !== null && tradePlan.rrRatio < 1.5) {
    tradePlan.action = 'HOLD / WAIT';
    tradePlan.reason = `Setup is bullish but reward/risk is only ${tradePlan.rrRatio}× (needs ≥1.5×). TG ₹${tradePlan.tgt} vs SL ₹${tradePlan.sl} — not enough upside.`;
  }

  // Belt-and-braces: a stretched RSI on a high-conviction name still deserves
  // the OVERBOUGHT label even when an earlier check downgraded us to HOLD/WAIT
  // (e.g. price jammed against 20-day resistance so R:R failed). Without this,
  // two stocks with identical RSI ~70 but different distance-to-resistance get
  // mismatched labels — HINDZINC vs IDEAFORGE was exactly this case.
  if (rsi14 !== null && rsi14 >= 70 && confidence >= 75 && tradePlan.action === 'HOLD / WAIT') {
    tradePlan.action = 'HOLD (OVERBOUGHT)';
    tradePlan.reason = `Bullish bias is ${confidence}%, but RSI is stretched to ${rsi14.toFixed(0)} — avoid fresh buys here.`;
  }

  // Holdings-aware overrides — only when called from /api/alerts (holding present).
  if (holding) {
    const isOwned = (holding.quantity ?? 0) > 0;
    const positionPnlPct = (holding.average_price > 0 && holding.last_price)
      ? ((holding.last_price - holding.average_price) / holding.average_price) * 100
      : 0;
    if (isOwned && tradePlan.action === 'BUY SEEN') {
      tradePlan.action = 'ADD';
      tradePlan.reason = `You own ${holding.quantity} @ ₹${holding.average_price.toFixed(1)}. ${tradePlan.reason}`;
    }
    if (isOwned && tradePlan.action === 'HOLD (OVERBOUGHT)' && positionPnlPct >= 25) {
      tradePlan.action = 'TRIM';
      tradePlan.reason = `Up ${positionPnlPct.toFixed(0)}% on this position and RSI is stretched to ${rsi14 !== null ? rsi14.toFixed(0) : 'high'}. Consider booking partial profits.`;
    }
  }

  // ── Supertrend + ADX + RSI(60-70) + volume + confidence (long-swing) ──
  // The entry must clear five independent filters: ADX(14) ≥ 25 (trend strong
  // enough that ST signals don't whipsaw), price above the 200 EMA, RSI in
  // the 60-70 momentum band (Constance Brown's "trending-market RSI"),
  // volume ≥ 1.2× 20-day average (rules out light-volume false flips), and
  // the broader confidence engine independently ≥ 70. Below ADX 25 the
  // entire block returns CHOPPY — no Supertrend signal in sideways tape.
  if (supertrend) {
    const trendStrong = adx14 != null && adx14 >= 25;
    const adxStr = adx14 != null ? adx14.toFixed(1) : '—';

    if (!trendStrong) {
      tradePlan.action = 'CHOPPY';
      tradePlan.reason = `ADX(14) ${adxStr} is below 25 — trend strength too weak for Supertrend signals to be reliable. Wait for ADX to climb above 25 before acting on this name.`;
    } else if (supertrend.signal === 'BEAR') {
      tradePlan.action = 'BEARISH';
      tradePlan.reason = supertrend.flippedToBear
        ? `SuperTrend(10,3) just flipped red on ADX ${adxStr} — exit / avoid new entries.`
        : `SuperTrend(10,3) red (line ₹${supertrend.line}) · ADX ${adxStr} confirms downtrend — stay out / exit existing.`;
    } else if (
      supertrend.signal === 'BULL' &&
      ema200 != null && currentPrice > ema200 &&
      rsi14 != null && rsi14 >= 60 && rsi14 <= 70 &&
      volSurge >= 1.2 &&
      confidence >= 70
    ) {
      if (divergence === 'SELL SETUP') {
        tradePlan.action = 'STRONG BUY (DIV WARN)';
        tradePlan.reason = `Trend setup clean (ADX ${adxStr} · ST green · RSI ${rsi14.toFixed(0)} · vol ${volSurge.toFixed(1)}× · conviction ${confidence}%) but RSI is diverging bearishly from price — momentum may be fading. Tighter stops or wait for divergence to resolve.`;
      } else {
        tradePlan.action = 'STRONG BUY';
        tradePlan.reason = `ADX ${adxStr} confirms trending tape · Price ₹${currentPrice.toFixed(1)} > 200 EMA ₹${ema200} · SuperTrend green (line ₹${supertrend.line}) · RSI ${rsi14.toFixed(0)} in momentum band · vol ${volSurge.toFixed(1)}× · conviction ${confidence}%.`;
      }
    } else if (
      supertrend.signal === 'BULL' &&
      ema200 != null && currentPrice > ema200 &&
      rsi14 != null && rsi14 >= 60 && rsi14 <= 70
    ) {
      // Core rule (ADX + ST + RSI band) passes but volume or confidence fails.
      const failing = [];
      if (volSurge < 1.2) failing.push(`vol only ${volSurge.toFixed(1)}× (need ≥ 1.2)`);
      if (confidence < 70) failing.push(`conviction only ${confidence}% (need ≥ 70)`);
      tradePlan.action = 'STRONG BUY (UNCONFIRMED)';
      tradePlan.reason = `Core rule passes (ADX ${adxStr} · ST green · RSI ${rsi14.toFixed(0)}) but ${failing.join(' · ')}. Wait for confirmation or take a smaller position.`;
    } else if (supertrend.signal === 'BULL' && rsi14 != null && rsi14 > 70) {
      tradePlan.action = 'TRENDING (WAIT)';
      tradePlan.reason = `Uptrend intact (ADX ${adxStr} · ST green @ ₹${supertrend.line}) but RSI ${rsi14.toFixed(0)} is overbought — wait for cooldown.`;
    } else if (supertrend.signal === 'BULL' && rsi14 != null && rsi14 < 60) {
      tradePlan.action = 'TRENDING (WAIT)';
      tradePlan.reason = `SuperTrend green on ADX ${adxStr}, but RSI ${rsi14.toFixed(0)} below 60 — momentum hasn't confirmed yet. Wait for RSI to push above 60.`;
    }
  }

  // ── Dynamic SL — use SuperTrend line whenever the trend is up ──
  // The classic trailing-stop discipline for the SuperTrend strategy. Stops
  // tighten as the trend matures and we never sell into noise.
  if (supertrend?.signal === 'BULL' && supertrend.line) {
    tradePlan.sl = supertrend.line;
    // Recompute R:R against the new (usually tighter) stop.
    tradePlan.rrRatio = rrFor(tradePlan.tgt, tradePlan.sl);
  }

  const resolvedSector = sector !== undefined ? sector : await getSectorCached(symbol);

  const out = {
    symbol,
    token,
    price: currentPrice,
    rsi: rsi14 ? +rsi14.toFixed(2) : null,
    sma5: sma5 ? +sma5.toFixed(2) : null,
    sma20: sma20 ? +sma20.toFixed(2) : null,
    sma50: sma50 ? +sma50.toFixed(2) : null,
    sma200: sma200 ? +sma200.toFixed(2) : null,
    ema200,
    adx: adx14 != null ? +adx14.toFixed(2) : null,
    supertrend, // { line, signal, flippedToBull, flippedToBear } | null
    vwap20: vwap20 ? +vwap20.toFixed(2) : null,
    vwapDeviation: vwapDeviation !== null ? +vwapDeviation.toFixed(2) : null,
    atr: atr ? +atr.toFixed(2) : null,
    support: supportLvl ? +supportLvl.toFixed(2) : null,
    resistance: resistanceLvl ? +resistanceLvl.toFixed(2) : null,
    aggressorDelta: +(aggressorDelta).toFixed(3),
    volSurge: +volSurge.toFixed(2),
    volumeConfirmed,
    volumeDirection: barDir,
    volumeConfirmedSide,
    dayChangePct,
    prevClose: prevCloseBar ? +prevCloseBar.toFixed(2) : null,
    divergence,
    regime,
    trendDirection,
    windowLevels: windowLevels.map(w => ({
      key: w.key,
      label: w.label,
      high: w.high ? +w.high.toFixed(2) : null,
      low: w.low ? +w.low.toFixed(2) : null,
      isBreakingOut: w.isBreakingOut,
      distancePct: w.distancePct !== null ? +w.distancePct.toFixed(2) : null
    })),
    activeBreakoutWindow: activeBreakout
      ? { key: activeBreakout.key, label: activeBreakout.label, high: +activeBreakout.high.toFixed(2) }
      : null,
    isBreakout,
    tradePlan,
    rsiHistory,
    confidence,
    confBreakdown,
    alerts: stockAlerts,
    sector: resolvedSector,
  };

  if (holding) {
    out.quantity = holding.quantity ?? 0;
    out.avgPrice = holding.average_price ?? 0;
    out.pnl = holding.pnl ?? 0;
    out.pnlPct = (holding.average_price > 0 && (holding.quantity ?? 0) > 0)
      ? +(((holding.last_price - holding.average_price) / holding.average_price) * 100).toFixed(2)
      : null;
    out.dayChangeRupee = +(((holding.day_change ?? 0) * (holding.quantity ?? 0))).toFixed(2);
  }

  return out;
}

// ─── Portfolio Alerts ──────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });

  try {
    // Get holdings list
    const holdingsResult = await fetchWithCache("get_holdings", "holdings", {});
    let holdings = [];
    if (holdingsResult?.content?.[0]?.text) {
      const parsed = JSON.parse(holdingsResult.content[0].text);
      holdings = parsed.data || parsed;
    }

    // Trigger cache warmup safely if needed
    if (!cacheReady && !holdingsResult.isError) {
      console.log("⏳ Alerts API: Triggering cache warm-up...");
      warmCache();
    }

    if (!Array.isArray(holdings) || holdings.length === 0) {
      return res.json([]);
    }

    const alerts = [];

    for (const h of holdings) {
      const token = h.instrument_token;
      const symbol = h.tradingsymbol;
      const lastPrice = h.last_price;

      // Best-effort refresh of today's daily candle so volSurge / dayChange
      // reflect live intraday state rather than yesterday's EOD bar.
      await refreshTodayCandle(token);

      const candles = historyCache[token];
      const alert = await computeStockAlert({ symbol, token, lastPrice, previousClose: h.close_price, candles, holding: h });
      if (alert) alerts.push(alert);
    }

    const totalInvested = alerts.reduce((s, a) => s + ((a.avgPrice || 0) * (a.quantity || 0)), 0);
    const totalPnl      = alerts.reduce((s, a) => s + (a.pnl || 0), 0);
    // todayPnlRupee and totalHoldings must cover ALL holdings, not just alerted ones.
    // computeStockAlert returns null for stocks with no signals, so using alerts.length
    // or summing over alerts silently drops those holdings.
    const todayPnlRupee = +holdings.reduce((s, h) => s + ((h.day_change ?? 0) * (h.quantity ?? 0)), 0).toFixed(2);
    const summary = {
      todayPnlRupee,
      totalPnlRupee: +totalPnl.toFixed(2),
      totalPnlPct:   totalInvested > 0 ? +((totalPnl / totalInvested) * 100).toFixed(2) : null,
      totalInvested: +totalInvested.toFixed(2),
      totalHoldings: holdings.length,
      flagCounts: {
        avoid: alerts.filter(a => a.tradePlan?.action === 'AVOID').length,
        trim:  alerts.filter(a => a.tradePlan?.action === 'TRIM').length,
        add:   alerts.filter(a => a.tradePlan?.action === 'ADD').length,
      },
      sectorConcentration: computeSectorConcentration(alerts),
    };
    res.json({ alerts, summary });
  } catch (err) {
    console.error("Alerts computation error:", err);
    res.status(500).json({ error: "Failed to compute alerts: " + err.message });
  }
});

// Single-instrument technical alert. Used by the Instrument page's
// "Technical Alerts" tab — same computeStockAlert pipeline as /api/alerts but
// scoped to one token, with no `holding` context (so the trade-plan tweaks
// like "ADD if owned" / "TRIM if +25%" don't fire). The live quote drives
// lastPrice + previousClose so day-change / volSurge match the rest of the
// page.
app.get('/api/instrument-alert/:token', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  const { token } = req.params;
  const symbol = (req.query.symbol || '').toString().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    // Use the full multi-year history (same depth the Portfolio Alerts page
    // warms) instead of the 1-year indicator cache, so the breakout-window scan
    // spans the real 1Y/2Y/3Y ranges. With only ~1yr of bars the 2Y/3Y windows
    // collapsed onto a single year, mislabeling a 1-year high as a "3Y breakout".
    let candles;
    try {
      const full = await getOrFetchFullHistory(token);
      candles = full?.data;
    } catch (e) {
      console.warn(`[instrument-alert] full history fetch failed for ${symbol}: ${e.message}`);
    }
    if (!candles || candles.length < 15) {
      return res.status(404).json({ error: "Insufficient historical data to compute alerts" });
    }

    // Refresh today's bar on the full-history cache so VWAP / day-change /
    // volSurge reflect live state.
    await refreshTodayCandle_FullHistory(token);
    candles = historicalFullCache[token]?.data || candles;

    // Fetch live quote so we have lastPrice + previousClose without trusting
    // stale cached values.
    let lastPrice = null;
    let previousClose = null;
    try {
      const key = `NSE:${symbol}`;
      const qr = await callWithTimeout({ name: 'get_quotes', arguments: { instruments: [key] } });
      if (qr?.content?.[0]?.text) {
        const parsed = JSON.parse(qr.content[0].text);
        const q = parsed[key];
        if (q) {
          lastPrice = q.last_price ?? null;
          previousClose = q.ohlc?.close ?? null;
        }
      }
    } catch (e) {
      console.warn(`[instrument-alert] quote fetch failed for ${symbol}: ${e.message}`);
    }

    const alert = await computeStockAlert({ symbol, token, lastPrice, previousClose, candles });
    if (!alert) {
      return res.json({ alert: null, reason: 'No actionable signals on the latest bar.' });
    }
    res.json({ alert });
  } catch (err) {
    console.error(`[instrument-alert] ${symbol}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fundamentals/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    if (!symbol) return res.status(400).json({ error: "Symbol required" });

    const yahooSymbol = toYahooSymbol(symbol);

    // Fetch fundamental data from Yahoo Finance
    const quoteSummary = await yahooFinance.quoteSummary(yahooSymbol, {
      modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'price', 'assetProfile']
    });

    res.json(quoteSummary);
  } catch (err) {
    console.error("Yahoo Finance error:", err);
    res.status(500).json({ error: "Failed to fetch fundamental data: " + err.message });
  }
});

app.get('/api/cashflow/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    if (!symbol) return res.status(400).json({ error: "Symbol required" });

    const yahooSymbol = toYahooSymbol(symbol);

    const d = new Date();
    d.setFullYear(d.getFullYear() - 4); // Get last 4 years approx

    const type = req.query.type === 'annual' ? 'annual' : 'quarterly';

    const ts = await yahooFinance.fundamentalsTimeSeries(yahooSymbol, {
      period1: d.toISOString().split('T')[0],
      module: 'all',
      type: type
    });

    const cashflowData = ts.map(item => ({
      date: item.date,
      operatingCashFlow: item.operatingCashFlow || 0,
      investingCashFlow: item.investingCashFlow || 0,
      financingCashFlow: item.financingCashFlow || 0,
      freeCashFlow: item.freeCashFlow || 0,
      netIncome: item.netIncome || 0,
      totalRevenue: item.totalRevenue || 0,
      // Added for the Quarterly Results tab on the Instrument page. Yahoo's
      // fundamentalsTimeSeries (module:'all', type:'quarterly') exposes
      // operatingIncome and dilutedEPS directly — verified against
      // RELIANCE.NS response shape.
      operatingIncome: item.operatingIncome || 0,
      dilutedEPS: item.dilutedEPS ?? null
    })).filter(item =>
      item.operatingCashFlow !== 0 ||
      item.investingCashFlow !== 0 ||
      item.financingCashFlow !== 0 ||
      item.netIncome !== 0 ||
      item.totalRevenue !== 0
    );

    res.json(cashflowData);
  } catch (err) {
    console.error("Yahoo Finance cashflow error:", err);
    res.status(500).json({ error: "Failed to fetch cashflow data: " + err.message });
  }
});

// ─── GET /api/analysts/:symbol — Wall Street analyst coverage (Yahoo, ₹) ─────
// Indian counterpart of /api/us/analysts: same shape, NSE symbol resolved via
// toYahooSymbol(). Coverage is good for liquid large/mid-caps and absent for
// small-caps / recently-renamed tickers (handled by a graceful empty state).
const analystCacheIN = {}; // sym -> { data, ts }
const ANALYST_TTL_IN = 60 * 60 * 1000; // 1h
app.get('/api/analysts/:symbol', async (req, res) => {
  const sym = req.params.symbol;
  const hit = analystCacheIN[sym];
  if (hit && Date.now() - hit.ts < ANALYST_TTL_IN) return res.json({ ...hit.data, cached: true });
  try {
    const yahooSym = toYahooSymbol(sym);
    const modules = ['price', 'financialData', 'recommendationTrend', 'upgradeDowngradeHistory', 'earningsTrend'];
    let q;
    try { q = await yahooFinance.quoteSummary(yahooSym, { modules }, { validateResult: false }); }
    catch { q = await yahooFinance.quoteSummary(yahooSym, { modules: ['price', 'financialData', 'recommendationTrend'] }, { validateResult: false }); }
    const price = q.price || {}, fd = q.financialData || {};
    const rt = q.recommendationTrend || {}, ud = q.upgradeDowngradeHistory || {}, et = q.earningsTrend || {};

    const trend = (rt.trend || []).map(t => ({
      period: t.period,
      strongBuy: t.strongBuy ?? 0, buy: t.buy ?? 0, hold: t.hold ?? 0,
      sell: t.sell ?? 0, strongSell: t.strongSell ?? 0,
      total: (t.strongBuy ?? 0) + (t.buy ?? 0) + (t.hold ?? 0) + (t.sell ?? 0) + (t.strongSell ?? 0),
    })).filter(t => t.total > 0);

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
      name: price.longName || price.shortName || sym,
      currency: price.currency || 'INR',
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
    analystCacheIN[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Screener.in scrape for canonical quarterly results ──────────
// Yahoo's fundamentalsTimeSeries has sparse Indian coverage (random missing
// quarters, e.g. HINDZINC Sep 2025). Screener.in renders the same data
// server-side as plain HTML, so a single GET + cheerio gives us up to 13
// consecutive quarters with no gaps. Cached aggressively because quarterly
// data only changes 4 times a year — also keeps us off screener's radar.
const SCREENER_TTL = 12 * 60 * 60 * 1000; // 12h
const screenerCache = {}; // symbol -> { data, ts } — keeps the parsed quarterly payload
const screenerHtmlCache = {}; // symbol -> { html, ts } — raw HTML shared across endpoints
const screenerHtmlInflight = {}; // symbol -> Promise so concurrent requests dedupe

// ─── Screener-slug aliases for Kite ↔ screener.in mismatches ─────
// A handful of NSE tickers carry an "&" in their symbol on the exchange but
// Kite normalises them by stripping the suffix (e.g. NSE: GVT&D → Kite: GVT).
// Screener.in keeps the full ampersand form, so a direct slug lookup 404s
// for these names. Hardcoded map keeps the path explicit — add an entry as
// new mismatches surface.
const SCREENER_SLUG_ALIASES = {
  'GVT': 'GVT&D',     // GE Vernova T&D India
  'JK': 'J&KBANK',    // J&K Bank — actual Kite tradingsymbol is J&KBANK,
                       // but covering the bare prefix in case Kite ever
                       // normalises it the same way they did GVT.
};

// Shared HTML fetch. Multiple endpoints scrape the same page; this caches the
// raw HTML so /api/screener-quarterly and /api/screener-cashflow don't each
// hit screener.in independently.
//
// Lookup strategy:
//   1. Apply any hardcoded alias (covers Kite → screener slug rewrites).
//   2. Try the resolved slug.
//   3. On 404, fall back to the original symbol (in case the alias was wrong).
//   4. If both 404, propagate the error.
async function fetchScreenerHTML(symbol, { consolidated = false } = {}) {
  // Consolidated and standalone are different pages on screener.in. Cache them
  // independently so a request for one doesn't poison the other.
  const cacheKey = consolidated ? `${symbol}::consolidated` : symbol;
  const cached = screenerHtmlCache[cacheKey];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) return { html: cached.html, hit: true };
  if (screenerHtmlInflight[cacheKey]) return screenerHtmlInflight[cacheKey];

  const slugCandidates = [];
  if (SCREENER_SLUG_ALIASES[symbol]) slugCandidates.push(SCREENER_SLUG_ALIASES[symbol]);
  // NSE series suffixes (BE = Trade-to-Trade, BZ, SM = SME, etc.) ride on the
  // Kite tradingsymbol — e.g. SIGMAADV-BE — but screener.in keys off the base
  // symbol (SIGMAADV). Strip a known 2-letter series suffix and try the base
  // first. (Only matches the known set, so hyphenated names like BAJAJ-AUTO are
  // left untouched.)
  const baseSymbol = symbol.replace(/-(BE|BZ|BL|IL|SM|ST|GB|GC|GS|DR)$/i, '');
  if (baseSymbol !== symbol) slugCandidates.push(baseSymbol);
  slugCandidates.push(symbol);

  const tryFetch = async (slug) => {
    const suffix = consolidated ? 'consolidated/' : '';
    const url = `https://www.screener.in/company/${encodeURIComponent(slug)}/${suffix}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return r;
  };

  const p = (async () => {
    try {
      let lastErr = null;
      for (const slug of slugCandidates) {
        const r = await tryFetch(slug);
        if (r.ok) {
          const html = await r.text();
          screenerHtmlCache[cacheKey] = { html, ts: Date.now() };
          if (slug !== symbol) {
            console.log(`[screener] ${symbol} resolved via alias slug "${slug}" (${consolidated ? 'consolidated' : 'standalone'})`);
          }
          return { html, hit: false };
        }
        lastErr = new Error(`Screener returned ${r.status} for slug "${slug}"`);
        lastErr.status = r.status;
      }
      throw lastErr || new Error(`Screener returned 404 for all candidates of ${symbol}`);
    } finally {
      delete screenerHtmlInflight[cacheKey];
    }
  })();
  screenerHtmlInflight[cacheKey] = p;
  return p;
}

// Convert "Mar 2023" cell header to an Indian-FY label + sortable key.
function parseScreenerHeader(text) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [monthStr, yearStr] = text.trim().split(/\s+/);
  const m = months.indexOf(monthStr) + 1;
  const y = parseInt(yearStr, 10);
  if (!m || !y) return null;
  // Apr–Jun=Q1, Jul–Sep=Q2, Oct–Dec=Q3, Jan–Mar=Q4
  const q = m <= 3 ? 4 : m <= 6 ? 1 : m <= 9 ? 2 : 3;
  const fy = m >= 4 ? y + 1 : y;
  // YYYYMM sort key works because columns are in chronological order regardless.
  return {
    q, fy, month: m, year: y,
    label: `Q${q} FY${String(fy).slice(-2)}`,
    sortKey: y * 100 + m,
  };
}

// Maps screener's row label to our internal field name. Banks/NBFCs sometimes
// use "Revenue" or "Financing Profit" — we accept both.
const SCREENER_ROW_MAP = {
  'Sales': 'totalIncome',
  'Revenue': 'totalIncome',
  'Operating Profit': 'operatingProfit',
  'Financing Profit': 'operatingProfit', // NBFCs
  'OPM %': 'opm',
  'Financing Margin %': 'opm',
  'Net Profit': 'netProfit',
  'EPS in Rs': 'eps',
  'Expenses': 'expenses',
  'Other Income': 'otherIncome',
  'Interest': 'interest',
  'Depreciation': 'depreciation',
  'Profit before tax': 'pbt',
  'Tax %': 'taxPct',
};

function parseNumberCell(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/,/g, '').replace(/%/g, '').replace(/\s/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

function parseScreenerQuarterly(html) {
  const $ = cheerio.load(html);
  const section = $('section#quarters');
  if (section.length === 0) throw new Error('Quarterly section not found on screener page');
  const table = section.find('table.data-table').first();
  if (table.length === 0) throw new Error('Quarterly table not found');

  // First header cell is empty (the "metric" column). Rest are month headers.
  const headerCells = table.find('thead th').toArray();
  const columns = headerCells.slice(1)
    .map(el => parseScreenerHeader($(el).text()))
    .filter(Boolean);
  if (columns.length === 0) throw new Error('No quarter columns parsed');

  // Each row's first cell is a metric label (with trailing " +" sometimes —
  // those are screener's "expand for breakdown" hints we strip).
  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length === 0) return;
    const rawLabel = $(tds[0]).text().trim().replace(/\s*\+\s*$/, '').replace(/\s+/g, ' ');
    const field = SCREENER_ROW_MAP[rawLabel];
    if (!field) return;
    tds.slice(1).forEach((td, i) => {
      if (i >= columns.length) return;
      columns[i][field] = parseNumberCell($(td).text());
    });
  });

  return columns;
}

app.get('/api/screener-quarterly/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cached = screenerCache[symbol];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    const { html } = await fetchScreenerHTML(symbol);
    const quarters = parseScreenerQuarterly(html);
    if (quarters.length === 0) {
      return res.status(502).json({ error: 'No quarterly data parsed', fallback: 'yahoo' });
    }
    const payload = { source: 'screener.in', symbol, quarters };
    screenerCache[symbol] = { data: payload, ts: Date.now() };
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error(`[screener-quarterly] ${symbol}:`, err.message);
    res.status(err.status === 404 ? 404 : (err.status ? 502 : 500))
      .json({ error: err.message, fallback: 'yahoo' });
  }
});

// ─── Screener annual P&L (yearly results) ────────────────────────
// Same row labels as the quarterly table (Sales / Expenses / Operating Profit /
// OPM % / Net Profit / EPS), but `section#profit-loss` carries one column per
// fiscal year. Standalone, to match the quarterly view. Screener's rightmost
// "TTM" column has no parseable month header, so parseScreenerHeader returns
// null for it and it's filtered out — the yearly view shows completed fiscal
// years only (cleaner than mixing a trailing-12m column into a per-FY series).
function parseScreenerAnnualPL(html) {
  const $ = cheerio.load(html);
  const section = $('section#profit-loss');
  if (section.length === 0) throw new Error('Profit & Loss section not found on screener page');
  const table = section.find('table.data-table').first();
  if (table.length === 0) throw new Error('Profit & Loss table not found');

  const headerCells = table.find('thead th').toArray();
  const columns = headerCells.slice(1).map(el => {
    const parsed = parseScreenerHeader($(el).text());
    if (!parsed) return null;
    // Annual columns are fiscal-year ends — relabel FYxx and sort by year.
    return { ...parsed, label: `FY${String(parsed.fy).slice(-2)}`, sortKey: parsed.fy };
  }).filter(Boolean);
  if (columns.length === 0) throw new Error('No P&L year columns parsed');

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length === 0) return;
    const rawLabel = $(tds[0]).text().trim().replace(/\s*\+\s*$/, '').replace(/\s+/g, ' ');
    const field = SCREENER_ROW_MAP[rawLabel];
    if (!field) return;
    tds.slice(1).forEach((td, i) => {
      if (i >= columns.length) return;
      columns[i][field] = parseNumberCell($(td).text());
    });
  });

  return columns;
}

const screenerAnnualCache = {};

app.get('/api/screener-annual/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cached = screenerAnnualCache[symbol];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    const { html } = await fetchScreenerHTML(symbol);
    const years = parseScreenerAnnualPL(html);
    if (years.length === 0) {
      return res.status(502).json({ error: 'No annual P&L data parsed', fallback: 'yahoo' });
    }
    const payload = { source: 'screener.in', symbol, period: 'annual', years };
    screenerAnnualCache[symbol] = { data: payload, ts: Date.now() };
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error(`[screener-annual] ${symbol}:`, err.message);
    res.status(err.status === 404 ? 404 : (err.status ? 502 : 500))
      .json({ error: err.message, fallback: 'yahoo' });
  }
});

// ─── Screener cashflow (annual) ──────────────────────────────────
// Indian companies don't file quarterly cashflow statements in their
// standalone disclosures, so screener only carries annual cashflow. Returns
// up to 12 fiscal years with CFO/CFI/CFF/Net + Free Cash Flow already
// calculated (saves us re-doing FCF math).
const SCREENER_CASHFLOW_ROW_MAP = {
  'Cash from Operating Activity': 'operatingCashFlow',
  'Cash from Investing Activity': 'investingCashFlow',
  'Cash from Financing Activity': 'financingCashFlow',
  'Net Cash Flow': 'netCashFlow',
  'Free Cash Flow': 'freeCashFlow',
};

function parseScreenerCashflow(html) {
  const $ = cheerio.load(html);
  const section = $('section#cash-flow');
  if (section.length === 0) throw new Error('Cashflow section not found on screener page');
  const table = section.find('table.data-table').first();
  if (table.length === 0) throw new Error('Cashflow table not found');

  // Headers are fiscal-year ends (e.g. "Mar 2024" = FY24). Build a label per column.
  const headerCells = table.find('thead th').toArray();
  const columns = headerCells.slice(1).map(el => {
    const parsed = parseScreenerHeader($(el).text());
    if (!parsed) return null;
    // For annual cashflow, label by FY only (the Q is always FY-end Q4 = Mar).
    return { ...parsed, fyLabel: `FY${String(parsed.fy).slice(-2)}` };
  }).filter(Boolean);
  if (columns.length === 0) throw new Error('No cashflow year columns parsed');

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length === 0) return;
    const rawLabel = $(tds[0]).text().trim().replace(/\s*\+\s*$/, '').replace(/\s+/g, ' ');
    const field = SCREENER_CASHFLOW_ROW_MAP[rawLabel];
    if (!field) return;
    tds.slice(1).forEach((td, i) => {
      if (i >= columns.length) return;
      columns[i][field] = parseNumberCell($(td).text());
    });
  });

  // Drop columns with no data. Screener emits a blank header column for the
  // current fiscal year before results are filed (e.g. SCHNEIDER's "Mar 2026"
  // ahead of FY26 reporting), which would otherwise render as an empty FY bar.
  const cfFields = Object.values(SCREENER_CASHFLOW_ROW_MAP);
  return columns.filter(c => cfFields.some(f => c[f] != null));
}

const screenerCashflowCache = {};

app.get('/api/screener-cashflow/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cached = screenerCashflowCache[symbol];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    const { html } = await fetchScreenerHTML(symbol);
    const years = parseScreenerCashflow(html);
    if (years.length === 0) {
      return res.status(502).json({ error: 'No cashflow data parsed', fallback: 'yahoo' });
    }
    const payload = { source: 'screener.in', symbol, period: 'annual', years };
    screenerCashflowCache[symbol] = { data: payload, ts: Date.now() };
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error(`[screener-cashflow] ${symbol}:`, err.message);
    res.status(err.status === 404 ? 404 : (err.status ? 502 : 500))
      .json({ error: err.message, fallback: 'yahoo' });
  }
});

// ─── Screener peer comparison ────────────────────────────────────
// Screener's per-company /api/company/{id}/peers/ AJAX endpoint is unreliable
// for server-side requests (it returns a wrong/empty peer set). Instead we use
// the company's *industry* page (the deepest `title="Industry"` breadcrumb in
// the #peers section, e.g. /market/IN08/IN0801/IN080101/IN080101001/) which
// reliably lists the true sector peers with the same comparison columns:
// Name · CMP · P/E · Mar Cap(Cr) · Div Yld% · NP Qtr(Cr) · Qtr Profit Var% ·
// Sales Qtr(Cr) · Qtr Sales Var% · ROCE%, plus a Median row in <tfoot>.
const SCREENER_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Map a peers header cell to a known field. Header text carries units +
// whitespace (e.g. "Mar Cap\n Rs.Cr."), so match on normalised substrings —
// this is what makes the parse resilient to screener inserting/reordering
// columns (vs. reading fixed positions, which would silently mislabel data).
function peersFieldForHeader(text) {
  const t = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.includes('name')) return 'name';
  if (/\bp\/e\b/.test(t) || t === 'pe') return 'pe';
  if (t.includes('cmp') || t.includes('price')) return 'cmp';
  if (t.includes('mar cap') || t.includes('market cap') || t.includes('m.cap')) return 'marketCap';
  if (t.includes('div yld') || t.includes('div yield') || t.includes('dividend')) return 'divYield';
  if (t.includes('profit var')) return 'profitVar';
  if (t.includes('np qtr') || t.includes('net profit')) return 'npQtr';
  if (t.includes('sales var')) return 'salesVar';
  if (t.includes('sales qtr') || t.includes('sales')) return 'salesQtr';
  if (t.includes('roce')) return 'roce';
  return null;
}

const PEERS_NUMERIC = ['cmp', 'pe', 'marketCap', 'divYield', 'npQtr', 'profitVar', 'salesQtr', 'salesVar', 'roce'];

function parseScreenerPeers(html) {
  const $ = cheerio.load(html);
  // The industry listing table is the one whose rows link to /company/ pages.
  let table = null;
  $('table').each((_, t) => {
    if (!table && $(t).find('tbody a[href^="/company/"]').length > 0) table = $(t);
  });
  if (!table) throw new Error('Peer table not found');

  // The industry table has no <thead> — header <th> cells sit in the first
  // <tr> (and may repeat mid-table). Map field -> column index from that row.
  const headerRow = table.find('tr').filter((_, tr) => $(tr).find('th').length > 0).first();
  const colIndex = {};
  headerRow.find('th').each((i, th) => {
    const field = peersFieldForHeader($(th).text());
    if (field && colIndex[field] === undefined) colIndex[field] = i;
  });
  // Fail loud if the layout we depend on is no longer recognisable, so the
  // endpoint reports "unavailable" instead of returning shifted/garbage values.
  const mappedNumeric = PEERS_NUMERIC.filter(f => colIndex[f] !== undefined);
  if (colIndex.name === undefined || mappedNumeric.length < 5) {
    throw new Error('Peer table columns unrecognised — screener layout may have changed');
  }

  const rowNumbers = (tds) => {
    const out = {};
    for (const f of PEERS_NUMERIC) {
      const idx = colIndex[f];
      out[f] = (idx === undefined || !tds[idx]) ? null : parseNumberCell($(tds[idx]).text());
    }
    return out;
  };

  const peers = [];
  table.find('tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length <= colIndex.name) return;
    const nameCell = $(tds[colIndex.name]);
    const href = nameCell.find('a[href^="/company/"]').attr('href') || '';
    const slug = (href.match(/\/company\/([^/]+)\//) || [])[1] || null;
    if (!slug) return;
    peers.push({ name: nameCell.text().trim().replace(/\s+/g, ' '), slug, ...rowNumbers(tds) });
  });

  // Sanity: a real industry table has peers carrying at least some numbers.
  const usable = peers.filter(p => p.cmp != null || p.pe != null || p.marketCap != null).length;
  if (peers.length === 0 || usable === 0) {
    throw new Error('Peer table parsed but held no usable data');
  }

  const footTds = table.find('tfoot tr').first().find('td').toArray();
  const median = footTds.length > 0 ? rowNumbers(footTds) : null;

  return { peers, median };
}

const screenerPeersCache = {};

app.get('/api/screener-peers/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cached = screenerPeersCache[symbol];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    const { html } = await fetchScreenerHTML(symbol);
    // Deepest sector breadcrumb = the tightest peer group.
    const linkMatch = html.match(/href="(\/market\/[^"]+)"[^>]*title="Industry"[^>]*>([^<]+)</);
    if (!linkMatch) {
      return res.status(502).json({ error: 'Peer industry not found on screener page' });
    }
    const industryUrl = linkMatch[1];
    const industry = linkMatch[2].trim().replace(/&amp;/g, '&');

    const r = await fetch(`https://www.screener.in${industryUrl}`, { headers: SCREENER_FETCH_HEADERS });
    if (!r.ok) return res.status(502).json({ error: `Industry page returned ${r.status}` });
    const { peers, median } = parseScreenerPeers(await r.text());
    if (peers.length === 0) return res.status(502).json({ error: 'No peers parsed' });

    const payload = { source: 'screener.in', symbol, industry, peers, median };
    screenerPeersCache[symbol] = { data: payload, ts: Date.now() };
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error(`[screener-peers] ${symbol}:`, err.message);
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
});

// ─── Screener balance sheet (annual) ─────────────────────────────
// Annual balance sheet rebuilt from the same screener page. Consolidated by
// default to match group-level reporting; falls back to standalone if the
// consolidated page is unusable — either a 404 (small caps that don't publish
// consolidated) or a 200 "shell" page whose financial tables are empty
// (single-entity companies like NMDC Steel that file standalone only).
const SCREENER_BS_ROW_MAP = {
  'Equity Capital': 'equityCapital',
  'Reserves': 'reserves',
  'Borrowings': 'borrowings',
  'Other Liabilities': 'otherLiabilities',
  'Total Liabilities': 'totalLiabilities',
  'Fixed Assets': 'fixedAssets',
  'CWIP': 'cwip',
  'Investments': 'investments',
  'Other Assets': 'otherAssets',
  'Total Assets': 'totalAssets',
  // NBFC / bank variants — screener sometimes uses these
  'Deposits': 'deposits',
  'Loans': 'loans',
};

function parseScreenerBalanceSheet(html) {
  const $ = cheerio.load(html);
  const section = $('section#balance-sheet');
  if (section.length === 0) throw new Error('Balance sheet section not found on screener page');
  const table = section.find('table.data-table').first();
  if (table.length === 0) throw new Error('Balance sheet table not found');

  const headerCells = table.find('thead th').toArray();
  const columns = headerCells.slice(1).map(el => {
    const parsed = parseScreenerHeader($(el).text());
    if (!parsed) return null;
    return { ...parsed, fyLabel: `FY${String(parsed.fy).slice(-2)}` };
  }).filter(Boolean);
  if (columns.length === 0) throw new Error('No balance sheet year columns parsed');

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length === 0) return;
    const rawLabel = $(tds[0]).text().trim().replace(/\s*\+\s*$/, '').replace(/\s+/g, ' ');
    const field = SCREENER_BS_ROW_MAP[rawLabel];
    if (!field) return;
    tds.slice(1).forEach((td, i) => {
      if (i >= columns.length) return;
      columns[i][field] = parseNumberCell($(td).text());
    });
  });

  // Drop phantom columns that carry no data. Screener emits a blank placeholder
  // column when a company switches fiscal year-end (e.g. POWERINDIA's "Dec 2021"
  // stub from its Dec→Mar transition), which would otherwise render as an empty
  // duplicate FY column next to the real one.
  const bsFields = Object.values(SCREENER_BS_ROW_MAP);
  const withData = columns.filter(c => bsFields.some(f => c[f] != null));

  // Derive net worth (equity capital + reserves) when both are present —
  // simpler for the UI than recomputing per row.
  withData.forEach(c => {
    if (c.equityCapital != null && c.reserves != null) {
      c.netWorth = +(c.equityCapital + c.reserves).toFixed(2);
    }
  });

  return withData;
}

const screenerBalanceSheetCache = {};

app.get('/api/screener-balance-sheet/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  // Default consolidated=true (matches user request); allow ?consolidated=0 to
  // force standalone.
  const consolidated = req.query.consolidated !== '0' && req.query.consolidated !== 'false';
  const cacheKey = `${symbol}::${consolidated ? 'consolidated' : 'standalone'}`;
  const cached = screenerBalanceSheetCache[cacheKey];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    // Fetch + parse a given basis in one step so the fallback can react to a
    // failed *parse* (empty consolidated shell), not just a failed fetch (404).
    const parseBasis = async (useConsolidated) => {
      const { html } = await fetchScreenerHTML(symbol, { consolidated: useConsolidated });
      return parseScreenerBalanceSheet(html);
    };

    let usedBasis = consolidated ? 'consolidated' : 'standalone';
    let years;
    // Latest fiscal year in a parsed series (0 when empty/missing).
    const latestFY = (ys) => (ys && ys.length) ? Math.max(...ys.map(y => y.fy)) : 0;
    if (consolidated) {
      let consolidatedYears = null;
      try {
        consolidatedYears = await parseBasis(true);
      } catch (err) {
        // Consolidated unusable — page missing (404) OR present but empty
        // (200 shell, no balance-sheet table, e.g. NMDC Steel). We fall through
        // to standalone below; many companies only file standalone anyway.
        console.log(`[screener-balance-sheet] ${symbol} consolidated unusable (${err.message}) — falling back to standalone`);
      }
      // The consolidated page is suspect when it's missing, has too few columns
      // (degenerate single-column tables like GVT&D's stale "Dec 2010"), OR is
      // STALE — e.g. Tata Elxsi stopped filing consolidated after FY15, so its
      // consolidated page still serves FY08–FY15 while standalone runs to the
      // current year. "Stale" = latest FY is >=2 years behind the current
      // calendar year (Indian FYs end in March, so a 1-year lag is normal).
      const currentYear = new Date().getFullYear();
      const consSuspect = !consolidatedYears
        || consolidatedYears.length < 2
        || (currentYear - latestFY(consolidatedYears) >= 2);
      if (consSuspect) {
        try {
          const standaloneYears = await parseBasis(false);
          // Prefer standalone when it carries fresher data, or (same latest FY)
          // more year columns. Otherwise keep whatever consolidated we have.
          if (!consolidatedYears
              || latestFY(standaloneYears) > latestFY(consolidatedYears)
              || (latestFY(standaloneYears) === latestFY(consolidatedYears) && standaloneYears.length > consolidatedYears.length)) {
            years = standaloneYears;
            usedBasis = 'standalone';
          } else {
            years = consolidatedYears;
          }
        } catch (err) {
          if (!consolidatedYears) throw err;  // both bases failed — propagate
          years = consolidatedYears;          // standalone unavailable; keep consolidated
        }
      } else {
        years = consolidatedYears;
      }
    } else {
      years = await parseBasis(false);
    }
    if (years.length === 0) {
      return res.status(502).json({ error: 'No balance sheet data parsed' });
    }
    const payload = { source: 'screener.in', symbol, period: 'annual', basis: usedBasis, years };
    screenerBalanceSheetCache[cacheKey] = { data: payload, ts: Date.now() };
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error(`[screener-balance-sheet] ${symbol}:`, err.message);
    res.status(err.status === 404 ? 404 : (err.status ? 502 : 500))
      .json({ error: err.message });
  }
});

// ─── Screener shareholding pattern (quarterly) ───────────────────
// Rendered as `section#shareholding` with two sub-tables: quarterly and
// yearly. We parse only the quarterly table (richer cadence — useful for
// spotting promoter pledging or FII rotation in real time). Values are
// percentages of total equity.
const SCREENER_SHARE_ROW_MAP = {
  // Top-level categories
  'Promoters': 'promoters',
  'FIIs': 'fiis',
  'Foreign Institutions': 'fiis',
  'DIIs': 'diis',
  'Domestic Institutions': 'diis',
  'Government': 'government',
  'Public': 'public',
  'Others': 'others',
  // DII sub-rows (only present after the "+" expansion is rendered into the
  // HTML — screener usually inlines them, so worth parsing).
  'Mutual Funds': 'mutualFunds',
  'Other Domestic Institutions': 'otherDIIs',
  'Insurance Companies': 'insurance',
  // Shareholder count — not a %.
  'Shareholders': 'shareholders',
  'No. of Shareholders': 'shareholders',
};

function parseScreenerShareholding(html) {
  const $ = cheerio.load(html);
  const section = $('section#shareholding');
  if (section.length === 0) throw new Error('Shareholding section not found on screener page');
  // Screener shows quarterly + yearly tabs. Quarterly table sits inside a
  // div with id ending in "quarterly-shp"; fall back to the first table if
  // that markup changes.
  let table = section.find('div[id$="quarterly-shp"] table.data-table').first();
  if (table.length === 0) table = section.find('table.data-table').first();
  if (table.length === 0) throw new Error('Shareholding table not found');

  // Column headers are dates like "Mar 2024", "Jun 2024", etc.
  const headerCells = table.find('thead th').toArray();
  const columns = headerCells.slice(1).map(el => {
    const parsed = parseScreenerHeader($(el).text());
    if (!parsed) return null;
    return { ...parsed, label: `Q${parsed.q} FY${String(parsed.fy).slice(-2)}` };
  }).filter(Boolean);
  if (columns.length === 0) throw new Error('No shareholding columns parsed');

  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td').toArray();
    if (tds.length === 0) return;
    // Screener wraps the "+" expand hint in a sub-element and frequently
    // uses non-breaking spaces ( ) inside cells. Normalise both before
    // matching against SCREENER_SHARE_ROW_MAP, otherwise rows like
    // "Promoters +" silently fail to match the "Promoters" key.
    const rawLabel = $(tds[0]).text()
      .replace(/ /g, ' ')
      .trim()
      .replace(/\s*\+\s*$/, '')
      .replace(/\s+/g, ' ');
    const field = SCREENER_SHARE_ROW_MAP[rawLabel];
    if (!field) return;
    tds.slice(1).forEach((td, i) => {
      if (i >= columns.length) return;
      columns[i][field] = parseNumberCell($(td).text());
    });
  });

  return columns;
}

const screenerShareholdingCache = {};

app.get('/api/screener-shareholding/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const consolidated = req.query.consolidated !== '0' && req.query.consolidated !== 'false';
  const cacheKey = `${symbol}::${consolidated ? 'consolidated' : 'standalone'}`;
  const cached = screenerShareholdingCache[cacheKey];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    let html;
    try {
      ({ html } = await fetchScreenerHTML(symbol, { consolidated }));
    } catch (err) {
      if (consolidated && err.status === 404) {
        ({ html } = await fetchScreenerHTML(symbol, { consolidated: false }));
      } else {
        throw err;
      }
    }
    const quarters = parseScreenerShareholding(html);
    if (quarters.length === 0) {
      return res.status(502).json({ error: 'No shareholding data parsed' });
    }
    const payload = { source: 'screener.in', symbol, period: 'quarterly', quarters };
    screenerShareholdingCache[cacheKey] = { data: payload, ts: Date.now() };
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error(`[screener-shareholding] ${symbol}:`, err.message);
    res.status(err.status === 404 ? 404 : (err.status ? 502 : 500))
      .json({ error: err.message });
  }
});

// Lightweight cache probe: given a list of tokens, report which already have a
// warm historical-full entry. Lets the Indices page fetch warm tokens in
// parallel (pure in-memory reads) while keeping cold MCP fetches serial + spaced.
app.post('/api/historical-full/cached', (req, res) => {
  const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens.map(String) : [];
  const now = Date.now();
  const cachedTokens = tokens.filter(t => {
    const c = historicalFullCache[t];
    return c && (now - c.timestamp < HISTORICAL_FULL_TTL);
  });
  res.json({ cachedTokens });
});

// ─── Multi-year historical data (for Sector Indices) ──────────
app.get('/api/historical-full/:token', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const { token } = req.params;
    const isCacheHit = !!(historicalFullCache[token] && (Date.now() - historicalFullCache[token].timestamp < HISTORICAL_FULL_TTL));
    if (isCacheHit) {
      console.log(`📊 Serving cached 4Y history for token ${token} (${historicalFullCache[token].data.length} candles)`);
    } else if (!historicalFullPromises[token]) {
      console.log(`📊 Fetching full 4Y history for token ${token}...`);
    } else {
      console.log(`⏳ Coalescing /api/historical-full call for token ${token} into in-flight fetch...`);
    }
    const { data, cached } = await getOrFetchFullHistory(token);
    if (!cached && Array.isArray(data) && data.length > 0) {
      console.log(`  ✅ Got ${data.length} candles from ${data[0].date.substring(0, 10)} to ${data[data.length - 1].date.substring(0, 10)}`);
    }
    return res.json({
      cached,
      content: [{ type: "text", text: JSON.stringify(Array.isArray(data) ? data : []) }]
    });
  } catch (err) {
    console.error("Historical-full error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Relative Rotation Graph (RRG) ────────────────────────────
// Sector index keys and their tokens are resolved at runtime from the quotes cache.
const RRG_SECTOR_KEYS = [
  "NSE:NIFTY BANK", "NSE:NIFTY IT", "NSE:NIFTY AUTO", "NSE:NIFTY PHARMA",
  "NSE:NIFTY FMCG", "NSE:NIFTY REALTY", "NSE:NIFTY PSU BANK", "NSE:NIFTY METAL",
  "NSE:NIFTY INFRA", "NSE:NIFTY ENERGY", "NSE:NIFTY FIN SERVICE",
  "NSE:NIFTY PVT BANK", "NSE:NIFTY CONSR DURBL", "NSE:NIFTY HEALTHCARE",
  "NSE:NIFTY MEDIA", "NSE:NIFTY COMMODITIES", "NSE:NIFTY CHEMICALS", "NSE:NIFTY OIL AND GAS",
  "NSE:NIFTY IND DEFENCE"
];

// Broad-market + commodity rows the Indices Performance table renders that are
// NOT RRG sectors. Prewarmed alongside the sectors so every tab opens warm.
const INDEX_BROAD_COMMODITY_KEYS = [
  "NSE:NIFTY NEXT 50", "NSE:NIFTY 100", "NSE:NIFTY 200", "NSE:NIFTY TOTAL MKT",
  "NSE:NIFTY MIDCAP 150", "NSE:NIFTY MID SELECT", "NSE:NIFTY SMLCAP 250", "NSE:NIFTY SMLCAP 100",
  "BSE:SENSEX",
  "NSE:GOLDBEES", "NSE:SILVERBEES", "NSE:HINDZINC", "NSE:HINDCOPPER",
];

const RRG_SECTOR_NAMES = {
  "NSE:NIFTY BANK": "NIFTY BANK",
  "NSE:NIFTY IT": "NIFTY IT",
  "NSE:NIFTY AUTO": "NIFTY AUTO",
  "NSE:NIFTY PHARMA": "NIFTY PHARMA",
  "NSE:NIFTY FMCG": "NIFTY FMCG",
  "NSE:NIFTY REALTY": "NIFTY REALTY",
  "NSE:NIFTY PSU BANK": "NIFTY PSU BANK",
  "NSE:NIFTY METAL": "NIFTY METAL",
  "NSE:NIFTY INFRA": "NIFTY INFRA",
  "NSE:NIFTY ENERGY": "NIFTY ENERGY",
  "NSE:NIFTY FIN SERVICE": "NIFTY FIN SERVICE",
  "NSE:NIFTY PVT BANK": "NIFTY PRIVATE BANK",
  "NSE:NIFTY CONSR DURBL": "NIFTY CONSUMER DURABLES",
  "NSE:NIFTY HEALTHCARE": "NIFTY HEALTHCARE",
  "NSE:NIFTY MEDIA": "NIFTY MEDIA",
  "NSE:NIFTY COMMODITIES": "NIFTY COMMODITIES",
  "NSE:NIFTY CHEMICALS": "NIFTY CHEMICALS",
  "NSE:NIFTY OIL AND GAS": "NIFTY OIL AND GAS",
  "NSE:NIFTY IND DEFENCE": "NIFTY INDIA DEFENCE"
};

// Helper: resample daily candles to weekly (Friday close)
function resampleToWeekly(dailyCandles) {
  const weeks = [];
  let currentWeek = null;

  for (const c of dailyCandles) {
    const d = new Date(c.date);
    // Get the Friday of this week (ISO: Mon=1...Sun=7)
    const day = d.getDay(); // 0=Sun, 1=Mon...6=Sat
    const diff = 5 - day; // distance to Friday
    const friday = new Date(d);
    friday.setDate(d.getDate() + diff);
    const weekKey = friday.toISOString().split('T')[0];

    if (!currentWeek || currentWeek.key !== weekKey) {
      currentWeek = { key: weekKey, close: c.close, date: c.date };
      weeks.push(currentWeek);
    } else {
      // Update with the latest candle in this week
      currentWeek.close = c.close;
      currentWeek.date = c.date;
    }
  }
  return weeks;
}

// Helper: compute EMA
function computeEMA(values, period) {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// Helper: compute SMA (returns array aligned to end, first (period-1) entries are null)
function computeSMA(values, period) {
  const sma = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      sma.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      sma.push(sum / period);
    }
  }
  return sma;
}

// RRG token cache — maps instrument key to token, populated from quotes
const rrgTokenCache = {};

// Pre-warm historicalFullCache for all RRG sector tokens at startup so the first
// /api/rrg call has complete data — eliminates the partial-cache stampede where
// the frontend sees flickering momentum scores while sectors trickle in serially.
async function prewarmRrgHistoricalCache() {
  if (historicalFullWarming.active) return;

  // Full key set the Indices Performance table renders: RRG sectors + the 3 RS
  // benchmarks + broad-market & commodity rows. Resolve tokens for any we don't
  // have yet (one batch quote) so every tab opens against a warm cache.
  const allKeys = [...new Set([
    "NSE:NIFTY 50", "NSE:NIFTY 500", "NSE:NIFTY MIDCAP 100",
    ...RRG_SECTOR_KEYS, ...INDEX_BROAD_COMMODITY_KEYS,
  ])];
  const missing = allKeys.filter(k => !rrgTokenCache[k]);
  if (missing.length) {
    try {
      const q = await callWithTimeout({ name: "get_quotes", arguments: { instruments: missing } });
      const quotes = parseMcpText(q) || {};
      for (const k of missing) {
        if (quotes[k]?.instrument_token) rrgTokenCache[k] = String(quotes[k].instrument_token);
      }
    } catch (e) {
      console.log(`⚠️ index prewarm token resolve failed: ${e.message}`);
      // Proceed with whatever tokens we already have rather than bailing entirely.
    }
  }

  const tokens = [...new Set(allKeys.map(k => rrgTokenCache[k]).filter(Boolean))];
  Object.assign(historicalFullWarming, { active: true, total: tokens.length, loaded: 0, startedAt: Date.now() });
  console.log(`🔥 Pre-warming historicalFullCache for ${tokens.length} index tokens...`);

  for (const token of tokens) {
    const c = historicalFullCache[token];
    if (c && (Date.now() - c.timestamp < HISTORICAL_FULL_TTL)) {
      historicalFullWarming.loaded++;
      continue;
    }
    try {
      await getOrFetchFullHistory(token);
      historicalFullWarming.loaded++;
    } catch (e) {
      console.log(`  ⚠️ prewarm token ${token}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  historicalFullWarming.active = false;
  console.log(`✅ Index prewarm complete: ${historicalFullWarming.loaded}/${tokens.length} cached`);
}

app.get('/api/rrg', async (req, res) => {
  try {
    const benchmarkKey = req.query.benchmark || "NSE:NIFTY 50";

    // Optional: compute RRG for a custom set of securities instead of RRG_SECTOR_KEYS
    let keysToCompute = RRG_SECTOR_KEYS;
    if (req.query.securities) {
      const raw = decodeURIComponent(req.query.securities);
      keysToCompute = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map(s => s.trim());
    }

    console.log(`📊 RRG requested. Benchmark: ${benchmarkKey}. Securities: ${keysToCompute.length}. Token cache size: ${Object.keys(rrgTokenCache).length}, HistFull cache size: ${Object.keys(historicalFullCache).length}`);
    const progress = {
      loaded: historicalFullWarming.loaded,
      total: historicalFullWarming.total || (keysToCompute.length + 1),
      active: historicalFullWarming.active,
    };

    // Step 1: Resolve tokens if not yet cached
    // Tokens are populated as a side-effect by /api/quotes (called by frontend on page load).
    // Only call MCP directly as a last resort fallback.
    if (Object.keys(rrgTokenCache).length === 0) {
      console.log('  ⏳ RRG: Token cache empty. Attempting to resolve via MCP get_quotes...');
      try {
        const allKeys = [benchmarkKey, ...keysToCompute];
        const quoteResult = await callWithTimeout({
          name: "get_quotes",
          arguments: { instruments: allKeys }
        });
        if (quoteResult?.content?.[0]?.text) {
          const quotes = JSON.parse(quoteResult.content[0].text);
          for (const key of allKeys) {
            if (quotes[key]?.instrument_token) {
              rrgTokenCache[key] = String(quotes[key].instrument_token);
            }
          }
          console.log(`  ✅ Resolved ${Object.keys(rrgTokenCache).length} tokens`);
        } else {
          console.log('  ⚠️ get_quotes returned no parseable data');
        }
      } catch (quoteErr) {
        console.log(`  ⚠️ Token resolution failed: ${quoteErr.message}. Will retry next call.`);
        return res.json({ ready: false, benchmark: benchmarkKey, sectors: [], progress, message: "Token resolution pending. Retrying..." });
      }
    }

    // Batch-resolve any missing tokens for custom securities list
    const missingKeys = keysToCompute.filter(k => !rrgTokenCache[k]);
    if (missingKeys.length > 0) {
      console.log(`  ⏳ Resolving ${missingKeys.length} missing tokens for custom securities...`);
      try {
        const qr = await callWithTimeout({ name: 'get_quotes', arguments: { instruments: missingKeys } });
        const q = parseMcpText(qr) || {};
        for (const k of Object.keys(q)) {
          if (q[k]?.instrument_token) rrgTokenCache[k] = String(q[k].instrument_token);
        }
      } catch (e) { console.log(`  ⚠️ Token resolution for custom list failed: ${e.message}`); }
    }

    const benchmarkToken = rrgTokenCache[benchmarkKey];
    if (!benchmarkToken) {
      console.log(`  ❌ Cannot resolve benchmark token for ${benchmarkKey}. Token cache keys:`, Object.keys(rrgTokenCache).join(', '));
      return res.json({ ready: false, benchmark: benchmarkKey, sectors: [], progress, message: `Benchmark token (${benchmarkKey}) not yet resolved.` });
    }

    // Step 2: Get benchmark historical data
    const benchmarkCached = historicalFullCache[benchmarkToken];
    if (!benchmarkCached || !benchmarkCached.data || benchmarkCached.data.length === 0) {
      console.log(`  ⏳ Benchmark token ${benchmarkToken} (${benchmarkKey}) not in historicalFullCache. Cache keys: ${Object.keys(historicalFullCache).slice(0, 10).join(', ')}...`);
      return res.json({ ready: false, benchmark: benchmarkKey, sectors: [], progress, message: "Benchmark historical data not yet cached." });
    }

    console.log(`  ✅ Benchmark data: ${benchmarkCached.data.length} daily candles`);
    const benchmarkWeekly = resampleToWeekly(benchmarkCached.data);
    console.log(`  ✅ Benchmark weekly: ${benchmarkWeekly.length} weeks`);

    // Build a date→close map for the benchmark
    const benchmarkMap = {};
    for (const w of benchmarkWeekly) {
      benchmarkMap[w.key] = w.close;
    }

    // Step 3: Compute RS-Ratio and RS-Momentum for each security
    const sectors = [];
    const skipped = [];

    for (const sectorKey of keysToCompute) {
      const token = rrgTokenCache[sectorKey];
      if (!token) { skipped.push(`${sectorKey}: no token`); continue; }

      const sectorCached = historicalFullCache[token];
      if (!sectorCached || !sectorCached.data || sectorCached.data.length === 0) {
        skipped.push(`${sectorKey}: no historical data (token=${token})`);
        continue;
      }

      const sectorWeekly = resampleToWeekly(sectorCached.data);

      // Align sector and benchmark by week key
      const aligned = [];
      for (const sw of sectorWeekly) {
        const bClose = benchmarkMap[sw.key];
        if (bClose && bClose > 0) {
          aligned.push({ weekKey: sw.key, sectorClose: sw.close, benchClose: bClose });
        }
      }

      if (aligned.length < 26) {
        skipped.push(`${sectorKey}: only ${aligned.length} aligned weeks (need 26 for stable RS math; newly-listed indices are deferred until enough history accrues)`);
        continue;
      }

      // Fixed smoothing windows so every sector is plotted on a comparable scale.
      // Full JdK uses 10/52/26 but we shorten the ratio window to 26 when <52 weeks exist.
      const emaWindow = 10;
      const ratioSmaWindow = aligned.length >= 52 ? 52 : 26;
      const momSmaWindow = aligned.length >= 52 ? 26 : 13;

      // Raw RS = (sector / benchmark) * 100
      const rawRS = aligned.map(a => (a.sectorClose / a.benchClose) * 100);

      // EMA smoothing (period dynamically set)
      const rsSmooth = computeEMA(rawRS, emaWindow);

      // RS-Ratio = (RS_smooth / SMA(RS_smooth, dynSma)) * 100
      const rsSmoothSMA = computeSMA(rsSmooth, ratioSmaWindow);
      const rsRatio = rsSmooth.map((v, i) => {
        if (rsSmoothSMA[i] === null || rsSmoothSMA[i] === 0) return null;
        return (v / rsSmoothSMA[i]) * 100;
      });

      // RS-Momentum = (RS_Ratio / SMA(RS_Ratio, momSmaWindow)) * 100
      //
      // Treating early `null` rsRatio values as 0 (the previous logic)
      // polluted the SMA window with zeros for the entire warmup period.
      // When real rsRatio values (~100) finally started, the SMA was still
      // averaging in 25 zeros and 1 real value → SMA ≈ 3.85 → rsMomentum
      // exploded to ~2600. CHEMICALS hit this hardest because it had fewer
      // aligned weeks; the user saw rsMomentum = 1300 vs every other
      // sector's 95-115.
      //
      // Fix: compute the SMA only on the valid suffix of rsRatio (from the
      // first non-null index onward), then map results back to the original
      // index space. The null prefix produces null rsMomentum, which is
      // already filtered out by the series builder below.
      const firstValidIdx = rsRatio.findIndex(v => v !== null && v !== 0);
      const rsMomentum = rsRatio.map(() => null);
      if (firstValidIdx >= 0) {
        const validSlice = rsRatio.slice(firstValidIdx);
        const validSliceSMA = computeSMA(validSlice, momSmaWindow);
        for (let i = 0; i < validSlice.length; i++) {
          const v = validSlice[i];
          const sma = validSliceSMA[i];
          if (v == null || v === 0 || sma == null || sma === 0) continue;
          rsMomentum[firstValidIdx + i] = (v / sma) * 100;
        }
      }

      // Build the output series — last 52 valid weekly data points
      const series = [];
      for (let i = aligned.length - 1; i >= 0 && series.length < 52; i--) {
        if (rsRatio[i] !== null && rsRatio[i] !== 0 && rsMomentum[i] !== null) {
          series.unshift({
            date: aligned[i].weekKey,
            rsRatio: parseFloat(rsRatio[i].toFixed(2)),
            rsMomentum: parseFloat(rsMomentum[i].toFixed(2))
          });
        }
      }

      if (series.length > 0) {
        const latest = series[series.length - 1];
        let quadrant = 'Lagging';
        if (latest.rsRatio >= 100 && latest.rsMomentum >= 100) quadrant = 'Leading';
        else if (latest.rsRatio >= 100 && latest.rsMomentum < 100) quadrant = 'Weakening';
        else if (latest.rsRatio < 100 && latest.rsMomentum >= 100) quadrant = 'Improving';

        sectors.push({
          name: RRG_SECTOR_NAMES[sectorKey] || sectorKey.split(':')[1] || sectorKey,
          key: sectorKey,
          token,
          quadrant,
          series
        });
      } else {
        skipped.push(`${sectorKey}: 0 valid RS data points after computation`);
      }
    }

    console.log(`  ✅ RRG computed against ${benchmarkKey}: ${sectors.length} sectors, ${skipped.length} skipped`);
    if (skipped.length > 0) console.log(`  ⚠️ Skipped: ${skipped.join(' | ')}`);

    const ready = sectors.length >= Math.min(keysToCompute.length, Math.ceil(keysToCompute.length * 0.7));
    res.json({
      ready,
      benchmark: benchmarkKey,
      generatedAt: new Date().toISOString(),
      sectors,
      progress,
    });
  } catch (err) {
    console.error("RRG computation error:", err);
    res.status(500).json({ error: "Failed to compute RRG: " + err.message });
  }
});

app.post('/api/quotes', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const { instruments } = req.body;
    if (!instruments || !instruments.length) return res.json({ content: [{ text: "{}" }] });
    const result = await callWithTimeout({
      name: "get_quotes",
      arguments: { instruments }
    });

    // Side-effect: populate rrgTokenCache from any quotes response
    // so the RRG endpoint doesn't need its own MCP call
    if (result?.content?.[0]?.text) {
      try {
        const quotes = JSON.parse(result.content[0].text);
        for (const key of Object.keys(quotes)) {
          if (quotes[key]?.instrument_token && !rrgTokenCache[key]) {
            rrgTokenCache[key] = String(quotes[key].instrument_token);
          }
        }
      } catch (e) { /* ignore parse errors */ }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sector Constituents ────────────────────────────────────────
const sectorConstituentsCache = {}; // { sectorKey: { data, timestamp } }
const SECTOR_CONSTITUENTS_TTL = 30 * 60 * 1000; // 30 min

// Instrument tokens are static, but we normally read them off the live quote.
// A constituent that isn't quoting (trading halt, special session, corporate
// action — e.g. PFOCUS) is absent from get_quotes and so arrives token-less,
// which makes the FE skip its entire 3Y history + indicators. Recover the token
// from the instruments master, keyed by ISIN (unambiguous) then NSE:symbol id.
// Cached for the process lifetime since tokens never change.
const masterTokenCache = {}; // { 'NSE:SYMBOL': '3454977' }

async function resolveTokenFromMaster(isin, key) {
  if (masterTokenCache[key]) return masterTokenCache[key];
  const attempts = [];
  if (isin) attempts.push({ query: isin, filter_on: 'isin' });
  attempts.push({ query: key, filter_on: 'id' });
  for (const args of attempts) {
    try {
      const result = await callWithTimeout({ name: 'search_instruments', arguments: { ...args, limit: 5 } }, 8000);
      const parsed = parseMcpText(result);
      const list = Array.isArray(parsed) ? parsed : (parsed?.data || []);
      // Prefer the exact NSE equity row; fall back to the id match, then first.
      const row = list.find(r => r.exchange === 'NSE' && r.instrument_type === 'EQ')
        || list.find(r => r.id === key)
        || list[0];
      if (row?.instrument_token) {
        const tok = String(row.instrument_token);
        masterTokenCache[key] = tok;
        return tok;
      }
    } catch (e) { /* try next strategy */ }
  }
  return null;
}

// Resolve a list of {symbol, name, isin} rows into displayable constituents
// with a live token + last_price: NSE quote first, then a BSE fallback for
// NSE-dark names (suspension/special session — e.g. PFOCUS), then the static
// instruments master. Shape: { symbol, name, isin, key, token, lastPrice,
// previousClose }. Shared by sector drill-downs and user-defined theme baskets.
async function resolveConstituentsFromRows(rows) {
  if (!rows || rows.length === 0) return [];

  const instruments = rows.map(r => `NSE:${r.symbol}`);
  const quoteResult = await callWithTimeout({ name: 'get_quotes', arguments: { instruments } });
  const quotes = parseMcpText(quoteResult) || {};

  // Populate rrgTokenCache as side-effect
  for (const key of Object.keys(quotes)) {
    if (quotes[key]?.instrument_token) rrgTokenCache[key] = String(quotes[key].instrument_token);
  }

  const constituents = rows.map(r => {
    const key = `NSE:${r.symbol}`;
    const q = quotes[key];
    return {
      symbol: r.symbol,
      name: r.name,
      isin: r.isin,
      key,
      token: q?.instrument_token ? String(q.instrument_token) : null,
      lastPrice: q?.last_price ?? null,
      previousClose: q?.ohlc?.close ?? null,
    };
  });

  // Backfill any constituent the NSE quote didn't cover: try BSE (same ISIN),
  // then the static NSE token from the instruments master.
  const missing = constituents.filter(c => !c.token);
  if (missing.length) {
    let bseQuotes = {};
    try {
      const bseKeys = missing.map(c => `BSE:${c.symbol}`);
      const bseResult = await callWithTimeout({ name: 'get_quotes', arguments: { instruments: bseKeys } });
      bseQuotes = parseMcpText(bseResult) || {};
    } catch (e) { /* fall through to master resolution */ }

    await Promise.all(missing.map(async (c) => {
      const bq = bseQuotes[`BSE:${c.symbol}`];
      if (bq?.instrument_token) {
        c.token = String(bq.instrument_token);
        c.lastPrice = bq.last_price ?? c.lastPrice;
        c.previousClose = bq.ohlc?.close ?? c.previousClose;
        rrgTokenCache[c.key] = c.token;
        return;
      }
      const token = await resolveTokenFromMaster(c.isin, c.key);
      if (token) {
        c.token = token;
        rrgTokenCache[c.key] = token;
      }
    }));
  }

  return constituents;
}

// Resolves a sector's constituent list (from the sector_constituents table).
// Returns { sector, constituents }. lastPrice is stripped by the endpoint.
async function resolveSectorConstituents(sectorKey) {
  if (!supabase) throw new Error('Supabase not configured');

  let rows;
  const cached = sectorConstituentsCache[sectorKey];
  if (cached && Date.now() - cached.timestamp < SECTOR_CONSTITUENTS_TTL) {
    rows = cached.data;
  } else {
    const { data, error } = await supabase
      .from('sector_constituents')
      .select('*')
      .eq('sector_key', sectorKey)
      .order('sort_order');

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      const e = new Error(`No constituents for ${sectorKey}`);
      e.statusCode = 404;
      throw e;
    }
    rows = data;
    sectorConstituentsCache[sectorKey] = { data: rows, timestamp: Date.now() };
  }

  const constituents = await resolveConstituentsFromRows(rows);
  return { sector: sectorKey, constituents };
}

app.get('/api/sector-constituents/:sector', async (req, res) => {
  try {
    const sectorKey = decodeURIComponent(req.params.sector);
    const { sector, constituents } = await resolveSectorConstituents(sectorKey);
    // Strip lastPrice for back-compat with the existing FE consumer.
    const payload = {
      sector,
      constituents: constituents.map(({ lastPrice, ...rest }) => rest),
    };
    res.json(payload);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    console.error('sector-constituents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Sector Technical Alerts ────────────────────────────────────
// Per-sector cache so the 60s frontend refresh doesn't recompute everything.
// TTL slightly longer than the FE refresh interval so concurrent navigations
// (or window-focus refetches) hit the cache instead of recomputing.
const sectorAlertsCache = {};        // { sectorKey: { data, timestamp } }
const SECTOR_ALERTS_TTL = 60 * 1000; // 60s
const sectorAlertsPromises = {};     // in-flight coalescing

// Compute technical alerts for an already-resolved constituents list. Requires
// each token's full history to be warmed in historicalFullCache (the Stocks tab
// fetches /api/historical-full/:token, which populates it). Shared by sector
// drill-downs and theme baskets. `label` is echoed into summary.sector.
async function buildAlertsFromConstituents(constituents, label) {
  const alerts = [];
  const notReady = [];

  for (const c of constituents) {
    if (!c.token) {
      notReady.push(c.symbol);
      continue;
    }
    const candles = historicalFullCache[c.token]?.data;
    if (!Array.isArray(candles) || candles.length < 15) {
      notReady.push(c.symbol);
      continue;
    }
    try { await refreshTodayCandle_FullHistory(c.token); } catch { /* ignore */ }
    const candlesAfterRefresh = historicalFullCache[c.token]?.data || candles;

    const alert = await computeStockAlert({
      symbol: c.symbol,
      token: c.token,
      lastPrice: c.lastPrice,
      previousClose: c.previousClose,
      candles: candlesAfterRefresh,
      sector: label,
    });
    if (alert) alerts.push(alert);
  }

  return {
    alerts,
    summary: {
      sector: label,
      totalConstituents: constituents.length,
      readyCount: alerts.length,
      notReady,
      flagCounts: {
        avoid: alerts.filter(a => a.tradePlan?.action === 'AVOID').length,
        trim:  alerts.filter(a => a.tradePlan?.action === 'TRIM').length,
        add:   alerts.filter(a => a.tradePlan?.action === 'ADD').length,
      },
    },
  };
}

async function computeSectorAlertsPayload(sectorKey) {
  const { constituents } = await resolveSectorConstituents(sectorKey);
  const data = await buildAlertsFromConstituents(constituents, sectorKey);
  sectorAlertsCache[sectorKey] = { data, timestamp: Date.now() };
  return data;
}

app.get('/api/sector-alerts/:sector', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const sectorKey = decodeURIComponent(req.params.sector);

    const cached = sectorAlertsCache[sectorKey];
    if (cached && Date.now() - cached.timestamp < SECTOR_ALERTS_TTL) {
      return res.json(cached.data);
    }

    // Coalesce concurrent in-flight computations for the same sector.
    if (!sectorAlertsPromises[sectorKey]) {
      sectorAlertsPromises[sectorKey] = computeSectorAlertsPayload(sectorKey)
        .finally(() => { delete sectorAlertsPromises[sectorKey]; });
    }

    const data = await sectorAlertsPromises[sectorKey];
    res.json(data);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    if (err.statusCode === 429) return res.status(429).set('Retry-After', String(err.retryAfter || 5)).json({ error: 'rate_limited', retryAfter: err.retryAfter || 5 });
    console.error('sector-alerts error:', err);
    res.status(500).json({ error: 'Failed to compute sector alerts: ' + err.message });
  }
});

// ─── Synthetic Sector Composite Index ───────────────────────────
// Some sectors (e.g. NSE:NIFTY CAPITAL GOODS) have no tradable Kite index
// instrument, so there's no quote/historical level to plot on the Indices
// Performance page. This builds an EQUAL-WEIGHTED composite from the sector's
// constituents: chain the cross-sectional average of each name's daily return,
// rebased to 1000. Averaging *returns* (not prices) per day means names with
// different history lengths or recent IPOs slot in cleanly as they appear,
// without distorting the level. Output mirrors /api/historical-full (an array
// of { date, close }) plus the derived last/prev close for the 1D figure.
const sectorCompositeCache = {};         // { sectorKey: { data, timestamp } }
const SECTOR_COMPOSITE_TTL = 10 * 60 * 1000; // 10 min — matches the page's cadence

function buildEqualWeightComposite(seriesByToken) {
  // seriesByToken: Map<token, Array<{date, close}>>. Build date -> {token -> close}.
  const closeByDate = new Map();
  for (const arr of seriesByToken.values()) {
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      if (c == null || c.close == null || !c.date) continue;
      const day = String(c.date).slice(0, 10);
      let m = closeByDate.get(day);
      if (!m) { m = new Map(); closeByDate.set(day, m); }
      m.set(arr, c.close); // key by the series ref (one entry per constituent)
    }
  }
  const dates = [...closeByDate.keys()].sort();
  const prevClose = new Map();  // series ref -> last seen close
  let index = 1000;
  const out = [];
  for (const day of dates) {
    const todays = closeByDate.get(day);
    const rets = [];
    for (const [ref, close] of todays.entries()) {
      const prev = prevClose.get(ref);
      if (prev != null && prev > 0) rets.push(close / prev - 1);
    }
    for (const [ref, close] of todays.entries()) prevClose.set(ref, close);
    if (rets.length > 0) {
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      index = index * (1 + avg);
    }
    out.push({ date: day, close: +index.toFixed(2) });
  }
  return out;
}

async function computeSectorComposite(sectorKey) {
  const { constituents } = await resolveSectorConstituents(sectorKey);
  const seriesByToken = new Map();
  let used = 0;
  for (const c of constituents) {
    if (!c.token) continue;
    try {
      const { data, cached } = await getOrFetchFullHistory(c.token);
      if (Array.isArray(data) && data.length > 0) {
        seriesByToken.set(c.token, data.map(d => ({ date: d.date, close: d.close })));
        used++;
      }
      // Space out only the cold upstream fetches to respect the rate limit.
      if (!cached) await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      if (e.statusCode === 429) throw e; // bubble rate-limits to the caller
      console.warn(`composite: history failed for ${c.symbol}:`, e.message);
    }
  }
  const series = buildEqualWeightComposite(seriesByToken);
  const lastClose = series.length ? series[series.length - 1].close : null;
  const prevClose = series.length >= 2 ? series[series.length - 2].close : null;
  return {
    sector: sectorKey,
    series,
    lastClose,
    prevClose,
    constituentsUsed: used,
    constituentsTotal: constituents.length,
    method: 'equal-weight-return, base 1000',
  };
}

app.get('/api/sector-composite/:sector', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: 'MCP not connected' });
  try {
    const sectorKey = decodeURIComponent(req.params.sector);
    const cached = sectorCompositeCache[sectorKey];
    if (cached && Date.now() - cached.timestamp < SECTOR_COMPOSITE_TTL) {
      return res.json(cached.data);
    }
    const data = await computeSectorComposite(sectorKey);
    sectorCompositeCache[sectorKey] = { data, timestamp: Date.now() };
    res.json(data);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    if (err.statusCode === 429) return res.status(429).set('Retry-After', String(err.retryAfter || 5)).json({ error: 'rate_limited', retryAfter: err.retryAfter || 5 });
    console.error('sector-composite error:', err);
    res.status(500).json({ error: 'Failed to compute sector composite: ' + err.message });
  }
});

// ─── Thematic Baskets (user-defined themes) ─────────────────────
// A "theme" is a user-curated basket of instruments, persisted in Supabase
// (themes + theme_instruments). Constituents and technical alerts reuse the
// exact sector pipeline (resolveConstituentsFromRows / buildAlertsFromConstituents)
// so the theme detail page can reuse the Sector-Detail table + alerts UI.
const themeAlertsCache = {};         // { themeId: { data, timestamp } }
const THEME_ALERTS_TTL = 60 * 1000;

async function getThemeWithRows(themeId) {
  const { data: theme, error: tErr } = await supabase
    .from('themes').select('*').eq('id', themeId).single();
  if (tErr || !theme) { const e = new Error('Theme not found'); e.statusCode = 404; throw e; }
  const { data: rows, error } = await supabase
    .from('theme_instruments').select('*').eq('theme_id', themeId)
    .order('sort_order').order('created_at');
  if (error) throw new Error(error.message);
  return { theme, rows: rows || [] };
}

// List themes with instrument counts.
app.get('/api/themes', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { data: themes, error } = await supabase
      .from('themes').select('*').order('sort_order').order('created_at');
    if (error) throw new Error(error.message);
    const { data: insts } = await supabase.from('theme_instruments').select('theme_id');
    const counts = {};
    (insts || []).forEach(i => { counts[i.theme_id] = (counts[i.theme_id] || 0) + 1; });
    res.json({ themes: (themes || []).map(t => ({ ...t, instrumentCount: counts[t.id] || 0 })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create a theme.
app.post('/api/themes', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Theme name is required' });
  try {
    const { data, error } = await supabase.from('themes').insert({ name }).select().single();
    if (error) throw new Error(error.message);
    res.json({ theme: { ...data, instrumentCount: 0 } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rename a theme.
app.patch('/api/themes/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Theme name is required' });
  try {
    const { data, error } = await supabase
      .from('themes').update({ name }).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Theme not found' });
    res.json({ theme: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a theme (cascade removes its instruments via the FK).
app.delete('/api/themes/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { error } = await supabase.from('themes').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    delete themeAlertsCache[req.params.id];
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add an instrument to a theme.
app.post('/api/themes/:id/instruments', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { symbol, name, isin, exchange } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  try {
    const { data, error } = await supabase.from('theme_instruments').insert({
      theme_id: req.params.id,
      symbol: symbol.toString().toUpperCase(),
      name: name || symbol,
      isin: isin || null,
      exchange: (exchange || 'NSE').toString().toUpperCase(),
    }).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Already in this theme' });
      throw new Error(error.message);
    }
    delete themeAlertsCache[req.params.id];
    res.json({ instrument: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove an instrument from a theme.
app.delete('/api/themes/:id/instruments/:instrumentId', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { error } = await supabase.from('theme_instruments')
      .delete().eq('id', req.params.instrumentId).eq('theme_id', req.params.id);
    if (error) throw new Error(error.message);
    delete themeAlertsCache[req.params.id];
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resolve a theme's constituents (same shape as /api/sector-constituents, plus
// each row's instrumentId so the FE can delete it). lastPrice is stripped.
app.get('/api/themes/:id/constituents', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!mcpClient) return res.status(500).json({ error: 'MCP not connected' });
  try {
    const { theme, rows } = await getThemeWithRows(req.params.id);
    const constituents = await resolveConstituentsFromRows(rows);
    const idByKey = {};
    rows.forEach(r => { idByKey[`NSE:${r.symbol.toUpperCase()}`] = r.id; });
    res.json({
      theme: { id: theme.id, name: theme.name },
      constituents: constituents.map(({ lastPrice, ...rest }) => ({ ...rest, instrumentId: idByKey[rest.key] || null })),
    });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Theme technical alerts (same shape as /api/sector-alerts).
app.get('/api/themes/:id/alerts', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!mcpClient) return res.status(500).json({ error: 'MCP not connected' });
  try {
    const id = req.params.id;
    const cached = themeAlertsCache[id];
    if (cached && Date.now() - cached.timestamp < THEME_ALERTS_TTL) return res.json(cached.data);

    const { theme, rows } = await getThemeWithRows(id);
    const constituents = await resolveConstituentsFromRows(rows);
    const data = await buildAlertsFromConstituents(constituents, theme.name);
    themeAlertsCache[id] = { data, timestamp: Date.now() };
    res.json(data);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    if (err.statusCode === 429) return res.status(429).set('Retry-After', String(err.retryAfter || 5)).json({ error: 'rate_limited', retryAfter: err.retryAfter || 5 });
    console.error('theme-alerts error:', err);
    res.status(500).json({ error: 'Failed to compute theme alerts: ' + err.message });
  }
});

// ─── Virtual ("paper") portfolios ───────────────────────────────
// User-defined buckets of hypothetical holdings (symbol + avg cost + qty).
// LTP / day-change come live from quotes; everything else is derived FE-side.
// Run `node migrate_portfolios.js` once to create the tables.

async function getPortfolioWithRows(portfolioId) {
  const { data: portfolio, error: pErr } = await supabase
    .from('portfolios').select('*').eq('id', portfolioId).single();
  if (pErr || !portfolio) { const e = new Error('Portfolio not found'); e.statusCode = 404; throw e; }
  const { data: rows, error } = await supabase
    .from('portfolio_holdings').select('*').eq('portfolio_id', portfolioId)
    .order('sort_order').order('created_at');
  if (error) throw new Error(error.message);
  return { portfolio, rows: rows || [] };
}

// List portfolios with holding counts.
app.get('/api/portfolios', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { data: portfolios, error } = await supabase
      .from('portfolios').select('*').order('sort_order').order('created_at');
    if (error) throw new Error(error.message);
    const { data: holdings } = await supabase.from('portfolio_holdings').select('portfolio_id');
    const counts = {};
    (holdings || []).forEach(h => { counts[h.portfolio_id] = (counts[h.portfolio_id] || 0) + 1; });
    res.json({ portfolios: (portfolios || []).map(p => ({ ...p, holdingsCount: counts[p.id] || 0 })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create a portfolio.
app.post('/api/portfolios', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Portfolio name is required' });
  try {
    const { data, error } = await supabase.from('portfolios').insert({ name }).select().single();
    if (error) throw new Error(error.message);
    res.json({ portfolio: { ...data, holdingsCount: 0 } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rename a portfolio.
app.patch('/api/portfolios/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Portfolio name is required' });
  try {
    const { data, error } = await supabase
      .from('portfolios').update({ name }).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Portfolio not found' });
    res.json({ portfolio: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a portfolio (cascade removes its holdings via the FK).
app.delete('/api/portfolios/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { error } = await supabase.from('portfolios').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add a holding to a portfolio. If the same symbol already exists, the new lot
// is merged into it: quantities add and the average cost becomes the
// quantity-weighted average of the two lots (like a real averaging-up/down).
app.post('/api/portfolios/:id/holdings', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { symbol, name, isin, exchange, avgCost, quantity } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  const sym = symbol.toString().toUpperCase();
  const addCost = Number(avgCost) || 0;
  const addQty = Number(quantity) || 0;
  try {
    const { data: existing, error: findErr } = await supabase
      .from('portfolio_holdings')
      .select('*')
      .eq('portfolio_id', req.params.id)
      .eq('symbol', sym)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);

    if (existing) {
      const exQty = Number(existing.quantity) || 0;
      const exCost = Number(existing.avg_cost) || 0;
      const newQty = exQty + addQty;
      // Weighted average of the combined cost basis. Fall back to whichever cost
      // is known if the combined quantity is zero (avoids divide-by-zero).
      const newAvg = newQty > 0
        ? Number((((exCost * exQty) + (addCost * addQty)) / newQty).toFixed(4))
        : (addCost || exCost);
      const { data, error } = await supabase.from('portfolio_holdings')
        .update({ quantity: newQty, avg_cost: newAvg })
        .eq('id', existing.id)
        .select().single();
      if (error) throw new Error(error.message);
      return res.json({ holding: data, merged: true });
    }

    const { data, error } = await supabase.from('portfolio_holdings').insert({
      portfolio_id: req.params.id,
      symbol: sym,
      name: name || symbol,
      isin: isin || null,
      exchange: (exchange || 'NSE').toString().toUpperCase(),
      avg_cost: addCost,
      quantity: addQty,
    }).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Already in this portfolio' });
      throw new Error(error.message);
    }
    res.json({ holding: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update a holding's average cost and/or quantity.
app.patch('/api/portfolios/:id/holdings/:holdingId', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const updates = {};
  if (req.body?.avgCost != null) updates.avg_cost = Number(req.body.avgCost) || 0;
  if (req.body?.quantity != null) updates.quantity = Number(req.body.quantity) || 0;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const { data, error } = await supabase.from('portfolio_holdings')
      .update(updates).eq('id', req.params.holdingId).eq('portfolio_id', req.params.id)
      .select().single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Holding not found' });
    res.json({ holding: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove a holding from a portfolio.
app.delete('/api/portfolios/:id/holdings/:holdingId', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { error } = await supabase.from('portfolio_holdings')
      .delete().eq('id', req.params.holdingId).eq('portfolio_id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resolve a portfolio's holdings with live LTP + previous close, merged with the
// stored avg cost / quantity. Derived columns (invested, P&L, allocation…) are
// computed on the frontend so they stay live as the user edits inputs.
app.get('/api/portfolios/:id/holdings', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (!mcpClient) return res.status(500).json({ error: 'MCP not connected' });
  try {
    const { portfolio, rows } = await getPortfolioWithRows(req.params.id);
    const constituents = await resolveConstituentsFromRows(rows);
    const bySymbol = {};
    constituents.forEach(c => { bySymbol[c.symbol] = c; });
    const holdings = rows.map(r => {
      const c = bySymbol[r.symbol] || {};
      return {
        id: r.id,
        symbol: r.symbol,
        name: r.name,
        exchange: r.exchange,
        token: c.token || null,
        avgCost: Number(r.avg_cost) || 0,
        quantity: Number(r.quantity) || 0,
        ltp: c.lastPrice ?? null,
        previousClose: c.previousClose ?? null,
      };
    });
    res.json({ portfolio: { id: portfolio.id, name: portfolio.name }, holdings });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Instrument notes (free-text per company) ───────────────────
// One note per trading symbol, persisted in Supabase (instrument_notes).
// Run `node migrate_notes.js` once to create the table.
app.get('/api/notes/:symbol', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const symbol = req.params.symbol.toUpperCase();
  try {
    const { data, error } = await supabase
      .from('instrument_notes').select('note, updated_at').eq('symbol', symbol).maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ symbol, note: data?.note || '', updatedAt: data?.updated_at || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/notes/:symbol', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const symbol = req.params.symbol.toUpperCase();
  const note = (req.body?.note ?? '').toString();
  try {
    const { data, error } = await supabase
      .from('instrument_notes')
      .upsert({ symbol, note, updated_at: new Date().toISOString() }, { onConflict: 'symbol' })
      .select('note, updated_at').single();
    if (error) throw new Error(error.message);
    res.json({ symbol, note: data.note, updatedAt: data.updated_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/notes/:symbol', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const symbol = req.params.symbol.toUpperCase();
  try {
    const { error } = await supabase.from('instrument_notes').delete().eq('symbol', symbol);
    if (error) throw new Error(error.message);
    res.json({ symbol, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Strategy Backtester ──────────────────────────────────────
// Replays pure per-bar strategy rules (backend/backtest/) over the same 4Y
// candle caches the rest of the app uses. Engine is O(n) per stock — see
// backtest/engine.js for the execution model (next-open fills, pessimistic
// intrabar stops, flat round-trip cost). UI is currently unwired (replaced by
// the Custom Screener); the API stays available.
const { runBacktest } = require('./backtest/engine');
const { STRATEGIES, publicStrategyList } = require('./backtest/strategies');
const { computeMetrics: computeBacktestMetrics } = require('./backtest/metrics');

const MIN_BACKTEST_BARS = 260; // breakout warmup needs less; supertrend needs 210 + headroom

app.get('/api/backtest/strategies', (req, res) => {
  res.json({ strategies: publicStrategyList() });
});

app.post('/api/backtest/run', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  const { token, symbol, strategyId, params = {} } = req.body || {};
  if (!token || !strategyId) return res.status(400).json({ error: 'token and strategyId are required' });
  if (!STRATEGIES[strategyId]) return res.status(400).json({ error: `Unknown strategy "${strategyId}"` });
  const costPct = Number.isFinite(Number(req.body?.costPct)) ? Number(req.body.costPct) : 0.25;
  const capitalPerTrade = Number(req.body?.capitalPerTrade) > 0 ? Number(req.body.capitalPerTrade) : 100000;
  try {
    const { data: candles } = await getOrFetchFullHistory(String(token));
    if (!Array.isArray(candles) || candles.length < MIN_BACKTEST_BARS) {
      return res.status(422).json({ error: `Insufficient history to backtest (${candles?.length || 0} bars, need ≥ ${MIN_BACKTEST_BARS})` });
    }
    const result = runBacktest({ candles, strategyId, params, costPct, capitalPerTrade });
    res.json({ symbol: symbol || null, token: String(token), ...result });
  } catch (err) {
    if (err.statusCode === 429) return res.status(429).set('Retry-After', String(err.retryAfter || 5)).json({ error: 'rate_limited', retryAfter: err.retryAfter || 5 });
    console.error('[backtest/run]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Basket backtests run as async in-memory jobs: a cold basket needs up to
// ~50 rate-limited multi-year MCP fetches (minutes), far beyond an HTTP
// timeout. Mirrors the historicalFullWarming progress pattern.
const backtestJobs = {};  // jobId -> { id, status, progress, result, error, createdAt }
let backtestJobSeq = 0;

async function resolveBasketConstituents(scope) {
  if (scope?.type === 'sector') {
    if (!scope.sectorKey) throw new Error('sectorKey required for sector scope');
    const { constituents } = await resolveSectorConstituents(scope.sectorKey);
    return { label: scope.sectorKey, list: constituents };
  }
  if (scope?.type === 'theme') {
    if (!scope.themeId) throw new Error('themeId required for theme scope');
    const { theme, rows } = await getThemeWithRows(scope.themeId);
    const constituents = await resolveConstituentsFromRows(rows);
    return { label: theme.name, list: constituents };
  }
  if (scope?.type === 'holdings') {
    const holdingsResult = await fetchWithCache("get_holdings", "holdings", {});
    let holdings = [];
    if (holdingsResult?.content?.[0]?.text) {
      const parsed = JSON.parse(holdingsResult.content[0].text);
      holdings = parsed.data || parsed;
    }
    if (!Array.isArray(holdings) || holdings.length === 0) throw new Error('No holdings available');
    return {
      label: 'Holdings',
      list: holdings.map(h => ({
        symbol: h.tradingsymbol,
        token: h.instrument_token ? String(h.instrument_token) : null,
      })),
    };
  }
  throw new Error(`Unknown scope type "${scope?.type}"`);
}

// Equal-weight aggregation: capitalPerTrade allocated independently per stock;
// aggregate curve = date-aligned sum of per-stock curves (forward-filled, and
// seeded at per-stock capital before a stock's curve starts); trade stats are
// pooled; CAGR/maxDD computed on the summed curve.
function aggregateBasket(perStockFull, capitalPerTrade) {
  const dateSet = new Set();
  for (const s of perStockFull) for (const pt of s.result.equityCurve) dateSet.add(pt.date);
  const dates = [...dateSet].sort();

  const eqMaps = perStockFull.map(s => new Map(s.result.equityCurve.map(pt => [pt.date, pt.equity])));
  const bhMaps = perStockFull.map(s => new Map(s.result.buyHoldCurve.map(pt => [pt.date, pt.equity])));
  const lastEq = perStockFull.map(() => capitalPerTrade);
  const lastBh = perStockFull.map(() => capitalPerTrade);

  const equityCurve = [];
  const buyHoldCurve = [];
  for (const d of dates) {
    let se = 0, sb = 0;
    for (let i = 0; i < perStockFull.length; i++) {
      const e = eqMaps[i].get(d);
      if (e !== undefined) lastEq[i] = e;
      const b = bhMaps[i].get(d);
      if (b !== undefined) lastBh[i] = b;
      se += lastEq[i];
      sb += lastBh[i];
    }
    equityCurve.push({ date: d, equity: +se.toFixed(2) });
    buyHoldCurve.push({ date: d, equity: +sb.toFixed(2) });
  }
  let peak = -Infinity;
  for (const pt of equityCurve) {
    peak = Math.max(peak, pt.equity);
    pt.drawdownPct = peak > 0 ? +(((pt.equity - peak) / peak) * 100).toFixed(2) : 0;
  }

  const pooledTrades = perStockFull.flatMap(s => s.result.trades);
  const totalBars = perStockFull.reduce((s, x) => s + x.result.evaluatedBars, 0);
  const barsInMarket = perStockFull.reduce((s, x) =>
    s + (x.result.metrics.exposurePct != null ? (x.result.metrics.exposurePct / 100) * x.result.evaluatedBars : 0), 0);
  const metrics = computeBacktestMetrics(pooledTrades, equityCurve, buyHoldCurve, { barsInMarket, totalBars });
  return { metrics, equityCurve, buyHoldCurve };
}

async function runBasketJob(job, { scope, strategyId, params, costPct, capitalPerTrade }) {
  const { label, list } = await resolveBasketConstituents(scope);
  job.progress.total = list.length;

  const perStockFull = [];
  const skipped = [];
  for (const c of list) {
    job.progress.symbol = c.symbol;
    try {
      if (!c.token) { skipped.push(c.symbol); continue; }
      const token = String(c.token);
      const warm = historicalFullCache[token] && (Date.now() - historicalFullCache[token].timestamp < HISTORICAL_FULL_TTL);
      const { data: candles } = await getOrFetchFullHistory(token);
      // Same rate-limit discipline as prewarmRrgHistoricalCache: only space out
      // requests when we actually hit the upstream.
      if (!warm) await new Promise(r => setTimeout(r, 800));
      if (!Array.isArray(candles) || candles.length < MIN_BACKTEST_BARS) { skipped.push(c.symbol); continue; }
      const t0 = Date.now();
      const result = runBacktest({ candles, strategyId, params, costPct, capitalPerTrade });
      if (Date.now() - t0 > 100) console.log(`  ⚠️ [backtest] slow engine run for ${c.symbol}: ${Date.now() - t0}ms`);
      perStockFull.push({ symbol: c.symbol, token, result });
    } catch (e) {
      console.log(`  ⚠️ [backtest/basket] ${c.symbol}: ${e.message}`);
      skipped.push(c.symbol);
    } finally {
      job.progress.loaded++;
    }
  }

  if (perStockFull.length === 0) throw new Error(`No constituent had enough history to backtest (${skipped.length} skipped)`);

  const aggregate = aggregateBasket(perStockFull, capitalPerTrade);
  const perStock = perStockFull.map(s => ({
    symbol: s.symbol,
    token: s.token,
    trades: s.result.trades.length,
    winRate: s.result.metrics.winRate,
    profitFactor: s.result.metrics.profitFactor,
    totalReturnPct: s.result.metrics.totalReturnPct,
    cagr: s.result.metrics.cagr,
    maxDrawdownPct: s.result.metrics.maxDrawdownPct,
    buyHoldReturnPct: s.result.metrics.buyHold.totalReturnPct,
    totalPnl: +s.result.trades.reduce((a, t) => a + t.pnl, 0).toFixed(2),
    openPosition: !!s.result.openPosition,
    fromDate: s.result.fromDate,
    toDate: s.result.toDate,
  }));

  return {
    kind: 'basket',
    label,
    scope,
    strategyId,
    params: perStockFull[0].result.params,
    costPct,
    capitalPerTrade,
    aggregate,
    perStock,
    skipped,
    generatedAt: new Date().toISOString(),
  };
}

app.post('/api/backtest/basket', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  const { scope, strategyId, params = {} } = req.body || {};
  if (!scope?.type) return res.status(400).json({ error: 'scope.type is required (sector | theme | holdings)' });
  if (!STRATEGIES[strategyId]) return res.status(400).json({ error: `Unknown strategy "${strategyId}"` });
  const costPct = Number.isFinite(Number(req.body?.costPct)) ? Number(req.body.costPct) : 0.25;
  const capitalPerTrade = Number(req.body?.capitalPerTrade) > 0 ? Number(req.body.capitalPerTrade) : 100000;

  // Prune finished jobs beyond the 20 newest.
  const ids = Object.keys(backtestJobs).sort((a, b) => backtestJobs[a].createdAt - backtestJobs[b].createdAt);
  for (const id of ids.slice(0, Math.max(0, ids.length - 20))) {
    if (backtestJobs[id].status !== 'running') delete backtestJobs[id];
  }

  const jobId = `bt${++backtestJobSeq}-${Date.now().toString(36)}`;
  const job = { id: jobId, status: 'running', progress: { loaded: 0, total: 0, symbol: null }, result: null, error: null, createdAt: Date.now() };
  backtestJobs[jobId] = job;

  runBasketJob(job, { scope, strategyId, params, costPct, capitalPerTrade })
    .then(result => { job.result = result; job.status = 'done'; })
    .catch(e => { job.status = 'error'; job.error = e.message; console.error('[backtest/basket]', e.message); });

  res.json({ jobId });
});

app.get('/api/backtest/basket/:jobId', (req, res) => {
  const job = backtestJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found (jobs are in-memory and pruned on restart)' });
  res.json({
    status: job.status,
    progress: job.progress,
    ...(job.status === 'done' ? { result: job.result } : {}),
    ...(job.status === 'error' ? { error: job.error } : {}),
  });
});

// Distinct sector keys for scope dropdowns (screener + backtest basket).
const sectorsListCache = { data: null, ts: 0 };
app.get('/api/sectors', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  if (sectorsListCache.data && Date.now() - sectorsListCache.ts < 60 * 60 * 1000) {
    return res.json(sectorsListCache.data);
  }
  try {
    const { data, error } = await supabase.from('sector_constituents').select('sector_key');
    if (error) throw new Error(error.message);
    const sectors = [...new Set((data || []).map(r => r.sector_key))].sort();
    const payload = { sectors };
    sectorsListCache.data = payload;
    sectorsListCache.ts = Date.now();
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Saved backtest runs (Supabase: backtest_runs — see migrate_backtests.js) ──
app.post('/api/backtest/runs', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { kind, label, symbol, token, scope, strategyId, params, metrics, result, fromDate, toDate } = req.body || {};
  if (!kind || !label || !strategyId || !metrics || !result) {
    return res.status(400).json({ error: 'kind, label, strategyId, metrics and result are required' });
  }
  try {
    const { data, error } = await supabase.from('backtest_runs').insert({
      kind,
      label,
      symbol: symbol || null,
      token: token ? String(token) : null,
      scope: scope || null,
      strategy_id: strategyId,
      params: params || {},
      metrics,
      result,
      from_date: fromDate || null,
      to_date: toDate || null,
    }).select('id, kind, label, symbol, strategy_id, metrics, from_date, to_date, created_at').single();
    if (error) throw new Error(error.message);
    res.json({ run: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/backtest/runs', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    // List view never loads the heavy `result` jsonb.
    let q = supabase.from('backtest_runs')
      .select('id, kind, label, symbol, token, scope, strategy_id, params, metrics, from_date, to_date, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (req.query.kind) q = q.eq('kind', req.query.kind);
    if (req.query.symbol) q = q.eq('symbol', String(req.query.symbol).toUpperCase());
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ runs: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/backtest/runs/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { data, error } = await supabase.from('backtest_runs').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Run not found' });
    res.json({ run: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/backtest/runs/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { error } = await supabase.from('backtest_runs').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Macro Economics overview (indiandataproject.org) ──────────
// Free static JSON under Govt Open Data License — no API key, no rate limit.
// Data updates ~quarterly/annually, so a 12h in-memory cache makes this
// endpoint effectively free; no Supabase table or scraper needed. Files live
// under /data/<domain>/<FY>/<file>.json keyed by Indian fiscal-year label.
const IDP_BASE = 'https://indiandataproject.org/data';
const MACRO_TTL_MS = 12 * 60 * 60 * 1000;     // full success
const MACRO_PARTIAL_TTL_MS = 15 * 60 * 1000;  // retry sooner after partial failure
const macroCache = { data: null, ts: 0, ttl: MACRO_TTL_MS, fy: null, lastGood: null };
let macroInflight = null; // coalesce concurrent cold fetches

// Indian FY runs April–March: June 2026 → '2026-27', Feb 2026 → '2025-26'.
function currentIndianFY(d = new Date()) {
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
function previousFY(fy) {
  const start = parseInt(fy.slice(0, 4), 10) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

async function fetchIdpJson(fy, relPath) {
  const url = `${IDP_BASE}/${relPath.replace('{fy}', fy)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status} for ${relPath.replace('{fy}', fy)}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// ── RBI policy supplement ────────────────────────────────────────
// indiandataproject.org's rbi files stopped tracking MPC decisions after
// Feb 2025 — verified June 2026: upstream still reported repo 6.25% while the
// actual rate had been cut to 5.25% (Dec 2025). Curated continuation of the
// decision history from RBI MPC press releases, merged over upstream by date
// (supplement wins on collision). Update when new MPC decisions land
// (bi-monthly: Feb / Apr / Jun / Aug / Oct / Dec).
const RBI_POLICY_SUPPLEMENT = {
  crr: 3.0, // 100bps phased cut announced at the Jun-2025 MPC; upstream still says 4.0
  decisions: [
    { date: '2025-04-09', rate: 6.0,  change: -0.25, stance: 'Accommodative' },
    { date: '2025-06-06', rate: 5.5,  change: -0.5,  stance: 'Neutral' },
    { date: '2025-08-06', rate: 5.5,  change: 0.0,   stance: 'Neutral' },
    { date: '2025-10-01', rate: 5.5,  change: 0.0,   stance: 'Neutral' },
    { date: '2025-12-05', rate: 5.25, change: -0.25, stance: 'Neutral' },
    { date: '2026-02-06', rate: 5.25, change: 0.0,   stance: 'Neutral' },
    { date: '2026-04-08', rate: 5.25, change: 0.0,   stance: 'Neutral' },
    { date: '2026-06-05', rate: 5.25, change: 0.0,   stance: 'Neutral' },
  ],
};

// Live "Current Rates" table scraped off the rbi.org.in homepage — keeps the
// headline repo rate correct even when BOTH the upstream dataset and the
// supplement above go stale, and lets us flag an incomplete decision history
// (live rate ≠ last known decision). Best-effort: returns null on any failure.
async function fetchRbiLiveRates() {
  try {
    const r = await fetch('https://www.rbi.org.in/', {
      headers: SCREENER_FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const grab = (label) => {
      const m = html.match(new RegExp('<th>\\s*' + label + '\\s*</th>\\s*<td>\\s*:?\\s*([0-9.]+)%', 'i'));
      return m ? parseFloat(m[1]) : null;
    };
    const repoRate = grab('Policy Repo Rate');
    if (repoRate == null) return null; // layout changed — treat as unavailable
    return {
      repoRate,
      sdf: grab('Standing Deposit Facility Rate'),
      msf: grab('Marginal Standing Facility Rate'),
      slr: grab('SLR'),
    };
  } catch {
    return null;
  }
}

// Probe economy/<fy>/summary.json for the current FY, fall back to previous
// (the source publishes a new FY folder only after the Economic Survey drops).
// Returns { fy, summary } so the probe result is reused, not re-fetched.
async function resolveMacroFY() {
  const fyNow = currentIndianFY();
  for (const fy of [fyNow, previousFY(fyNow)]) {
    try {
      const summary = await fetchIdpJson(fy, 'economy/{fy}/summary.json');
      return { fy, summary };
    } catch { /* try previous FY */ }
  }
  throw new Error('No usable fiscal-year folder found upstream');
}

async function buildMacroPayload() {
  const { fy, summary } = await resolveMacroFY();

  const FILES = {
    gdpGrowth: 'economy/{fy}/gdp-growth.json',
    inflation: 'economy/{fy}/inflation.json',
    fiscal: 'economy/{fy}/fiscal.json',
    external: 'economy/{fy}/external.json',
    sectors: 'economy/{fy}/sectors.json',
    rbiSummary: 'rbi/{fy}/summary.json',
    monetaryPolicy: 'rbi/{fy}/monetary-policy.json',
    forex: 'rbi/{fy}/forex.json',
    credit: 'rbi/{fy}/credit.json',
    liquidity: 'rbi/{fy}/liquidity.json',
  };
  const keys = Object.keys(FILES);
  const [settled, liveRates] = await Promise.all([
    Promise.allSettled(keys.map(k => fetchIdpJson(fy, FILES[k]))),
    fetchRbiLiveRates(), // best-effort; null on failure
  ]);
  const raw = {};
  const errors = [];
  keys.forEach((k, i) => {
    if (settled[i].status === 'fulfilled') raw[k] = settled[i].value;
    else { raw[k] = null; errors.push({ file: FILES[k].replace('{fy}', fy), error: settled[i].reason?.message || 'fetch failed' }); }
  });

  // Merge upstream MPC decisions with the curated supplement (supplement wins
  // on date collision — it's the corrected record). The repo-rate step chart
  // needs ascending dates; upstream is newest-first.
  const decisionsByDate = new Map();
  for (const d of raw.monetaryPolicy?.decisions || []) decisionsByDate.set(d.date, d);
  for (const d of RBI_POLICY_SUPPLEMENT.decisions) decisionsByDate.set(d.date, d);
  const decisions = [...decisionsByDate.values()]
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const latestDecision = decisions[decisions.length - 1] || null;

  // Headline policy fields, freshest layer first: live rbi.org.in scrape →
  // merged decision history → upstream rbi summary.
  const repoRate = liveRates?.repoRate ?? latestDecision?.rate ?? raw.rbiSummary?.repoRate ?? null;
  const stance = latestDecision?.stance ?? raw.rbiSummary?.stance ?? raw.monetaryPolicy?.currentStance ?? null;
  // If the live rate disagrees with the last known decision, the curated
  // history has fallen behind too — surface that to the UI.
  const historyIncomplete = !!(liveRates && latestDecision
    && Math.abs(liveRates.repoRate - latestDecision.rate) > 0.001);

  return {
    fy,
    fetchedAt: new Date().toISOString(),
    stale: false,
    summary: summary ? {
      year: summary.year,
      surveyDate: summary.surveyDate ?? null,
      realGDPGrowth: summary.realGDPGrowth ?? null,
      nominalGDP: summary.nominalGDP ?? null,
      projectedGrowthHigh: summary.projectedGrowthHigh ?? null,
      cpiInflation: summary.cpiInflation ?? null,
      fiscalDeficitPercentGDP: summary.fiscalDeficitPercentGDP ?? null,
      currentAccountDeficitPercentGDP: summary.currentAccountDeficitPercentGDP ?? null,
      perCapitaGDP: summary.perCapitaGDP ?? null,
      lastUpdated: summary.lastUpdated ?? null,
      source: summary.source ?? null,
    } : null,
    policy: (raw.rbiSummary || decisions.length || liveRates) ? {
      repoRate,
      repoRateLive: !!liveRates, // true → headline rate read live off rbi.org.in
      repoRateDate: latestDecision?.date ?? raw.rbiSummary?.repoRateDate ?? null,
      stance,
      crr: RBI_POLICY_SUPPLEMENT.crr ?? raw.rbiSummary?.crr ?? null,
      slr: liveRates?.slr ?? raw.rbiSummary?.slr ?? null,
      sdf: liveRates?.sdf ?? null,
      msf: liveRates?.msf ?? null,
      cpiLatest: raw.rbiSummary?.cpiLatest ?? null,
      forexReservesUSD: raw.rbiSummary?.forexReservesUSD ?? null,
      broadMoneyGrowth: raw.rbiSummary?.broadMoneyGrowth ?? null,
      lastUpdated: raw.rbiSummary?.lastUpdated ?? null,
      historyIncomplete,
      decisions,
    } : null,
    gdpGrowth: raw.gdpGrowth ? { unit: raw.gdpGrowth.unit, series: raw.gdpGrowth.series || [], source: raw.gdpGrowth.source ?? null } : null,
    inflation: raw.inflation ? {
      targetBand: raw.inflation.targetBand ?? null,
      series: raw.inflation.series || [],
      source: raw.inflation.source ?? null,
    } : null,
    fiscal: raw.fiscal ? {
      targetFiscalDeficit: raw.fiscal.targetFiscalDeficit ?? null,
      series: raw.fiscal.series || [],
      source: raw.fiscal.source ?? null,
    } : null,
    external: raw.external ? { series: raw.external.series || [], source: raw.external.source ?? null } : null,
    sectors: raw.sectors?.sectors || null,
    sectorsSource: raw.sectors?.source ?? null,
    forex: raw.forex?.reservesUSD ? {
      series: (raw.forex.reservesUSD.series || []).slice(-20),
      unit: raw.forex.reservesUSD.unit ?? 'USD billion',
      source: raw.forex.reservesUSD.source ?? null,
    } : null,
    rates: (raw.credit || raw.liquidity) ? {
      lendingRate: raw.credit?.lendingRate ?? null,
      depositRate: raw.credit?.depositRate ?? null,
      broadMoneyGrowth: raw.liquidity?.broadMoneyGrowth ?? null,
    } : null,
    errors,
  };
}

app.get('/api/macro-overview', async (req, res) => {
  if (macroCache.data && Date.now() - macroCache.ts < macroCache.ttl) {
    return res.json(macroCache.data);
  }
  try {
    if (!macroInflight) {
      macroInflight = buildMacroPayload().finally(() => { macroInflight = null; });
    }
    const payload = await macroInflight;
    macroCache.data = payload;
    macroCache.ts = Date.now();
    macroCache.fy = payload.fy;
    macroCache.ttl = payload.errors.length ? MACRO_PARTIAL_TTL_MS : MACRO_TTL_MS;
    if (payload.errors.length === 0) macroCache.lastGood = payload;
    res.json(payload);
  } catch (err) {
    console.error('[macro-overview]', err.message);
    // Upstream completely unreachable — serve the last fully-good payload if we have one.
    if (macroCache.lastGood) {
      return res.json({ ...macroCache.lastGood, stale: true });
    }
    res.status(502).json({ error: 'Macro data source unreachable: ' + err.message });
  }
});

// ─── Custom Screener ──────────────────────────────────────────
// Scans a universe (holdings / sector / theme) against user-defined indicator
// conditions. Reuses the backtester's series math (backend/screener/engine.js
// → buildSeries) and the same async-job + rate-limited fetch discipline as
// basket backtests, since a cold universe needs multi-year history per stock.
const { SCREENER_FIELDS, computeScreenerRow, validateConditions, evaluateConditions } = require('./screener/engine');

const MIN_SCREENER_BARS = 60; // enough for RSI/ADX/ST + 20d windows; longer fields go null

app.get('/api/screener/fields', (req, res) => {
  res.json({ fields: SCREENER_FIELDS });
});

const screenerJobs = {};
let screenerJobSeq = 0;

async function runScreenerJob(job, { scope, conditions }) {
  const { label, list } = await resolveBasketConstituents(scope);
  job.progress.total = list.length;

  const matches = [];
  const notReady = [];
  job.matches = matches; // live reference so the status endpoint can stream partials
  // Scan symbols with bounded concurrency. The actual Kite calls stay capped at
  // ~3/sec by reserveHistSlot(), so several symbols can be in flight at once
  // (keeping that budget saturated) without risking a rate-limit breach. Warm
  // (cached) symbols return instantly; cold ones queue at the limiter.
  const SCAN_CONCURRENCY = 6;
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const c = list[cursor++];
      job.progress.symbol = c.symbol;
      try {
        if (!c.token) { notReady.push(c.symbol); continue; }
        const token = String(c.token);
        const candles = await getScreenerHistory(token);
        if (!Array.isArray(candles) || candles.length < MIN_SCREENER_BARS) { notReady.push(c.symbol); continue; }
        const values = computeScreenerRow(candles);
        if (evaluateConditions(values, conditions)) {
          matches.push({ symbol: c.symbol, token, values, name: c.name || null });
        }
      } catch (e) {
        console.log(`  ⚠️ [screener] ${c.symbol}: ${e.message}`);
        notReady.push(c.symbol);
      } finally {
        job.progress.loaded++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, list.length) }, worker));

  // Resolve sector/industry for the matched set only (cached process-wide; the
  // alert engine usually warms holdings already). Chunked so a large cold match
  // set doesn't fan out hundreds of Yahoo calls at once.
  job.progress.symbol = 'resolving sectors…';
  for (let i = 0; i < matches.length; i += 25) {
    const chunk = matches.slice(i, i + 25);
    const [metas, names] = await Promise.all([
      Promise.all(chunk.map(m => getSectorMeta(m.symbol).catch(() => null))),
      // Most universes (sector/theme) already carry a name; only fetch for the
      // ones that don't (e.g. holdings).
      Promise.all(chunk.map(m => m.name ? Promise.resolve(m.name) : resolveInstrumentName(m.symbol).catch(() => null))),
    ]);
    chunk.forEach((m, j) => {
      m.sector = metas[j]?.sector || null;
      m.industry = metas[j]?.industry || null;
      m.name = names[j] || m.name || null;
    });
  }

  return {
    label,
    scope,
    conditions,
    matches,
    scanned: job.progress.total - notReady.length,
    total: job.progress.total,
    notReady,
    generatedAt: new Date().toISOString(),
  };
}

app.post('/api/screener/run', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  const { scope, conditions } = req.body || {};
  if (!scope?.type) return res.status(400).json({ error: 'scope.type is required (sector | theme | holdings)' });
  try {
    validateConditions(conditions);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const ids = Object.keys(screenerJobs).sort((a, b) => screenerJobs[a].createdAt - screenerJobs[b].createdAt);
  for (const id of ids.slice(0, Math.max(0, ids.length - 20))) {
    if (screenerJobs[id].status !== 'running') delete screenerJobs[id];
  }

  const jobId = `sc${++screenerJobSeq}-${Date.now().toString(36)}`;
  const job = { id: jobId, status: 'running', progress: { loaded: 0, total: 0, symbol: null }, result: null, error: null, createdAt: Date.now() };
  screenerJobs[jobId] = job;

  runScreenerJob(job, { scope, conditions })
    .then(result => { job.result = result; job.status = 'done'; })
    .catch(e => { job.status = 'error'; job.error = e.message; console.error('[screener]', e.message); });

  res.json({ jobId });
});

app.get('/api/screener/run/:jobId', (req, res) => {
  const job = screenerJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found (jobs are in-memory and pruned on restart)' });
  res.json({
    status: job.status,
    progress: job.progress,
    // Stream matches found so far while still scanning (sector/name fill in once
    // the job completes). Lets the UI show results live instead of blocking.
    ...(job.status === 'running' && job.matches ? { partialMatches: job.matches } : {}),
    ...(job.status === 'done' ? { result: job.result } : {}),
    ...(job.status === 'error' ? { error: job.error } : {}),
  });
});

// ── Saved screens (Supabase: saved_screens — see migrate_screens.js) ──
// The pre-existing table stores `rules` (jsonb) + `universe` (text JSON), so we
// map to/from the API shape { scope, conditions } at the boundary.
const screenRowToApi = (row) => {
  let scope = null;
  try { scope = typeof row.universe === 'string' ? JSON.parse(row.universe) : row.universe; } catch { /* leave null */ }
  return {
    id: row.id,
    name: row.name,
    scope,
    conditions: row.rules?.conditions || [],
    created_at: row.created_at,
  };
};

app.post('/api/screener/screens', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { name, scope, conditions } = req.body || {};
  if (!name || !scope?.type) return res.status(400).json({ error: 'name and scope are required' });
  try {
    validateConditions(conditions);
    const { data, error } = await supabase.from('saved_screens')
      .insert({ name: String(name).trim(), rules: { conditions }, universe: JSON.stringify(scope) })
      .select().single();
    if (error) throw new Error(error.message);
    res.json({ screen: screenRowToApi(data) });
  } catch (err) {
    res.status(err.message.includes('condition') || err.message.includes('field') || err.message.includes('value') || err.message.includes('operator') ? 400 : 500).json({ error: err.message });
  }
});

app.get('/api/screener/screens', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { data, error } = await supabase.from('saved_screens')
      .select('*').order('created_at', { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    res.json({ screens: (data || []).map(screenRowToApi) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/screener/screens/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const { error } = await supabase.from('saved_screens').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Valuation assessment ─────────────────────────────────────
// Composes data the app already caches (screener annual P&L / balance sheet /
// cashflow / peers, Yahoo fundamentals, 4Y candles, macro repo rate) into a
// four-lens valuation verdict. Pure math lives in backend/valuation/engine.js.
const { computeValuation } = require('./valuation/engine');

const valuationCache = {}; // symbol -> { data, ts }
const VALUATION_TTL = 60 * 60 * 1000; // 1h — inputs refresh slower than this

// Screener fetch helpers sharing the SAME caches the per-tab endpoints use,
// so a user who already opened the P&L tab pays nothing extra here.
async function getScreenerAnnualCached(symbol) {
  const cached = screenerAnnualCache[symbol];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) return cached.data;
  const { html } = await fetchScreenerHTML(symbol);
  const years = parseScreenerAnnualPL(html);
  const payload = { source: 'screener.in', symbol, period: 'annual', years };
  screenerAnnualCache[symbol] = { data: payload, ts: Date.now() };
  return payload;
}

async function getScreenerQuarterlyCached(symbol) {
  const cached = screenerCache[symbol];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) return cached.data;
  const { html } = await fetchScreenerHTML(symbol);
  const quarters = parseScreenerQuarterly(html);
  const payload = { source: 'screener.in', symbol, quarters };
  screenerCache[symbol] = { data: payload, ts: Date.now() };
  return payload;
}

async function getScreenerCashflowCached(symbol) {
  const cached = screenerCashflowCache[symbol];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) return cached.data;
  const { html } = await fetchScreenerHTML(symbol);
  const years = parseScreenerCashflow(html);
  const payload = { source: 'screener.in', symbol, period: 'annual', years };
  screenerCashflowCache[symbol] = { data: payload, ts: Date.now() };
  return payload;
}

async function getScreenerBalanceSheetCached(symbol) {
  const cacheKey = `${symbol}::consolidated`;
  const cached = screenerBalanceSheetCache[cacheKey];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) return cached.data;
  // Simplified consolidated→standalone fallback (mirrors the endpoint).
  let years, usedBasis = 'consolidated';
  try {
    const { html } = await fetchScreenerHTML(symbol, { consolidated: true });
    years = parseScreenerBalanceSheet(html);
    if (!years || years.length < 2) throw new Error('degenerate consolidated table');
  } catch {
    const { html } = await fetchScreenerHTML(symbol, { consolidated: false });
    years = parseScreenerBalanceSheet(html);
    usedBasis = 'standalone';
  }
  const payload = { source: 'screener.in', symbol, period: 'annual', basis: usedBasis, years };
  screenerBalanceSheetCache[cacheKey] = { data: payload, ts: Date.now() };
  return payload;
}

async function getScreenerPeersCached(symbol) {
  const cached = screenerPeersCache[symbol];
  if (cached && Date.now() - cached.ts < SCREENER_TTL) return cached.data;
  const { html } = await fetchScreenerHTML(symbol);
  const linkMatch = html.match(/href="(\/market\/[^"]+)"[^>]*title="Industry"[^>]*>([^<]+)</);
  if (!linkMatch) throw new Error('Peer industry not found on screener page');
  const r = await fetch(`https://www.screener.in${linkMatch[1]}`, { headers: SCREENER_FETCH_HEADERS });
  if (!r.ok) throw new Error(`Industry page returned ${r.status}`);
  const { peers, median } = parseScreenerPeers(await r.text());
  const payload = { source: 'screener.in', symbol, industry: linkMatch[2].trim().replace(/&amp;/g, '&'), peers, median };
  screenerPeersCache[symbol] = { data: payload, ts: Date.now() };
  return payload;
}

app.get('/api/valuation/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const token = req.query.token ? String(req.query.token) : null;
  const cached = valuationCache[symbol];
  if (cached && req.query.refresh !== '1' && Date.now() - cached.ts < (cached.ttl ?? VALUATION_TTL)) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    const settled = await Promise.allSettled([
      getScreenerAnnualCached(symbol),
      getScreenerBalanceSheetCached(symbol),
      getScreenerCashflowCached(symbol),
      getScreenerPeersCached(symbol),
      getScreenerQuarterlyCached(symbol),
      yahooFinance.quoteSummary(toYahooSymbol(symbol), {
        modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'price'],
      }),
      token && mcpClient ? getOrFetchFullHistory(token) : Promise.resolve(null),
    ]);
    const [annualR, bsR, cfR, peersR, quarterlyR, yahooR, histR] = settled;
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    const inputErrors = [];
    const tag = ['annual P&L', 'balance sheet', 'cashflow', 'peers', 'quarterly results', 'yahoo fundamentals', 'price history'];
    settled.forEach((r, i) => { if (r.status === 'rejected') inputErrors.push({ input: tag[i], error: r.reason?.message || 'failed' }); });

    const annual = val(annualR);
    const bs = val(bsR);
    const cf = val(cfR);
    const peersData = val(peersR);
    const quarterly = val(quarterlyR);
    const yq = val(yahooR);
    const candles = val(histR)?.data || [];
    if (token && candles.length === 0 && !inputErrors.some(e => e.input === 'price history')) {
      inputErrors.push({ input: 'price history', error: mcpClient ? 'no candles returned' : 'MCP not connected' });
    }

    // TTM EPS = sum of the last 4 quarterly EPS (screener basis). Only when
    // all 4 are present — partial sums would understate the denominator.
    let ttmEps = null;
    {
      const q = (quarterly?.quarters || []).slice().sort((a, b) => a.sortKey - b.sortKey);
      const last4 = q.slice(-4).map(x => x.eps);
      if (last4.length === 4 && last4.every(v => v != null)) {
        ttmEps = last4.reduce((s, v) => s + v, 0);
      }
    }

    const annualYears = (annual?.years || []).slice().sort((a, b) => a.sortKey - b.sortKey)
      .map(y => ({
        label: y.label, sortKey: y.sortKey,
        eps: y.eps ?? null, netProfit: y.netProfit ?? null, totalIncome: y.totalIncome ?? null,
        otherIncome: y.otherIncome ?? null, pbt: y.pbt ?? null, operatingProfit: y.operatingProfit ?? null,
      }));
    const bsYears = (bs?.years || []).slice().sort((a, b) => a.fy - b.fy);
    const netWorthYears = bsYears.map(y => ({ fyLabel: y.fyLabel, fy: y.fy, netWorth: y.netWorth ?? null }));
    const isFinancial = bsYears.some(y => y.deposits != null || y.loans != null);
    const fcfYears = (cf?.years || []).slice().sort((a, b) => a.fy - b.fy)
      .map(y => ({ fyLabel: y.fyLabel, freeCashFlow: y.freeCashFlow ?? null }));

    // Self row in the industry table: match slug against the base symbol
    // (series suffixes like -BE don't appear in screener slugs).
    const baseSymbol = (SCREENER_SLUG_ALIASES[symbol] || symbol).replace(/-(BE|BZ|BL|IL|SM|ST|GB|GC|GS|DR)$/i, '').toUpperCase();
    const peerSelf = (peersData?.peers || []).find(p => (p.slug || '').toUpperCase() === baseSymbol) || null;

    // Hygienic peer median: SELF excluded, only positive P/Es (loss-makers
    // carry no multiple), require n ≥ 5 for statistical meaning, report IQR.
    // Falls back to screener's own <tfoot> Median row when the universe is
    // too small (flagged via `basis`).
    let peerMedian = null;
    {
      const others = (peersData?.peers || []).filter(p => (p.slug || '').toUpperCase() !== baseSymbol);
      const quantile = (vals, q) => {
        const v = vals.filter(x => x != null && x > 0).sort((a, b) => a - b);
        if (!v.length) return null;
        const idx = (v.length - 1) * q;
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        return v[lo] + (v[hi] - v[lo]) * (idx - lo);
      };
      const pes = others.map(p => p.pe);
      const validCount = pes.filter(x => x != null && x > 0).length;
      if (validCount >= 5) {
        peerMedian = {
          pe: quantile(pes, 0.5),
          q1: quantile(pes, 0.25),
          q3: quantile(pes, 0.75),
          roce: quantile(others.map(p => p.roce), 0.5),
          peerCount: validCount,
          basis: 'computed (self excluded)',
        };
      } else if (peersData?.median?.pe != null) {
        peerMedian = { ...peersData.median, basis: 'screener median row (includes self)' };
      } else if (peersData) {
        peerMedian = { reason: `Too few comparable peers with a meaningful P/E (${validCount} of ${others.length})` };
      }
    }

    // Cyclical/commodity industries: trailing P/E inverts at cycle extremes,
    // so the engine applies a cycle-adjusted guard for these.
    const isCyclical = /refiner|oil|gas|petro|metal|steel|mining|coal|cement|sugar|paper|chemical|fertili|alumin|copper|zinc|commodit|shipping|textile/i
      .test(peersData?.industry || '');

    // Size mismatch vs peer set (conglomerate detection): own market cap many
    // multiples above the peer median means the industry table isn't really
    // a comparable universe (e.g. RELIANCE vs standalone refiners).
    let sizeMismatchRatio = null;
    {
      const others = (peersData?.peers || []).filter(p => (p.slug || '').toUpperCase() !== baseSymbol);
      const caps = others.map(p => p.marketCap).filter(x => x != null && x > 0).sort((a, b) => a - b);
      const ownCap = (yq?.price?.marketCap != null ? yq.price.marketCap / 1e7 : null) ?? peerSelf?.marketCap ?? null;
      if (caps.length >= 5 && ownCap != null) {
        const mid = Math.floor(caps.length / 2);
        const medCap = caps.length % 2 ? caps[mid] : (caps[mid - 1] + caps[mid]) / 2;
        if (medCap > 0) sizeMismatchRatio = ownCap / medCap;
      }
    }

    // Current price: explicit override → Yahoo live → last candle → peers CMP.
    const price = Number(req.query.price) > 0 ? Number(req.query.price)
      : yq?.price?.regularMarketPrice
      ?? (candles.length ? candles[candles.length - 1].close : null)
      ?? peerSelf?.cmp
      ?? null;
    if (price == null) return res.status(422).json({ error: 'Could not resolve a current price for ' + symbol });

    const yahoo = yq ? {
      trailingPE: yq.summaryDetail?.trailingPE ?? null,
      forwardPE: yq.summaryDetail?.forwardPE ?? null,
      evToEbitda: yq.defaultKeyStatistics?.enterpriseToEbitda ?? null,
      priceToBook: yq.defaultKeyStatistics?.priceToBook ?? null,
      marketCapCr: yq.price?.marketCap != null ? yq.price.marketCap / 1e7 : null,
      sharesOutstandingCr: yq.defaultKeyStatistics?.sharesOutstanding != null ? yq.defaultKeyStatistics.sharesOutstanding / 1e7 : null,
      roePct: yq.financialData?.returnOnEquity != null ? yq.financialData.returnOnEquity * 100 : null,
      dividendYieldPct: yq.summaryDetail?.dividendYield != null ? yq.summaryDetail.dividendYield * 100 : null,
    } : {};

    const result = computeValuation({
      symbol,
      price,
      // Repo rate as the risk-free anchor: live macro cache first, then the
      // curated MPC supplement's latest decision (always present).
      riskFreeRate: macroCache.data?.policy?.repoRate
        ?? RBI_POLICY_SUPPLEMENT.decisions[RBI_POLICY_SUPPLEMENT.decisions.length - 1].rate,
      yahoo,
      peerMedian,
      peerSelf,
      annualYears,
      ttmEps,
      netWorthYears,
      fcfYears,
      candles,
      isFinancial,
      debtCr: bsYears.length ? (bsYears[bsYears.length - 1].borrowings ?? null) : null,
      isCyclical,
      sizeMismatchRatio,
    });
    result.industry = peersData?.industry ?? null;
    result.inputErrors = inputErrors;

    // Cache for the full hour only when inputs were complete; retry sooner
    // when something (typically MCP candles during startup) was missing.
    valuationCache[symbol] = {
      data: result,
      ts: Date.now(),
      ttl: inputErrors.length ? 5 * 60 * 1000 : VALUATION_TTL,
    };
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error(`[valuation] ${symbol}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Express error middleware: when a route throws an Error with statusCode=429
// (from `detectRateLimit` above), surface it as a proper 429 + Retry-After
// header so the frontend's useFetchWithAbort can back off cleanly.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.statusCode === 429) {
    const retryAfter = err.retryAfter || 5;
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'rate_limited', retryAfter });
  }
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
  next();
});

// ─── AI Chat (Text-to-SQL) ────────────────────────────────────
const { runSqlAgent } = require('./ai/sqlAgent');

app.post('/api/chat', async (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  const result = await runSqlAgent(question.trim());
  res.json(result);
});

// ─── Quant Stock-Picks (deterministic factor ranking + AI brief) ──────────────
const { buildFactorUniverse, generatePicksSummary } = require('./picks/engine');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const picksCache = {}; // `${from}|${to}` -> { data, ts }
const PICKS_TTL = 10 * 60 * 1000; // 10 min

app.get('/api/stock-picks', async (req, res) => {
  // ?date=YYYY-MM-DD for a single-day snapshot, or ?from=&to= for a lookback.
  const date = req.query.date;
  const from = date || req.query.from;
  const to = date || req.query.to;
  if (!ISO.test(from || '') || !ISO.test(to || '')) {
    return res.status(400).json({ error: 'Provide ?date=YYYY-MM-DD or ?from=YYYY-MM-DD&to=YYYY-MM-DD' });
  }
  if (from > to) return res.status(400).json({ error: 'from must be on or before to' });
  const key = `${from}|${to}`;
  const hit = picksCache[key];
  if (hit && Date.now() - hit.ts < PICKS_TTL) return res.json({ ...hit.data, cached: true });
  try {
    const data = await buildFactorUniverse({ from, to });
    picksCache[key] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    console.error('[stock-picks]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolve real sector + company name (one Yahoo call each, cached) for the
// displayed rows only — the full picks universe is too large to enrich, but the
// visible top-N is cheap. Mirrors how the screener attaches sector to matches.
const pickMetaCache = {}; // symbol -> { sector, name }
async function getPickMeta(symbol) {
  if (pickMetaCache[symbol] !== undefined) return pickMetaCache[symbol];
  try {
    const q = await yahooFinance.quoteSummary(toYahooSymbol(symbol), { modules: ['price', 'assetProfile'] });
    pickMetaCache[symbol] = { sector: q?.assetProfile?.sector || null, name: q?.price?.longName || q?.price?.shortName || null };
  } catch { pickMetaCache[symbol] = { sector: null, name: null }; }
  return pickMetaCache[symbol];
}
app.post('/api/stock-picks/meta', async (req, res) => {
  const symbols = [...new Set((req.body?.symbols || []).map(s => String(s).toUpperCase()))].slice(0, 60);
  const out = {};
  const CHUNK = 8;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const metas = await Promise.all(chunk.map(s => getPickMeta(s).catch(() => null)));
    chunk.forEach((s, j) => { out[s] = metas[j] || { sector: null, name: null }; });
  }
  res.json(out);
});

app.post('/api/stock-picks/summary', async (req, res) => {
  const { period, regime, weights, picks } = req.body || {};
  if (!period || !regime || !Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: 'period, regime and a non-empty picks array are required' });
  }
  try {
    const summary = await generatePicksSummary({ period, regime, weights: weights || {}, picks: picks.slice(0, 25) });
    res.json({ summary });
  } catch (err) {
    console.error('[stock-picks/summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── US market data (Alpaca) ───────────────────────────────────
app.use('/api/us', alpacaRouter);

// Serve frontend in production (Railway)
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Catch-all route to serve React's index.html for client-side routing
app.get(/^.*$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

app.listen(PORT, async () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  await connectToKiteMcp();
});
