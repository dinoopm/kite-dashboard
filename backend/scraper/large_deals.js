const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function formatDateToISO(dateStr) {
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const [day, month, year] = parts;
    return `${year}-${months[month] || month}-${day.padStart(2, '0')}`;
}

function mapDeal(deal, category) {
    return {
        trade_date: formatDateToISO(deal.date),
        symbol: deal.symbol,
        client_name: deal.clientName,
        deal_type: deal.buySell ? deal.buySell.trim() : 'UNKNOWN',
        quantity: parseInt(String(deal.qty).replace(/,/g, ''), 10),
        price: parseFloat(String(deal.watp).replace(/,/g, '')),
        deal_category: category,
        remarks: (!deal.remarks || deal.remarks === '-') ? null : deal.remarks
    };
}

async function run() {
    let browser;
    try {
        console.log("[LargeDeals] Launching headless browser...");
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        let bulkDeals = [];
        let blockDeals = [];

        page.on('response', async (response) => {
            if (response.url().includes('/api/snapshot-capital-market-largedeal') && response.status() === 200) {
                try {
                    const json = await response.json();
                    bulkDeals = json.BULK_DEALS_DATA || [];
                    blockDeals = json.BLOCK_DEALS_DATA || [];
                    console.log(`[LargeDeals] Intercepted: ${bulkDeals.length} bulk, ${blockDeals.length} block deals`);
                } catch (e) {
                    console.error('[LargeDeals] Failed to parse response:', e.message);
                }
            }
        });

        console.log("[LargeDeals] Loading large-deals page...");
        await page.goto('https://www.nseindia.com/market-data/large-deals', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        await new Promise(r => setTimeout(r, 3000));

        await browser.close();
        browser = null;

        const allDeals = [
            ...bulkDeals.map(d => mapDeal(d, 'BULK')),
            ...blockDeals.map(d => mapDeal(d, 'BLOCK'))
        ];

        // NSE sometimes includes duplicate rows; deduplicate by the FULL
        // conflict key (including deal_category) before upsert. Without
        // deal_category in the dedup key, a BULK + BLOCK with otherwise-
        // identical (date, symbol, client, type, qty) collapse to one and
        // the BLOCK row gets silently dropped.
        const seen = new Set();
        const cleanData = allDeals.filter(deal => {
            const key = `${deal.trade_date}|${deal.symbol}|${deal.client_name}|${deal.deal_type}|${deal.quantity}|${deal.deal_category}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (cleanData.length === 0) {
            console.log("[LargeDeals] No bulk or block deals found for today.");
            return;
        }

        // Audit log for the BULK/BLOCK split — makes it obvious when NSE
        // changes the response shape and the scraper silently zeros out one
        // side (the only way "block deals not saving" would happen quietly).
        const splitCounts = cleanData.reduce((acc, d) => {
            acc[d.deal_category] = (acc[d.deal_category] || 0) + 1;
            return acc;
        }, {});
        console.log(`[LargeDeals] Found ${cleanData.length} deals (split: ${JSON.stringify(splitCounts)}). Upserting...`);

        const { error } = await supabase
            .from('large_deals')
            .upsert(cleanData, { onConflict: 'trade_date, symbol, client_name, deal_type, quantity, deal_category' });

        if (error) throw error;
        console.log(`✅ Success: Synced ${cleanData.length} large deals.`);

    } catch (err) {
        console.error("❌ Sync Failed:", err.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

run();
