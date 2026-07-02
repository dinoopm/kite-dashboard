// NSE full bhavcopy (sec_bhavdata_full) — daily OHLCV + delivery data for every
// listed stock. This is the universe-wide price history the movers feeds can't
// give: true momentum, volume-vs-own-average, liquidity screens and
// forward-return backtesting all build on this table.
//
// Usage:
//   node bhavcopy.js        — sync today (falls back to yesterday if not published)
//   node bhavcopy.js 90     — backfill the last 90 calendar days (404s = holidays, skipped)
const axios = require('axios');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
};

// Only cash-equity series worth screening (skips derivatives-linked, SME, debt).
const KEEP_SERIES = new Set(['EQ', 'BE']);

function getISTDateString(offsetDays = 0) {
    const d = new Date();
    d.setHours(d.getHours() + 5);
    d.setMinutes(d.getMinutes() + 30);
    d.setDate(d.getDate() - offsetDays);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return { dateStr: `${day}${month}${year}`, dbDate: `${year}-${month}-${day}` };
}

// Values arrive with stray spaces; '-' means not applicable (e.g. delivery for BE).
const num = (s) => {
    const v = (s || '').trim();
    if (!v || v === '-') return null;
    const n = Number(v.replace(/,/g, ''));
    return isFinite(n) ? n : null;
};

async function fetchAndSync(session, cookies, offsetDays) {
    const { dateStr, dbDate } = getISTDateString(offsetDays);
    const url = `https://archives.nseindia.com/products/content/sec_bhavdata_full_${dateStr}.csv`;

    let res;
    try {
        res = await session.get(url, {
            headers: { ...headers, 'Cookie': cookies },
            responseType: 'text',
            timeout: 20000
        });
    } catch (e) {
        if (e.response && e.response.status === 404) {
            console.log(`[Bhavcopy] ${dbDate}: not available (404) — holiday/weekend or not published yet.`);
            return 'missing';
        }
        console.error(`[Bhavcopy] ${dbDate}: fetch failed —`, e.response ? `HTTP ${e.response.status}` : e.message);
        return 'error';
    }

    const lines = res.data.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    if (lines.length < 2 || !/SYMBOL/i.test(lines[0])) {
        console.error(`[Bhavcopy] ${dbDate}: unexpected CSV. First line: ${lines[0]?.slice(0, 120)}`);
        return 'error';
    }

    const cols = lines[0].split(',').map(c => c.trim().toUpperCase());
    const idx = (name) => cols.indexOf(name);
    const iSym = idx('SYMBOL'), iSer = idx('SERIES');
    const need = {
        prev_close: idx('PREV_CLOSE'), open: idx('OPEN_PRICE'), high: idx('HIGH_PRICE'),
        low: idx('LOW_PRICE'), last_price: idx('LAST_PRICE'), close: idx('CLOSE_PRICE'),
        avg_price: idx('AVG_PRICE'), volume: idx('TTL_TRD_QNTY'), turnover_lacs: idx('TURNOVER_LACS'),
        trades: idx('NO_OF_TRADES'), deliv_qty: idx('DELIV_QTY'), deliv_per: idx('DELIV_PER'),
    };
    if (iSym < 0 || iSer < 0 || need.close < 0) {
        console.error(`[Bhavcopy] ${dbDate}: missing columns. Header: ${cols.join('|')}`);
        return 'error';
    }

    const records = [];
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(',');
        const series = (c[iSer] || '').trim();
        if (!KEEP_SERIES.has(series)) continue;
        const symbol = (c[iSym] || '').trim();
        if (!symbol) continue;
        const row = { trade_date: dbDate, symbol, series };
        for (const [k, j] of Object.entries(need)) row[k] = j >= 0 ? num(c[j]) : null;
        records.push(row);
    }
    if (!records.length) {
        console.error(`[Bhavcopy] ${dbDate}: 0 EQ/BE rows parsed.`);
        return 'error';
    }

    const BATCH = 500;
    for (let i = 0; i < records.length; i += BATCH) {
        const { error } = await supabase
            .from('nse_bhavcopy')
            .upsert(records.slice(i, i + BATCH), { onConflict: 'trade_date,symbol,series' });
        if (error) {
            console.error(`[Bhavcopy] Supabase upsert error: ${error.message}`);
            if (/does not exist|schema cache/i.test(error.message)) {
                console.error('   → Table missing. Run `node ../migrate_bhavcopy.js` and paste the SQL into the Supabase SQL editor.');
            }
            return 'error';
        }
    }
    console.log(`[Bhavcopy] ${dbDate}: synced ${records.length} EQ/BE rows.`);
    return 'ok';
}

async function run() {
    const backfillDays = parseInt(process.argv[2], 10) || 0;

    const session = axios.create({ headers, withCredentials: true });
    console.log('[Bhavcopy] Connecting to NSE...');
    let cookies = '';
    try {
        const hs = await session.get('https://www.nseindia.com', { timeout: 10000 });
        cookies = hs.headers['set-cookie'] ? hs.headers['set-cookie'].join('; ') : '';
    } catch (e) {
        console.log('[Bhavcopy] Handshake failed, proceeding anyway...');
    }
    await new Promise(r => setTimeout(r, 1000));

    if (backfillDays > 0) {
        let ok = 0, missing = 0, errors = 0;
        for (let off = backfillDays; off >= 0; off--) {   // oldest → newest
            const r = await fetchAndSync(session, cookies, off);
            if (r === 'ok') ok++; else if (r === 'missing') missing++; else errors++;
            if (errors >= 5) { console.error('[Bhavcopy] Too many errors — aborting backfill.'); break; }
            await new Promise(r2 => setTimeout(r2, 400));
        }
        console.log(`[Bhavcopy] Backfill done: ${ok} days synced, ${missing} missing (holidays), ${errors} errors.`);
        if (errors) process.exit(1);
        return;
    }

    const r = await fetchAndSync(session, cookies, 0);
    if (r !== 'ok') {
        console.log('[Bhavcopy] Falling back to previous day...');
        const r2 = await fetchAndSync(session, cookies, 1);
        if (r2 !== 'ok') process.exit(1);
    }
}

run();
