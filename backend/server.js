const express = require('express');
const cors = require('cors');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SMA, EMA, RSI, MACD, BollingerBands } = require('technicalindicators');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

let mcpClient = null;
let mcpTransport = null;

// ─── In-memory cache ───────────────────────────────────────────
const historyCache = {};   // { instrument_token: [ {date, open, high, low, close, volume} ] }
let holdingsCache = [];    // raw holdings array
let cacheReady = false;

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
    try { return JSON.parse(result.content[0].text); } catch(e) {}
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

// ─── Cache warm-up ─────────────────────────────────────────────
async function warmCache(retries = 3) {
  console.log("⏳ Warming cache: fetching holdings...");
  try {
    let holdings = null;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      const holdResult = await mcpClient.callTool({
        name: "get_holdings",
        arguments: { limit: 50 }
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
    fromDate.setDate(toDate.getDate() - (365 * 5)); // 5 years of daily data to satisfy 5Y MAX requests

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
    console.log(`✅ Cache warm-up complete: ${cached}/${holdings.length} instruments cached`);
  } catch (err) {
    console.error("❌ Cache warm-up failed:", err.message);
  }
}

// ─── MCP Connection ────────────────────────────────────────────
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
    // Cache warmup will be triggered lazily after first successful authenticated request
  } catch (err) {
    console.error("Failed to connect to MCP:", err);
  }
}

// ─── API Routes ────────────────────────────────────────────────

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
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    // Clear all API caches so the next fetch gets fresh data after authentication
    Object.keys(apiCache).forEach(k => {
      apiCache[k].data = null;
      apiCache[k].timestamp = 0;
    });
    const result = await callWithTimeout({ name: "login", arguments: {} }, 30000); // login can take slightly longer
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  ]).finally(() => clearTimeout(timeoutId));
};

