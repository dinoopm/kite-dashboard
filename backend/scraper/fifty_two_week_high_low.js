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

const MONTHS = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
};

function parseNseDate(s) {
    if (!s) return null;
    const cleaned = s.trim().replace(/^"|"$/g, '');
    const m = cleaned.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (!m) return null;
    const day = m[1].padStart(2, '0');
    const month = MONTHS[m[2].toUpperCase()];
    if (!month) return null;
    return `${m[3]}-${month}-${day}`;
}

function parseCsvLine(line) {
    const cols = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            cols.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    cols.push(cur);
    return cols.map(c => c.trim());
}

function findHeaderIndex(headerCols, candidates) {
    const normalized = headerCols.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    for (const cand of candidates) {
        const target = cand.toLowerCase().replace(/[^a-z0-9]/g, '');
        const idx = normalized.indexOf(target);
        if (idx !== -1) return idx;
    }
    return -1;
}

async function fetchAndSync(offsetDays = 0) {
    const { dateStr, dbDate } = getISTDateString(offsetDays);
    const session = axios.create({ headers, withCredentials: true });

    console.log(`[52W Scraper] Initiating handshake for ${dateStr}...`);
    let cookies = '';
    try {
        const handshakeRes = await session.get('https://www.nseindia.com', { timeout: 10000 });
        cookies = handshakeRes.headers['set-cookie'] ? handshakeRes.headers['set-cookie'].join('; ') : '';
    } catch (e) {
        console.log(`[52W Scraper] Handshake failed, proceeding anyway...`);
    }

    await new Promise(r => setTimeout(r, 1000));

    const url = `https://archives.nseindia.com/content/CM_52_wk_High_low_${dateStr}.csv`;
    console.log(`[52W Scraper] Fetching CSV: ${url}`);

    try {
        const res = await session.get(url, {
            headers: { ...headers, 'Cookie': cookies },
            responseType: 'text',
            timeout: 15000
        });

        const lines = res.data.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        if (lines.length < 2) {
            throw new Error('Empty or unexpected CSV');
        }

        // Scan up to first 10 lines for the row that looks like a header (contains SYMBOL).
        let headerRowIdx = -1;
        for (let i = 0; i < Math.min(10, lines.length); i++) {
            if (/(^|,)\s*"?SYMBOL"?\s*(,|$)/i.test(lines[i])) {
                headerRowIdx = i;
                break;
            }
        }
        if (headerRowIdx < 0) {
            console.error(`[52W Scraper] First 5 raw lines:`);
            lines.slice(0, 5).forEach((l, i) => console.error(`  ${i}: ${l.slice(0, 200)}`));
            throw new Error('Could not locate header row containing SYMBOL');
        }
        const headerCols = parseCsvLine(lines[headerRowIdx]);
        console.log(`[52W Scraper] Header at line ${headerRowIdx}: ${headerCols.join(' | ')}`);

        const idxSymbol = findHeaderIndex(headerCols, ['SYMBOL']);
        const idxSeries = findHeaderIndex(headerCols, ['SERIES']);
        const idxName = findHeaderIndex(headerCols, ['SECURITY NAME', 'Security Name', 'COMPANY NAME']);
        const idxHigh = findHeaderIndex(headerCols, ['Adjusted 52_Week_High', 'Adjusted_52_Week_High', '52 Week High', '52_Week_High']);
        const idxHighDt = findHeaderIndex(headerCols, ['52_Week_High_Date', '52_Week_High_DT', '52 Week High Date']);
        const idxLow = findHeaderIndex(headerCols, ['Adjusted 52_Week_Low', 'Adjusted_52_Week_Low', '52 Week Low', '52_Week_Low']);
        const idxLowDt = findHeaderIndex(headerCols, ['52_Week_Low_Date', '52_Week_Low_DT', '52 Week Low Date']);

        if (idxSymbol < 0 || idxHigh < 0 || idxLow < 0) {
            throw new Error(`Could not locate required columns. Headers: ${headerCols.join(' | ')}`);
        }

        const records = [];
        for (let i = headerRowIdx + 1; i < lines.length; i++) {
            const cols = parseCsvLine(lines[i]);
            if (!cols[idxSymbol]) continue;
            records.push({
                trade_date: dbDate,
                symbol: cols[idxSymbol],
                series: idxSeries >= 0 ? (cols[idxSeries] || '') : '',
                company_name: idxName >= 0 ? (cols[idxName] || null) : null,
                adjusted_52_week_high: parseFloat(cols[idxHigh]) || null,
                high_date: idxHighDt >= 0 ? parseNseDate(cols[idxHighDt]) : null,
                adjusted_52_week_low: parseFloat(cols[idxLow]) || null,
                low_date: idxLowDt >= 0 ? parseNseDate(cols[idxLowDt]) : null
            });
        }

        // Dedupe by PK (trade_date, symbol, series) — CSV can contain repeat rows.
        const dedup = new Map();
        for (const r of records) {
            dedup.set(`${r.trade_date}|${r.symbol}|${r.series}`, r);
        }
        const deduped = Array.from(dedup.values());
        if (deduped.length !== records.length) {
            console.log(`[52W Scraper] Deduped ${records.length - deduped.length} duplicate rows.`);
        }

        console.log(`[52W Scraper] Upserting ${deduped.length} rows to Supabase in batches...`);

        const BATCH = 500;
        for (let i = 0; i < deduped.length; i += BATCH) {
            const chunk = deduped.slice(i, i + BATCH);
            const { error } = await supabase
                .from('nse_52_week_high_low')
                .upsert(chunk, { onConflict: 'trade_date,symbol,series' });
            if (error) {
                console.error(`[52W Scraper] Supabase Upsert Error at batch ${i}:`, error);
                process.exit(1);
            }
        }

        console.log(`[52W Scraper] Successfully synced ${deduped.length} rows for ${dbDate}`);
        return true;
    } catch (e) {
        if (e.response && e.response.status === 404) {
            console.log(`[52W Scraper] Data for ${dateStr} not available yet (404).`);
            return false;
        } else if (e.response && e.response.status === 403) {
            console.error(`[52W Scraper] Access Denied (403). Akamai blocked the request.`);
            return false;
        } else {
            console.error(`[52W Scraper] Error fetching/parsing CSV:`, e.message);
            return false;
        }
    }
}

async function run() {
    let success = await fetchAndSync(0);
    if (!success) {
        console.log(`[52W Scraper] Falling back to previous day...`);
        success = await fetchAndSync(1);
    }
}

run();
