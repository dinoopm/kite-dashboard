const axios = require('axios');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { withRetry } = require('./withRetry');

// `--dry-run` fetches and prints the row without touching Supabase, so the NSE
// side can be checked from any machine without writing to the live table.
const DRY_RUN = process.argv.includes('--dry-run');

const API_URL = 'https://www.nseindia.com/api/fiidiiTradeReact';

// No homepage "handshake". This script used to GET www.nseindia.com first for
// cookies and then call the API with them. On 2026-11-13 NSE's Akamai started
// answering that homepage request with 403 (reproduced from a home connection
// as well as the Actions runner), so the scraper died before ever asking for
// the data, and Market Data Sync went red for that day. The API itself answers
// a direct request carrying the Referer of the page that normally calls it —
// the same pattern the other NSE JSON endpoints in this repo already rely on.
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nseindia.com/reports/fii-dii',
};

// Helper to convert '22-Apr-2026' to '2026-04-22'
function formatDate(dateStr) {
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const [day, month, year] = dateStr.split('-');
    return `${year}-${months[month]}-${day.padStart(2, '0')}`;
}

const num = (v) => parseFloat(String(v ?? '0').replace(/,/g, ''));

function toRow(data) {
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`Invalid or empty data received from NSE: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const dii = data.find(d => d.category === 'DII');
    const fii = data.find(d => d.category === 'FII/FPI');
    // Both halves of the same day, or nothing: a row with one side zeroed by
    // the `|| '0'` fallbacks would read as a real day of no institutional flow.
    if (!dii || !fii) throw new Error(`NSE reply is missing ${!fii ? 'FII/FPI' : 'DII'}: ${JSON.stringify(data).slice(0, 200)}`);
    if (dii.date !== fii.date) throw new Error(`FII (${fii.date}) and DII (${dii.date}) rows are for different days`);
    return {
        trade_date: formatDate(fii.date),
        fii_buy: num(fii.buyValue),
        fii_sell: num(fii.sellValue),
        fii_net: num(fii.netValue),
        dii_buy: num(dii.buyValue),
        dii_sell: num(dii.sellValue),
        dii_net: num(dii.netValue),
    };
}

// The quick path. Bounded: axios waits forever by default, and a request NSE
// leaves hanging would otherwise hold the job until GitHub kills it.
async function fetchDirect() {
    const { data } = await axios.get(API_URL, { headers, timeout: 20000 });
    return toRow(data);
}

// The fallback: load the report page in Chrome and take the reply to the
// page's own API call. Akamai treats cloud IPs more harshly than a home
// connection, and the direct path has only been proven from the latter; a
// real page load is what every scraper that passes on the Actions runner
// does. Matched on path alone because the page calls the API on
// www.nseindia.in, not .com (seen 2026-11-13).
async function fetchViaBrowser() {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
        const page = await browser.newPage();
        await page.setUserAgent(headers['User-Agent']);
        const reply = page.waitForResponse(r => r.url().includes('/api/fiidiiTradeReact'), { timeout: 60000 });
        // If goto throws first, this promise rejects with nobody awaiting it,
        // and Node 22 ends the process on an unhandled rejection — skipping the
        // retries below. The await further down still sees the real outcome.
        reply.catch(() => {});
        await page.goto('https://www.nseindia.com/reports/fii-dii', { waitUntil: 'domcontentloaded', timeout: 60000 });
        const res = await reply;
        if (!res.ok()) throw new Error(`page's API call answered ${res.status()}`);
        return toRow(await res.json());
    } finally {
        await browser.close();
    }
}

async function fetchFiiDii() {
    try {
        return await fetchDirect();
    } catch (direct) {
        console.warn(`Direct API call failed (${direct.message}); trying the report page in Chrome`);
        try {
            return await fetchViaBrowser();
        } catch (browser) {
            throw new Error(`direct: ${direct.message}; browser: ${browser.message}`);
        }
    }
}

async function run() {
    try {
        console.log("Fetching FII/DII activity from NSE...");
        // A few attempts with a pause between: the endpoint only ever serves
        // the latest session, so a day lost to one bad response is gone for good.
        const row = await withRetry('FII/DII fetch', 3, () => fetchFiiDii(), { baseDelayMs: 10000 });

        if (DRY_RUN) {
            console.log('Dry run — not writing. Row:', JSON.stringify(row));
            return;
        }

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        const { error } = await supabase
            .from('fii_dii_activity')
            .upsert([row], { onConflict: 'trade_date' });

        if (error) throw error;
        console.log(`✅ Success: Synced institutional data for ${row.trade_date}.`);

    } catch (err) {
        console.error("❌ Sync Failed:", err.message);
        process.exit(1);
    }
}

run();