// Track instrument indicator fetches to prevent duplicate/race conditions
const indicatorPromises = {};

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
    const result = await fetchWithCache("get_holdings", "holdings", { limit: 50 });
    res.json(result);
    // Trigger cache warmup on first successful holdings fetch
    if (!cacheReady && !result.isError) {
      console.log("🔑 Authenticated session detected, starting cache warm-up...");
      warmCache();
    }
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

      const filtered = alignedCached.filter(c => {
         const d = new Date(c.date);
         return d >= cutoff;
      });

    // Wrap back in MCP-like response so frontend parsing stays the same
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    if (filtered && filtered.length > 0) {
      return res.json({
        content: [{ type: "text", text: JSON.stringify(filtered) }]
      });
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

// ─── Portfolio Alerts ──────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });

  try {
    // Get holdings list
    const holdingsResult = await fetchWithCache("get_holdings", "holdings", { limit: 50 });
    let holdings = [];
    if (holdingsResult?.content?.[0]?.text) {
      const parsed = JSON.parse(holdingsResult.content[0].text);
      holdings = parsed.data || parsed;
    }
    if (!Array.isArray(holdings) || holdings.length === 0) {
      return res.json([]);
    }

    const alerts = [];

    for (const h of holdings) {
      const token = h.instrument_token;
      const symbol = h.tradingsymbol;
      const lastPrice = h.last_price;
      let cached = historyCache[token];

      // Skip if no cached data and we can't compute
      if (!cached || cached.length < 15) continue;

      const closes = cached.map(c => c.close);
      const currentPrice = lastPrice || closes[closes.length - 1];

      // Compute indicators
      const sma5Arr = SMA.calculate({ period: 5, values: closes });
      const sma20Arr = SMA.calculate({ period: 20, values: closes });
      const sma50Arr = SMA.calculate({ period: 50, values: closes });
      const sma200Arr = SMA.calculate({ period: 200, values: closes });
      const rsi14Arr = RSI.calculate({ period: 14, values: closes });

      const sma5 = sma5Arr.length > 0 ? sma5Arr[sma5Arr.length - 1] : null;
      const sma20 = sma20Arr.length > 0 ? sma20Arr[sma20Arr.length - 1] : null;
      const sma50 = sma50Arr.length > 0 ? sma50Arr[sma50Arr.length - 1] : null;
      const sma200 = sma200Arr.length > 0 ? sma200Arr[sma200Arr.length - 1] : null;
      const rsi14 = rsi14Arr.length > 0 ? rsi14Arr[rsi14Arr.length - 1] : null;

      const stockAlerts = [];

      // RSI Alerts
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

      // Short-term Momentum (SMA 5 & SMA 20)
      if (sma5 !== null && sma20 !== null) {
        if (currentPrice > sma5 && currentPrice > sma20) {
          stockAlerts.push({ type: 'sma_short', severity: 'bullish', message: `Trading above SMA 5 (₹${sma5.toFixed(1)}) and SMA 20 (₹${sma20.toFixed(1)}) — Short-term momentum is bullish.` });
        } else if (currentPrice < sma5 && currentPrice < sma20) {
          stockAlerts.push({ type: 'sma_short', severity: 'bearish', message: `Trading below SMA 5 (₹${sma5.toFixed(1)}) and SMA 20 (₹${sma20.toFixed(1)}) — Short-term momentum is bearish.` });
        } else if (currentPrice > sma5 && currentPrice < sma20) {
          stockAlerts.push({ type: 'sma_short', severity: 'warning', message: `Trading above SMA 5 but below SMA 20 — Short-term recovery attempt; trend not yet confirmed.` });
        }
      }

      // Long-term Momentum (SMA 50 & SMA 200)
      if (sma50 !== null && sma200 !== null) {
        if (currentPrice > sma50 && currentPrice > sma200) {
          stockAlerts.push({ type: 'sma_long', severity: 'bullish', message: `Trading above SMA 50 (₹${sma50.toFixed(1)}) and SMA 200 (₹${sma200.toFixed(1)}) — Long-term trend is strongly bullish.` });
        } else if (currentPrice < sma50 && currentPrice < sma200) {
          stockAlerts.push({ type: 'sma_long', severity: 'bearish', message: `Trading below SMA 50 (₹${sma50.toFixed(1)}) and SMA 200 (₹${sma200.toFixed(1)}) — Long-term trend is bearish. Caution.` });
        } else if (currentPrice > sma50 && currentPrice < sma200) {
          stockAlerts.push({ type: 'sma_long', severity: 'warning', message: `Trading above SMA 50 but below SMA 200 — Mid-term recovery, but long-term trend still bearish.` });
        }
        // Golden Cross / Death Cross
        if (sma50 > sma200) {
          stockAlerts.push({ type: 'cross', severity: 'bullish', message: `Golden Cross detected — SMA 50 (₹${sma50.toFixed(1)}) is above SMA 200 (₹${sma200.toFixed(1)}). Major bullish signal.` });
        } else if (sma50 < sma200) {
          stockAlerts.push({ type: 'cross', severity: 'bearish', message: `Death Cross detected — SMA 50 (₹${sma50.toFixed(1)}) is below SMA 200 (₹${sma200.toFixed(1)}). Major bearish signal.` });
        }
      }

      if (stockAlerts.length > 0) {
        alerts.push({
          symbol,
          price: currentPrice,
          rsi: rsi14 ? +rsi14.toFixed(2) : null,
          sma5: sma5 ? +sma5.toFixed(2) : null,
          sma20: sma20 ? +sma20.toFixed(2) : null,
          sma50: sma50 ? +sma50.toFixed(2) : null,
          sma200: sma200 ? +sma200.toFixed(2) : null,
          alerts: stockAlerts
        });
      }
    }

    res.json(alerts);
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

app.post('/api/quotes', async (req, res) => {
  if (!mcpClient) return res.status(500).json({ error: "MCP not connected" });
  try {
    const { instruments } = req.body;
    if (!instruments || !instruments.length) return res.json({ content: [{text: "{}"}] });
    const result = await callWithTimeout({
      name: "get_quotes",
      arguments: { instruments }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  await connectToKiteMcp();
});
