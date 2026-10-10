const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');

// Load environment variables
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

// Built lazily so this file can be required by its test without a live config;
// the credential check happens in the run guard at the bottom instead.
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const NAV_TIMEOUT = 60000;
const XHR_TIMEOUT = 20000;               // wait for the report XHR after the page loads
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [10000, 30000]; // waits between attempts 1→2 and 2→3

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Read a report response, and NEVER reject.
 *
 * A puppeteer Response is a live handle onto a browser target, and its
 * accessors are not safe once that target goes away — a closed browser, an
 * aborted request, a redirect. `response.url()` and `response.status()` throw
 * in those cases, not merely `.json()`.
 *
 * The original handlers only guarded `.json()`, so a throw from url()/status()
 * rejected the async listener's promise with nothing awaiting it. Node kills
 * the process on an unhandled rejection with exit code 1 — which is how this
 * job failed on 2026-07-04, 07-18 and 08-08. The 08-08 run died 32 seconds in,
 * while the retry path alone sleeps 40, so scrapeWithRetry never got its
 * remaining attempts and a blocked run failed the workflow instead of exiting
 * 0 with "no stocks found". The rejection was never on the chain it awaited.
 */
async function readReport(response, pattern) {
  try {
    if (!response || typeof response.url !== 'function' || typeof response.status !== 'function') return null;
    if (!pattern.test(response.url())) return null;
    if (response.status() !== 200) return null;
    return (await response.json()) ?? null;
  } catch {
    return null;   // detached target, non-JSON body, redirect — all "no data"
  }
}

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
    // Not an async listener: the returned promise would be unawaited, so any
    // rejection inside it becomes an unhandled rejection. readReport cannot
    // reject, and the trailing catch covers the impossible case.
    page.on('response', (response) => {
      readReport(response, /\/api\/report-?asm/i)
        .then(d => { if (d) asmData = d; })
        .catch(() => { });
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
    page.on('response', (response) => {
      readReport(response, /\/api\/(report-?gsm|gsm)/i)
        .then(d => { if (d) gsmData = d; })
        .catch(() => { });
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

/**
 * Did this scrape get BOTH reports?
 *
 * The two are fetched from different NSE pages and are blocked independently,
 * so "193 rows" is not evidence of a good scrape — it is evidence of a good
 * ASM scrape and says nothing about GSM.
 */
function isCompleteScrape(stocks) {
  if (!Array.isArray(stocks) || !stocks.length) return false;
  return stocks.some(s => s?.measure === 'ASM') && stocks.some(s => s?.measure === 'GSM');
}

// The table is keyed by symbol, while NSE can repeat a symbol across reports.
// Match the previous report order: the last row for a symbol wins (GSM is
// collected after ASM). Deduplicate the entire scrape before making batches.
function normalizeSurveillanceStocks(stocks) {
  if (!Array.isArray(stocks)) throw new TypeError('Surveillance response must be an array');
  const bySymbol = new Map();
  for (const [index, stock] of stocks.entries()) {
    if (typeof stock?.symbol !== 'string' || !stock.symbol.trim()
      || !['ASM', 'GSM'].includes(stock.measure)) {
      throw new Error(`Invalid surveillance row at index ${index}; existing data will not be pruned`);
    }
    const symbol = stock.symbol.trim().toUpperCase();
    const stage = typeof stock.stage === 'string' || typeof stock.stage === 'number'
      ? String(stock.stage).trim() : '';
    bySymbol.set(symbol, { symbol, measure: stock.measure, stage: stage || 'Unknown' });
  }
  return [...bySymbol.values()];
}

// Retry the whole scrape. NSE blocks datacenter IPs intermittently, and a fresh
// browser (new session and cookies) is usually what gets through on a later try.
//
// A COMPLETE scrape ends the loop; a partial one is kept but retried, because
// ASM and GSM come from separate pages that are blocked separately, and a
// partial result is not a smaller success — see syncSurveillance.
async function scrapeWithRetry() {
  let best = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const stocks = await scrapeOnce();
      if (isCompleteScrape(stocks)) return stocks;
      if (stocks.length > best.length) best = stocks;
      console.warn(`[Surveillance] Attempt ${attempt}/${MAX_ATTEMPTS} incomplete (${stocks.length} rows, measures: ${[...new Set(stocks.map(s => s.measure))].join(',') || 'none'}).`);
    } catch (err) {
      console.warn(`[Surveillance] Attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
    }
    if (attempt < MAX_ATTEMPTS) {
      const wait = RETRY_BACKOFF_MS[attempt - 1] ?? 30000;
      console.log(`[Surveillance] Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
  return best;
}

async function syncSurveillance({ client = supabase, scrape = scrapeWithRetry, logger = console } = {}) {
  const sourceStocks = await scrape();
  const affectedStocks = normalizeSurveillanceStocks(sourceStocks);

  // Check source coverage before deduplication: a symbol in both reports is
  // stored once, but still proves that both reports were retrieved.
  if (!isCompleteScrape(sourceStocks)) {
    logger.warn(`[Surveillance] Incomplete after ${MAX_ATTEMPTS} attempts (${sourceStocks.length} rows) — leaving existing data untouched.`);
    return;
  }
  if (!client) throw new Error('Supabase is not configured');

  logger.log(`[Surveillance] ${sourceStocks.length} report rows, ${affectedStocks.length} unique stocks. Syncing to Supabase...`);

  // Upload first. A failed batch must never clear the previous exclusion list.
  const batchSize = 100;
  for (let i = 0; i < affectedStocks.length; i += batchSize) {
    const { error } = await client.from('surveillance_stocks')
      .upsert(affectedStocks.slice(i, i + batchSize), { onConflict: 'symbol' });
    if (error) throw new Error('Supabase Insert Error: ' + error.message);
  }

  // Read the whole stored list before deleting anything. Stable ordering and
  // pagination avoid silently retaining stale rows past Supabase's row cap.
  const currentSymbols = new Set(affectedStocks.map(stock => stock.symbol));
  const staleSymbols = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.from('surveillance_stocks')
      .select('symbol').order('symbol', { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw new Error('Supabase Read Error: ' + error.message);
    if (!Array.isArray(data) || data.some(row => typeof row?.symbol !== 'string' || !row.symbol.trim())) {
      throw new Error('Invalid stored surveillance symbols; existing data will not be pruned');
    }
    for (const row of data) {
      if (!currentSymbols.has(row.symbol)) staleSymbols.push(row.symbol);
    }
    if (data.length < pageSize) break;
  }
  for (let i = 0; i < staleSymbols.length; i += batchSize) {
    const { error } = await client.from('surveillance_stocks')
      .delete().in('symbol', staleSymbols.slice(i, i + batchSize));
    if (error) throw new Error('Supabase Delete Error: ' + error.message);
  }

  logger.log(`[Surveillance] ✅ Successfully synced ${affectedStocks.length} stocks; removed ${staleSymbols.length} stale rows.`);
}

// Only run when invoked directly, so the test can require this file.
if (require.main === module) {
  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment");
    process.exit(1);
  }

  // Last line of defence, and deliberately non-fatal. Puppeteer emits stray
  // rejections from targets that close mid-flight, and this job's whole
  // purpose is to tolerate NSE misbehaving. A weekly scraper that leaves the
  // existing surveillance list untouched has done the right thing; killing the
  // process turns a handled outage into a red workflow and trains everyone to
  // ignore the alert. Logged loudly so a genuine bug is still visible.
  process.on('unhandledRejection', (reason) => {
    console.warn('[Surveillance] Ignored stray rejection:', reason?.message || reason);
  });

  syncSurveillance().catch(err => {
    console.error('[Surveillance] Fatal Error:', err);
    process.exitCode = 1;
  });
}

module.exports = { readReport, isCompleteScrape, normalizeSurveillanceStocks, syncSurveillance, scrapeWithRetry };
