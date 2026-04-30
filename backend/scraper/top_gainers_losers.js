const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

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
                open_price: d.open_price ?? null,
                high_price: d.high_price ?? null,
                low_price: d.low_price ?? null,
                ltp: d.ltp ?? null,
                prev_price: d.prev_price ?? null,
                net_change: d.net_price ?? null,
                pct_change: d.perChange ?? null,
                trade_quantity: d.trade_quantity ?? null,
                turnover: d.turnover ?? null
            });
        }
    }

    return { records, tradeDate };
}

async function run() {
    let browser;
    try {
        console.log("[TopGL] Launching headless browser...");
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        let gainersJson = null;
        let losersJson = null;

        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('/api/live-analysis-variations') && response.status() === 200) {
                try {
                    const json = await response.json();
                    if (url.includes('index=gainers')) {
                        gainersJson = json;
                        console.log('[TopGL] Intercepted gainers data');
                    } else if (url.includes('index=loosers')) {
                        losersJson = json;
                        console.log('[TopGL] Intercepted losers data');
                    }
                } catch (e) {
                    console.error('[TopGL] Failed to parse response:', e.message);
                }
            }
        });

        console.log("[TopGL] Loading top gainers/losers page...");
        await page.goto('https://www.nseindia.com/market-data/top-gainers-losers', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        await new Promise(r => setTimeout(r, 3000));

        // If losers weren't loaded by default tab, click to trigger
        if (!losersJson) {
            console.log('[TopGL] Clicking Losers tab...');
            await page.evaluate(() => {
                const els = [...document.querySelectorAll('button, [role="tab"], li, a')];
                const tab = els.find(el => el.textContent.trim().toLowerCase().includes('loser'));
                if (tab) tab.click();
            });
            await new Promise(r => setTimeout(r, 3000));
        }

        await browser.close();
        browser = null;

        if (!gainersJson && !losersJson) {
            console.log('[TopGL] No data intercepted.');
            return;
        }

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
    } finally {
        if (browser) await browser.close();
    }
}

run();
