const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function parseTradeDate(timestampStr) {
    if (!timestampStr) return new Date().toISOString().slice(0, 10);
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const datePart = timestampStr.split(' ')[0];
    const [day, month, year] = datePart.split('-');
    return `${year}-${months[month] || month}-${day.padStart(2, '0')}`;
}

async function run() {
    let browser;
    try {
        console.log("[VolGain] Launching headless browser...");
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        let volumeJson = null;

        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('live-analysis-volume') && response.status() === 200) {
                try {
                    const json = await response.json();
                    volumeJson = json;
                    console.log(`[VolGain] Intercepted from: ${url}`);
                } catch (e) {
                    console.error('[VolGain] Failed to parse response:', e.message);
                }
            }
        });

        // Warm the session cookies on the homepage, but never die on it. This
        // step used waitUntil: 'networkidle2' and it is what failed the whole
        // Market Data Sync run on 2026-09-08 ("Navigation timeout of 60000 ms
        // exceeded"): the NSE homepage carries ads and analytics that keep
        // long-polling, so it may never have <=2 in-flight requests for 500ms
        // and networkidle2 there is a coin flip on a slow runner. The two
        // sibling puppeteer scrapers (large_deals, top_gainers_losers) skip
        // the homepage entirely and have never failed this way, so the warm-up
        // is at best a nicety — the page navigation below sets the same
        // cookies. Kept, because it costs a second and may still help under
        // rate limiting, but on domcontentloaded and non-fatal.
        console.log("[VolGain] Establishing NSE session...");
        try {
            await page.goto('https://www.nseindia.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            console.warn(`[VolGain] Session warm-up skipped: ${e.message}`);
        }

        console.log("[VolGain] Loading volume gainers page...");
        await page.goto('https://www.nseindia.com/market-data/volume-gainers-spurts', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // Wait for the XHR we actually want rather than for the network to
        // fall quiet, then stop the moment it lands. The old fixed 5s sleep
        // after networkidle2 was both slower on a good day and too short on a
        // bad one; the response handler above is the only thing that matters.
        const deadline = Date.now() + 45000;
        while (!volumeJson && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }

        await browser.close();
        browser = null;

        if (!volumeJson) {
            console.log('[VolGain] No data intercepted.');
            process.exit(1);
        }

        const { data, timestamp } = volumeJson;
        if (!Array.isArray(data) || data.length === 0) {
            console.log('[VolGain] Empty data array — market may be closed.');
            return;
        }

        const tradeDate = parseTradeDate(timestamp);
        const records = data.map(d => ({
            trade_date: tradeDate,
            symbol: d.symbol,
            company_name: d.companyName || null,
            volume: d.volume ?? null,
            week1_avg_volume: d.week1AvgVolume ?? null,
            week1_vol_change: d.week1volChange ?? null,
            week2_avg_volume: d.week2AvgVolume ?? null,
            week2_vol_change: d.week2volChange ?? null,
            ltp: d.ltp ?? null,
            pct_change: d.pChange ?? null,
            turnover: d.turnover ?? null,
        }));

        console.log(`[VolGain] ${records.length} records for ${tradeDate}. Upserting...`);

        for (let i = 0; i < records.length; i += 500) {
            const batch = records.slice(i, i + 500);
            const { error } = await supabase
                .from('volume_gainers')
                .upsert(batch, { onConflict: 'trade_date, symbol' });
            if (error) throw error;
        }

        console.log(`✅ Success: Synced ${records.length} volume gainer records for ${tradeDate}.`);

    } catch (err) {
        console.error('❌ Sync Failed:', err.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

run();
