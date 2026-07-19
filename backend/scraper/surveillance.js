const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');

// Load environment variables
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const NAV_TIMEOUT = 60000;
const XHR_TIMEOUT = 20000;               // wait for the report XHR after the page loads
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [10000, 30000]; // waits between attempts 1→2 and 2→3

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Poll until `get()` returns something truthy, or the timeout expires. Used to
// wait on the intercepted XHR rather than for the page to go network-idle: NSE
// keeps background polling open, so `networkidle2` can time out even when the
// report call already came back.
async function waitForValue(get, timeoutMs, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (get()) return get();
    await sleep(pollMs);
  }
  return get();
}

// One full scrape attempt. Returns the rows collected (possibly empty). Network
// failures are contained per-report, so a block on ASM doesn't also lose GSM.
async function scrapeOnce() {
  let browser;
  try {
    console.log("[Surveillance] Launching headless browser...");
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // needed for CI/CD (GitHub Actions)
    });

    const page = await browser.newPage();
    await page.setUserAgent(UA);

    const affectedStocks = [];

    // ─── 1. Scrape ASM ─────────────────────────────────────────
    // Intercept the JSON API call the page makes internally. Both the camelCase
    // and kebab-case spellings are matched — NSE has served each.
    let asmData = null;
    page.on('response', async response => {
      if (/\/api\/report-?asm/i.test(response.url()) && response.status() === 200) {
        try { asmData = await response.json(); } catch (e) { /* not JSON */ }
      }
    });

    console.log("[Surveillance] Loading ASM report page...");
    try {
      await page.goto('https://www.nseindia.com/reports/asm', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await waitForValue(() => asmData, XHR_TIMEOUT);
    } catch (e) {
      // NSE blocks datacenter IPs intermittently. Treat it as a failed report,
      // not a failed run, so GSM below still gets its chance.
      console.warn("[Surveillance] ASM page load failed:", e.message);
    }

    if (asmData) {
      for (const key of ['longterm', 'shortterm']) {
        const rows = asmData[key]?.data;
        if (!rows) continue;
        rows.forEach(row => {
          if (row.symbol) {
            affectedStocks.push({
              symbol: row.symbol.trim(),
              measure: 'ASM',
              stage: row.asmSurvIndicator || 'Unknown'
            });
          }
        });
        console.log(`[Surveillance] Parsed ${rows.length} ${key === 'longterm' ? 'Long' : 'Short'} Term ASM stocks.`);
      }
    } else {
      console.warn("[Surveillance] Could not intercept ASM API response.");
    }

    // ─── 2. Scrape GSM ─────────────────────────────────────────
    let gsmData = null;
    page.on('response', async response => {
      const url = response.url();
      if ((/\/api\/report-?gsm/i.test(url) || url.includes('/api/gsm')) && response.status() === 200) {
        try { gsmData = await response.json(); } catch (e) { /* not JSON */ }
      }
    });

    // The regulations page is what actually calls /api/reportGSM; /reports/gsm
    // loads fine but never fires the API, so it's only a fallback.
    let gsmPageLoaded = false;
    for (const url of [
      'https://www.nseindia.com/regulations/graded-surveillance-measure',
      'https://www.nseindia.com/reports/gsm',
    ]) {
      console.log(`[Surveillance] Loading GSM page: ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await waitForValue(() => gsmData, XHR_TIMEOUT);
        gsmPageLoaded = true;
        if (gsmData) break;
        console.warn("[Surveillance] No GSM API response from this page.");
      } catch (e) {
        console.warn(`[Surveillance] GSM navigation failed (${url}):`, e.message);
      }
    }

    if (gsmData) {
      const gsmEntries = gsmData.data || (Array.isArray(gsmData) ? gsmData : []);
      gsmEntries.forEach(row => {
        const symbol = row.symbol || row.Symbol;
        if (symbol) {
          affectedStocks.push({
            symbol: symbol.trim(),
            measure: 'GSM',
            stage: row.gsmSurvIndicator || row.stage || 'Unknown'
          });
        }
      });
      console.log(`[Surveillance] Parsed ${gsmEntries.length} GSM stocks.`);
    } else if (gsmPageLoaded) {
      // Fallback: extract GSM data from the DOM table (only if a page loaded)
      try {
        console.log("[Surveillance] No GSM API intercepted. Trying DOM extraction...");
        const gsmFromDom = await page.evaluate(() => {
          const tables = document.querySelectorAll('table');
          const stocks = [];
          tables.forEach(table => {
            const headers = [...table.querySelectorAll('thead th')].map(h => h.innerText.trim().toUpperCase());
            const symbolIdx = headers.findIndex(h => h === 'SYMBOL');
            const stageIdx = headers.findIndex(h => h.includes('STAGE') || h.includes('GSM'));
            if (symbolIdx < 0) return;
            [...table.querySelectorAll('tbody tr')].forEach(row => {
              const cols = [...row.querySelectorAll('td')].map(td => td.innerText.trim());
              if (cols[symbolIdx]) {
                stocks.push({ symbol: cols[symbolIdx], stage: cols[stageIdx] || 'Unknown' });
              }
            });
          });
          return stocks;
        });

        gsmFromDom.forEach(row => {
          affectedStocks.push({ symbol: row.symbol, measure: 'GSM', stage: row.stage });
        });
        if (gsmFromDom.length > 0) {
          console.log(`[Surveillance] Extracted ${gsmFromDom.length} GSM stocks from DOM.`);
        }
      } catch (domErr) {
        console.warn("[Surveillance] GSM DOM extraction failed:", domErr.message);
      }
    }

    return affectedStocks;
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

// Retry the whole scrape. NSE blocks datacenter IPs intermittently, and a fresh
// browser (new session and cookies) is usually what gets through on a later try.
async function scrapeWithRetry() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const stocks = await scrapeOnce();
      if (stocks.length > 0) return stocks;
      console.warn(`[Surveillance] Attempt ${attempt}/${MAX_ATTEMPTS} returned no stocks.`);
    } catch (err) {
      console.warn(`[Surveillance] Attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
    }
    if (attempt < MAX_ATTEMPTS) {
      const wait = RETRY_BACKOFF_MS[attempt - 1] ?? 30000;
      console.log(`[Surveillance] Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
  return [];
}

async function syncSurveillance() {
  try {
    const affectedStocks = await scrapeWithRetry();

    if (affectedStocks.length === 0) {
      console.warn(`[Surveillance] No stocks found after ${MAX_ATTEMPTS} attempts; leaving existing data untouched.`);
      return;
    }

    console.log(`[Surveillance] Total surveillance stocks: ${affectedStocks.length}. Syncing to Supabase...`);

    // Clear old data and upsert new list
    const { error: deleteErr } = await supabase.from('surveillance_stocks').delete().neq('symbol', 'DUMMY');
    if (deleteErr) throw new Error("Failed to clear old data: " + deleteErr.message);

    // Upsert in batches of 100 to avoid payload limits
    for (let i = 0; i < affectedStocks.length; i += 100) {
      const batch = affectedStocks.slice(i, i + 100);
      const { error: insertErr } = await supabase
        .from('surveillance_stocks')
        .upsert(batch, { onConflict: 'symbol' });
      if (insertErr) throw new Error("Supabase Insert Error: " + insertErr.message);
    }

    console.log(`[Surveillance] ✅ Successfully synced ${affectedStocks.length} stocks.`);

  } catch (err) {
    console.error("[Surveillance] Fatal Error:", err);
    process.exit(1);
  }
}

syncSurveillance();
