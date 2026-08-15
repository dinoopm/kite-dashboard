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
  if (!stocks?.length) return false;
  return stocks.some(s => s.measure === 'ASM') && stocks.some(s => s.measure === 'GSM');
}

// GSM caps trading outright — price bands, 100% margin, trade-for-trade, and at
// the higher stages periodic call auction — where ASM only raises margins and
// tightens monitoring. So when a name is on both, GSM is the fact worth
// printing. A named stage beats 'Unknown' within the same measure.
const MEASURE_RANK = { GSM: 2, ASM: 1 };
const rank = (r) => (MEASURE_RANK[r.measure] ?? 0) * 2 + (r.stage && r.stage !== 'Unknown' ? 1 : 0);

/**
 * Collapse the scrape to one row per symbol.
 *
 * `surveillance_stocks` is keyed on symbol alone, so the upsert below sends
 * `onConflict: 'symbol'`. Postgres refuses a single statement that touches the
 * same conflict key twice — "ON CONFLICT DO UPDATE command cannot affect row a
 * second time" — and that is exactly how the 2026-08-15 run died: a clean
 * scrape, all three lists parsed, 292 rows, and at least one name on two of
 * them. The crash came after the DELETE, so it also left the exclusion list
 * empty until the next run.
 *
 * Duplicates are normal input, not a scrape fault. NSE publishes long-term and
 * short-term ASM as separate lists and a stock can sit on both, and GSM is a
 * separate regime that applies at the same time as ASM. So they get merged
 * rather than rejected.
 *
 * Which row wins only affects what gets printed: engine.js excludes on the
 * symbol whatever the measure says, and redFlags.js reads a single row. Ties
 * keep the first occurrence, and the scrape emits in a fixed order (ASM long,
 * ASM short, GSM), so the same input always produces the same table.
 *
 * The alternative is a (symbol, measure) key, which would keep both facts. That
 * is a DDL change plus every reader — worth doing if the stage of the weaker
 * measure ever matters; today nothing reads it.
 */
function dedupeBySymbol(stocks) {
  const bySymbol = new Map();
  for (const row of stocks || []) {
    const prev = bySymbol.get(row.symbol);
    if (!prev || rank(row) > rank(prev)) bySymbol.set(row.symbol, row);
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

async function syncSurveillance() {
  try {
    const affectedStocks = await scrapeWithRetry();

    // The sync REPLACES the table — delete, then insert — and picks/engine.js
    // hard-excludes every symbol in it. So a partial scrape is not a partial
    // update, it is a silent deletion: an ASM-only run would drop ~82 GSM
    // names and let them straight back into the published picks, reporting
    // success while doing it. Leaving yesterday's complete list in place is
    // strictly better than replacing it with a confident subset, because the
    // surveillance list changes slowly and is a safety gate.
    if (!isCompleteScrape(affectedStocks)) {
      const measures = [...new Set(affectedStocks.map(s => s.measure))].join(', ') || 'none';
      console.warn(`[Surveillance] Incomplete after ${MAX_ATTEMPTS} attempts (${affectedStocks.length} rows, measures: ${measures}) — leaving existing data untouched rather than replacing the exclusion list with a subset.`);
      return;
    }

    // One row per symbol before anything is written: the table is keyed on
    // symbol, and a symbol on two lists is both legal and fatal to the upsert.
    const rows = dedupeBySymbol(affectedStocks);
    const merged = affectedStocks.length - rows.length;
    console.log(`[Surveillance] Total surveillance stocks: ${rows.length}${merged ? ` (${merged} duplicate symbol row${merged === 1 ? '' : 's'} merged from ${affectedStocks.length})` : ''}. Syncing to Supabase...`);

    // Clear old data and upsert new list
    const { error: deleteErr } = await supabase.from('surveillance_stocks').delete().neq('symbol', 'DUMMY');
    if (deleteErr) throw new Error("Failed to clear old data: " + deleteErr.message);

    // Upsert in batches of 100 to avoid payload limits
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { error: insertErr } = await supabase
        .from('surveillance_stocks')
        .upsert(batch, { onConflict: 'symbol' });
      if (insertErr) throw new Error("Supabase Insert Error: " + insertErr.message);
    }

    console.log(`[Surveillance] ✅ Successfully synced ${rows.length} stocks.`);

  } catch (err) {
    console.error("[Surveillance] Fatal Error:", err);
    process.exit(1);
  }
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

  syncSurveillance();
}

module.exports = { readReport, isCompleteScrape, dedupeBySymbol, syncSurveillance, scrapeWithRetry };
