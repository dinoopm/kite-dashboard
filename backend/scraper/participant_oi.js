const axios = require('axios');
const fs = require('fs');
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

async function fetchAndSyncOI(offsetDays = 0) {
    const { dateStr, dbDate } = getISTDateString(offsetDays);
    const session = axios.create({ headers, withCredentials: true });
    
    console.log(`[OI Scraper] Initiating handshake for ${dateStr}...`);
    let cookies = '';
    try {
        const handshakeRes = await session.get('https://www.nseindia.com', { timeout: 10000 });
        cookies = handshakeRes.headers['set-cookie'] ? handshakeRes.headers['set-cookie'].join('; ') : '';
    } catch(e) {
        console.log(`[OI Scraper] Handshake failed, proceeding anyway...`);
    }

    await new Promise(r => setTimeout(r, 1000));
    
    const url = `https://archives.nseindia.com/content/nsccl/fao_participant_oi_${dateStr}.csv`;
    console.log(`[OI Scraper] Fetching CSV: ${url}`);
    
    try {
        const res = await session.get(url, {
            headers: { ...headers, 'Cookie': cookies },
            responseType: 'text',
            timeout: 10000
        });

        const lines = res.data.split('\n').map(l => l.trim()).filter(l => l);
        // The first row is the title, the second is headers
        if (lines.length < 5 || !lines[0].includes('Participant wise Open Interest')) {
            throw new Error('Unexpected CSV format');
        }

        const dataRows = lines.slice(2);
        const records = [];

        for (const row of dataRows) {
            const cols = row.split(',').map(c => c.trim());
            if (cols.length < 15) continue;

            // cols[0] is Client Type ('Client', 'DII', 'FII', 'Pro', 'TOTAL')
            if (cols[0] === 'TOTAL') continue;

            records.push({
                trade_date: dbDate,
                client_type: cols[0],
                future_index_long: parseInt(cols[1], 10) || 0,
                future_index_short: parseInt(cols[2], 10) || 0,
                future_stock_long: parseInt(cols[3], 10) || 0,
                future_stock_short: parseInt(cols[4], 10) || 0,
                option_index_call_long: parseInt(cols[5], 10) || 0,
                option_index_put_long: parseInt(cols[6], 10) || 0,
                option_index_call_short: parseInt(cols[7], 10) || 0,
                option_index_put_short: parseInt(cols[8], 10) || 0,
                option_stock_call_long: parseInt(cols[9], 10) || 0,
                option_stock_put_long: parseInt(cols[10], 10) || 0,
                option_stock_call_short: parseInt(cols[11], 10) || 0,
                option_stock_put_short: parseInt(cols[12], 10) || 0,
                total_long_contracts: parseInt(cols[13], 10) || 0,
                total_short_contracts: parseInt(cols[14], 10) || 0
            });
        }

        console.log(`[OI Scraper] Parsed ${records.length} rows. Upserting to Supabase...`);
        const { data, error } = await supabase
            .from('participant_oi')
            .upsert(records, { onConflict: 'trade_date,client_type' });

        if (error) {
            console.error('[OI Scraper] Supabase Upsert Error:', error);
            process.exit(1);
        }

        console.log(`[OI Scraper] Successfully synced OI data for ${dbDate}`);
        return true;
    } catch(e) {
        if (e.response && e.response.status === 404) {
            console.log(`[OI Scraper] Data for ${dateStr} not available yet (404).`);
            return false;
        } else if (e.response && e.response.status === 403) {
            console.error(`[OI Scraper] Access Denied (403). Akamai blocked the request.`);
            return false;
        } else {
            console.error(`[OI Scraper] Error fetching/parsing CSV:`, e.message);
            return false;
        }
    }
}

async function run() {
    // Try today first
    let success = await fetchAndSyncOI(0);
    if (!success) {
        // If today failed (probably not uploaded yet), try yesterday
        console.log(`[OI Scraper] Falling back to previous day...`);
        success = await fetchAndSyncOI(1);
    }
}

run();
