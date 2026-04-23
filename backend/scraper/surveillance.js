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

async function syncSurveillance() {
  let browser;
  try {
    console.log("[Surveillance] Launching headless browser...");
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // needed for CI/CD (GitHub Actions)
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    let affectedStocks = [];

    // ─── 1. Scrape ASM ─────────────────────────────────────────
    // Intercept the JSON API call that the page makes internally
    let asmData = null;
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('/api/reportASM') && response.status() === 200) {
        try { asmData = await response.json(); } catch(e) {}
      }
    });

    console.log("[Surveillance] Loading ASM report page...");
    await page.goto('https://www.nseindia.com/reports/asm', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    if (asmData) {
      // Process Long Term ASM
      if (asmData.longterm?.data) {
        asmData.longterm.data.forEach(row => {
          if (row.symbol) {
            affectedStocks.push({
              symbol: row.symbol.trim(),
              measure: 'ASM',
              stage: row.asmSurvIndicator || 'Unknown'
            });
          }
        });
        console.log(`[Surveillance] Parsed ${asmData.longterm.data.length} Long Term ASM stocks.`);
      }

      // Process Short Term ASM
      if (asmData.shortterm?.data) {
        asmData.shortterm.data.forEach(row => {
          if (row.symbol) {
            affectedStocks.push({
              symbol: row.symbol.trim(),
              measure: 'ASM',
              stage: row.asmSurvIndicator || 'Unknown'
            });
          }
        });
        console.log(`[Surveillance] Parsed ${asmData.shortterm.data.length} Short Term ASM stocks.`);
      }
    } else {
      console.warn("[Surveillance] Could not intercept ASM API response.");
    }

    // ─── 2. Scrape GSM ─────────────────────────────────────────
    let gsmData = null;
    const gsmHandler = async response => {
      const url = response.url();
      // GSM endpoint may differ — intercept any JSON from the GSM page
      if ((url.includes('/api/reportGSM') || url.includes('/api/gsm')) && response.status() === 200) {
        try { gsmData = await response.json(); } catch(e) {}
      }
    };
    page.on('response', gsmHandler);

    console.log("[Surveillance] Loading GSM report page...");
    try {
      await page.goto('https://www.nseindia.com/reports/gsm', { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      console.warn("[Surveillance] GSM page navigation failed, trying alternative URL...");
      try {
        await page.goto('https://www.nseindia.com/regulations/graded-surveillance-measure', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));
      } catch(e2) {
        console.warn("[Surveillance] GSM alternative page also failed:", e2.message);
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
    } else {
      // Fallback: try to extract GSM data from the DOM table (only if page loaded)
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
      } catch(domErr) {
        console.warn("[Surveillance] GSM DOM extraction failed (page may not have loaded):", domErr.message);
      }
    }

    await browser.close();
    browser = null;

    if (affectedStocks.length === 0) {
      console.warn("[Surveillance] No stocks found from any source.");
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
  } finally {
    if (browser) await browser.close();
  }
}

syncSurveillance();
