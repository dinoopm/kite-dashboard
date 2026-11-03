const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { withRetry } = require('./withRetry');
const { parseNseNumber, toShares, toLakhs } = require('./nseNumber');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const INDEX_KEYS = ['NIFTY', 'BANKNIFTY', 'NIFTYNEXT50', 'SecGtr20', 'SecLwr20', 'FOSec', 'allSec'];

function parseTradeDate(timestampStr) {
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const datePart = timestampStr.split(' ')[0];
    const [day, month, year] = datePart.split('-');
    return `${year}-${months[month] || month}-${day.padStart(2, '0')}`;
}

function extractRecords(json, category) {
    const records = [];
    let tradeDate = null;

    for (const indexName of INDEX_KEYS) {
        const segment = json[indexName];
        if (!segment || !Array.isArray(segment.data)) continue;

        if (!tradeDate && segment.timestamp) {
            tradeDate = parseTradeDate(segment.timestamp);
        }

        for (const d of segment.data) {
            if (!d.symbol) continue;
            records.push({
                trade_date: tradeDate,
                symbol: d.symbol,
                series: d.series || null,
                index_name: indexName,
                category,
                // Since 2026-11-02 NSE sends quantity and turnover as display
                // strings ("109.95 L", "2,759.40 Cr"); see nseNumber.js for the
                // units each column holds. The rest still arrive as numbers and
                // pass straight through, but are read the same way so the next
                // format change fails naming the value, not deep in Postgres.
                open_price: parseNseNumber(d.open_price),
                high_price: parseNseNumber(d.high_price),
                low_price: parseNseNumber(d.low_price),
                ltp: parseNseNumber(d.ltp),
                prev_price: parseNseNumber(d.prev_price),
                net_change: parseNseNumber(d.net_price),
                pct_change: parseNseNumber(d.perChange),
                trade_quantity: toShares(d.trade_quantity),
                turnover: toLakhs(d.turnover)
            });
        }
    }

    return { records, tradeDate };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * One attempt: a fresh browser, the page, and the two intercepted payloads.
 *
 * domcontentloaded plus a poll on the XHR rather than networkidle2 — the
 * September fix to volume_gainers, applied here too: NSE's pages long-poll, so
 * "network idle" is a coin flip on a slow runner, and the payloads are the only
 * thing worth waiting for. Throws when neither arrives, so the retry wrapper can
 * try again with a clean session instead of this step exiting green over an
 * empty day.
 */
async function captureOnce(attempt) {
    let browser;
    try {
        console.log(`[TopGL] Attempt ${attempt}: launching headless browser...`);
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setUserAgent(UA);

        let gainersJson = null;
        let losersJson = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('/api/live-analysis-variations') && response.status() === 200) {
                try {
                    const json = await response.json();
                    if (url.includes('index=gainers')) { gainersJson = json; console.log('[TopGL] Intercepted gainers data'); }
                    else if (url.includes('index=loosers')) { losersJson = json; console.log('[TopGL] Intercepted losers data'); }
                } catch (e) {
                    console.error('[TopGL] Failed to parse response:', e.message);
                }
            }
        });

        console.log('[TopGL] Loading top gainers/losers page...');
        const resp = await page.goto('https://www.nseindia.com/market-data/top-gainers-losers', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        if (resp && resp.status() >= 400) throw new Error(`page answered HTTP ${resp.status()}`);

        const until = async (pred, ms) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 500)); };
        await until(() => gainersJson, 30000);

        // The losers tab is not always loaded by default; click it if needed.
        if (!losersJson) {
            console.log('[TopGL] Clicking Losers tab...');
            await page.evaluate(() => {
                const els = [...document.querySelectorAll('button, [role="tab"], li, a')];
                const tab = els.find(el => el.textContent.trim().toLowerCase().includes('loser'));
                if (tab) tab.click();
            });
            await until(() => losersJson, 15000);
        }

        if (!gainersJson && !losersJson) throw new Error('page loaded but neither the gainers nor the losers payload arrived');
        return { gainersJson, losersJson };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

async function run() {
    try {
        const { gainersJson, losersJson } = await withRetry('[TopGL]', 3, captureOnce);

        const { records: gainerRecords, tradeDate: gDate } = gainersJson ? extractRecords(gainersJson, 'GAINER') : { records: [], tradeDate: null };
        const { records: loserRecords, tradeDate: lDate } = losersJson ? extractRecords(losersJson, 'LOSER') : { records: [], tradeDate: null };
        const tradeDate = gDate || lDate;

        // Assign trade_date to any records that didn't get one
        const allRecords = [...gainerRecords, ...loserRecords].map(r => ({ ...r, trade_date: r.trade_date || tradeDate }));

        if (allRecords.length === 0) {
            console.log('[TopGL] No records to sync.');
            return;
        }

        console.log(`[TopGL] ${gainerRecords.length} gainers, ${loserRecords.length} losers across all indices. Upserting...`);

        // Upsert in batches of 500
        for (let i = 0; i < allRecords.length; i += 500) {
            const batch = allRecords.slice(i, i + 500);
            const { error } = await supabase
                .from('top_gainers_losers')
                .upsert(batch, { onConflict: 'trade_date, symbol, index_name, category' });
            if (error) throw error;
        }

        console.log(`✅ Success: Synced ${allRecords.length} records for ${tradeDate}.`);
    } catch (err) {
        console.error('❌ Sync Failed:', err.message);
        process.exit(1);
    }
}

run();
