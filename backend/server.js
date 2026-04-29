const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SMA, EMA, RSI, MACD, BollingerBands, ATR, VWAP } = require('technicalindicators');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
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

async function fetchHistorical(token, fromDate, toDate, interval = 'day') {
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
const sectorCache = {};
async function getSectorCached(symbol) {
  if (sectorCache[symbol] !== undefined) return sectorCache[symbol];
  try {
    const yahooSym = toYahooSymbol(symbol);
    const q = await yahooFinance.quoteSummary(yahooSym, { modules: ['assetProfile'] });
    sectorCache[symbol] = q?.assetProfile?.sector || null;
  } catch {
    sectorCache[symbol] = null;
  }
  return sectorCache[symbol];
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
  const allCandles = [];
  const now = new Date();

  for (let y = years; y > 0; y--) {
    const chunkEnd = new Date(now);
    chunkEnd.setFullYear(now.getFullYear() - (y - 1));
    const chunkStart = new Date(now);
    chunkStart.setFullYear(now.getFullYear() - y);

    try {
      const data = await fetchHistorical(parseInt(token, 10), chunkStart, chunkEnd, 'day');
      if (Array.isArray(data)) {
        allCandles.push(...data);
      }
    } catch (err) {
      console.log(`  ⚠️  Chunk ${y}Y-${y - 1}Y failed for token ${token}: ${err.message}`);
    }
    // Respect rate limit
    await new Promise(r => setTimeout(r, 400));
  }

  // Deduplicate by date and sort
  const seen = new Set();
  const deduped = [];
  for (const c of allCandles) {
    const key = c.date;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(c);
    }
  }
  return deduped.sort((a, b) => new Date(a.date) - new Date(b.date));
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

    // Fire-and-forget: warm the sector RRG cache so the Sector Indices page
    // sees complete data on first open instead of partial/flickering results.
    prewarmRrgHistoricalCache().catch(e => console.error("RRG prewarm error:", e.message));
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

app.get('/api/large-deals/:symbol?', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const symbol = req.params.symbol;
    let query = supabase
      .from('large_deals')
      .select('*')
      .order('trade_date', { ascending: false });
    
    if (symbol) {
      query = query.eq('symbol', symbol);
    } else {
      query = query.limit(100); // Limit to 100 recent deals if no symbol specified
    }

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
    // Callers needing history can pass ?limit=N (capped at 30 to keep payload bounded).
    const limit = Math.min(parseInt(req.query.limit, 10) || 1, 30);
    const { data, error } = await supabase
      .from('fii_dii_activity')
      .select('*')
      .order('trade_date', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/participant-oi', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const { data, error } = await supabase
      .from('participant_oi')
      .select('*')
      .order('trade_date', { ascending: false })
      .limit(20);
      
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/surveillance', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured in backend" });
  try {
    const { data, error } = await supabase
      .from('surveillance_stocks')
      .select('*');
      
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

async function getOrFetchFullHistory(token) {
  const cached = historicalFullCache[token];
  if (cached && (Date.now() - cached.timestamp < HISTORICAL_FULL_TTL)) {
    return { data: cached.data, cached: true };
  }
  if (historicalFullPromises[token]) {
    return { data: await historicalFullPromises[token], cached: false };
  }
  historicalFullPromises[token] = fetchHistoricalMultiYear(token, 3)
    .then(data => {
      if (Array.isArray(data) && data.length > 0) {
        historicalFullCache[token] = { data, timestamp: Date.now() };
      }
      return data || [];
    })
    .finally(() => { delete historicalFullPromises[token]; });
  return { data: await historicalFullPromises[token], cached: false };
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
  const rsi14Arr = RSI.calculate({ period: 14, values: closes });

  const atr14Arr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

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

  const isBreakout = !!(resistanceLvl && currentPrice >= resistanceLvl);
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

  if (isBreakout && confidence >= 75 && volumeConfirmed) {
    tradePlan.action = 'BUY SEEN';
    tradePlan.reason = `Price broke above the 20-day high (₹${resistanceLvl.toFixed(1)}) on ${volSurge.toFixed(1)}× avg volume. Breakout confirmed.`;
  } else if (isBreakout && confidence >= 75 && !volumeConfirmed) {
    tradePlan.action = 'BREAKOUT (CAUTION)';
    tradePlan.reason = `Price crossed the 20-day ceiling (₹${resistanceLvl.toFixed(1)}) with strong score ${confidence}%, but volume is only ${volSurge.toFixed(1)}× avg (<1.5×). Wait for volume confirmation.`;
  } else if (isBreakout && confidence >= 50 && volumeConfirmed) {
    tradePlan.action = 'BREAKOUT (CAUTION)';
    tradePlan.reason = `Price crossed the 20-day ceiling (₹${resistanceLvl.toFixed(1)}) on ${volSurge.toFixed(1)}× volume, but conviction is moderate at ${confidence}%. Watch for follow-through.`;
  } else if (isBreakout && confidence >= 50) {
    tradePlan.action = 'BREAKOUT (WEAK)';
    tradePlan.reason = `Breakout above ₹${resistanceLvl.toFixed(1)} lacks both strong score (${confidence}%) and volume (${volSurge.toFixed(1)}×). High risk of a false breakout.`;
  } else if (isBreakout) {
    tradePlan.action = 'BREAKOUT (WEAK)';
    tradePlan.reason = `Price breached resistance (₹${resistanceLvl.toFixed(1)}) but underlying technicals are weak (score ${confidence}%). Likely bull trap.`;
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
    const summary = {
      todayPnlRupee: +alerts.reduce((s, a) => s + (a.dayChangeRupee || 0), 0).toFixed(2),
      totalPnlRupee: +totalPnl.toFixed(2),
      totalPnlPct:   totalInvested > 0 ? +((totalPnl / totalInvested) * 100).toFixed(2) : null,
      totalInvested: +totalInvested.toFixed(2),
      totalHoldings: alerts.length,
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
      totalRevenue: item.totalRevenue || 0
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

// ─── Multi-year historical data (for Sector Indices) ──────────
app.get('/api/historical-full/:token', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const { token } = req.params;
    const isCacheHit = !!(historicalFullCache[token] && (Date.now() - historicalFullCache[token].timestamp < HISTORICAL_FULL_TTL));
    if (isCacheHit) {
      console.log(`📊 Serving cached 3Y history for token ${token} (${historicalFullCache[token].data.length} candles)`);
    } else if (!historicalFullPromises[token]) {
      console.log(`📊 Fetching full 3Y history for token ${token}...`);
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

  if (Object.keys(rrgTokenCache).length === 0) {
    const allKeys = ["NSE:NIFTY 50", "NSE:NIFTY 500", "NSE:NIFTY MIDCAP 100", ...RRG_SECTOR_KEYS];
    try {
      const q = await callWithTimeout({ name: "get_quotes", arguments: { instruments: allKeys } });
      const quotes = parseMcpText(q) || {};
      for (const k of allKeys) {
        if (quotes[k]?.instrument_token) rrgTokenCache[k] = String(quotes[k].instrument_token);
      }
    } catch (e) {
      console.log(`⚠️ RRG prewarm token resolve failed: ${e.message}`);
      return;
    }
  }

  const tokens = [...new Set(Object.values(rrgTokenCache))];
  Object.assign(historicalFullWarming, { active: true, total: tokens.length, loaded: 0, startedAt: Date.now() });
  console.log(`🔥 Pre-warming historicalFullCache for ${tokens.length} sector tokens...`);

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
  console.log(`✅ RRG prewarm complete: ${historicalFullWarming.loaded}/${tokens.length} cached`);
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

      // RS-Momentum = (RS_Ratio / SMA(RS_Ratio, dynMomSma)) * 100
      const validRsRatio = rsRatio.map(v => v === null ? 0 : v);
      const rsRatioSMA = computeSMA(validRsRatio, momSmaWindow);
      const rsMomentum = validRsRatio.map((v, i) => {
        if (rsRatioSMA[i] === null || rsRatioSMA[i] === 0 || v === 0) return null;
        return (v / rsRatioSMA[i]) * 100;
      });

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

// Resolves a sector's constituent list with cached instrument tokens + live
// last_price. Returns { sector, constituents: [{ symbol, name, isin, key,
// token, lastPrice }] }. The `payload` returned by /api/sector-constituents
// omits lastPrice for back-compat; that's stripped at the call site.
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

async function computeSectorAlertsPayload(sectorKey) {
  const { constituents } = await resolveSectorConstituents(sectorKey);

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
      sector: sectorKey,
    });
    if (alert) alerts.push(alert);
  }

  const summary = {
    sector: sectorKey,
    totalConstituents: constituents.length,
    readyCount: alerts.length,
    notReady,
    flagCounts: {
      avoid: alerts.filter(a => a.tradePlan?.action === 'AVOID').length,
      trim:  alerts.filter(a => a.tradePlan?.action === 'TRIM').length,
      add:   alerts.filter(a => a.tradePlan?.action === 'ADD').length,
    },
  };

  const data = { alerts, summary };
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
