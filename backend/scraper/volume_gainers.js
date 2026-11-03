const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { withRetry } = require('./withRetry');
const { parseNseNumber, toShares, toLakhs } = require('./nseNumber');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function parseTradeDate(timestampStr) {
    if (!timestampStr) return new Date().toISOString().slice(0, 10);
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const datePart = timestampStr.split(' ')[0];
    const [day, month, year] = datePart.split('-');
    return `${year}-${months[month] || month}-${day.padStart(2, '0')}`;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * One attempt in a fresh browser. Throws when the payload never arrives, so
 * the retry wrapper starts a clean session rather than reusing one NSE has just
 * refused — see withRetry.js for the 2026-11-02 run that motivated this.
 */
async function captureOnce(attempt) {
    let browser;
    try {
        console.log(`[VolGain] Attempt ${attempt}: launching headless browser...`);
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setUserAgent(UA);

        let volumeJson = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('live-analysis-volume') && response.status() === 200) {
                try {
                    volumeJson = await response.json();
                    console.log(`[VolGain] Intercepted from: ${url}`);
                } catch (e) {
                    console.error('[VolGain] Failed to parse response:', e.message);
                }
            }
        });

        // Warm the session cookies on the homepage, but never die on it. This
        // step used waitUntil: 'networkidle2' and it is what failed the whole
        // Market Data Sync run on 2026-09-08 ("Navigation timeout of 60000 ms
        // exceeded"): the NSE homepage keeps long-polling, so networkidle2
        // there is a coin flip on a slow runner. Kept, because it costs a
        // second and may still help under rate limiting, but non-fatal.
        console.log('[VolGain] Establishing NSE session...');
        try {
            await page.goto('https://www.nseindia.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            console.warn(`[VolGain] Session warm-up skipped: ${e.message}`);
        }

        console.log('[VolGain] Loading volume gainers page...');
        const resp = await page.goto('https://www.nseindia.com/market-data/volume-gainers-spurts', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        if (resp && resp.status() >= 400) throw new Error(`page answered HTTP ${resp.status()}`);

        // Wait for the XHR we actually want, and stop the moment it lands.
        const deadline = Date.now() + 45000;
        while (!volumeJson && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));

        if (!volumeJson) throw new Error('page loaded but the volume gainers payload never arrived');
        return volumeJson;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

async function run() {
    try {
        const volumeJson = await withRetry('[VolGain]', 3, captureOnce);

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
            // volume and turnover arrive as display strings since 2026-11-02
            // ("2.52 L", "10.06 Cr"); see nseNumber.js for each column's unit.
            volume: toShares(d.volume),
            week1_avg_volume: parseNseNumber(d.week1AvgVolume),
            week1_vol_change: parseNseNumber(d.week1volChange),
            week2_avg_volume: parseNseNumber(d.week2AvgVolume),
            week2_vol_change: parseNseNumber(d.week2volChange),
            ltp: parseNseNumber(d.ltp),
            pct_change: parseNseNumber(d.pChange),
            turnover: toLakhs(d.turnover),
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
    }
}

run();
