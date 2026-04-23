const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const csv = require('csv-parse/sync');

// Load environment variables
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Setup axios with NSE Akamai bypass headers
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

const session = axios.create({ headers, withCredentials: true, timeout: 15000 });

async function syncSurveillance() {
  try {
    console.log("[Surveillance Scraper] Initiating handshake...");
    const handshakeRes = await session.get('https://www.nseindia.com');
    const cookies = handshakeRes.headers['set-cookie'] ? handshakeRes.headers['set-cookie'].join('; ') : '';
    
    await new Promise(r => setTimeout(r, 1000));
    
    const asmUrl = process.env.NSE_ASM_URL || 'https://archives.nseindia.com/content/equities/asm_latest.csv';
    const gsmUrl = process.env.NSE_GSM_URL || 'https://archives.nseindia.com/content/equities/gsm_latest.csv';
    
    let affectedStocks = [];

    // 1. Fetch ASM
    try {
        console.log("[Surveillance Scraper] Fetching ASM list...");
        const asmRes = await session.get(asmUrl, {
            headers: { ...headers, 'Cookie': cookies },
            responseType: 'text'
        });
        
        const records = csv.parse(asmRes.data, { columns: true, skip_empty_lines: true });
        records.forEach(row => {
             const symbol = row['Symbol'] || row['SYMBOL'];
             if (symbol) {
                 affectedStocks.push({ symbol: symbol.trim(), measure: 'ASM' });
             }
        });
        console.log(`[Surveillance Scraper] Parsed ${records.length} ASM stocks.`);
    } catch(e) {
        console.error("[Surveillance Scraper] Failed to fetch ASM:", e.message);
    }

    // 2. Fetch GSM
    try {
        console.log("[Surveillance Scraper] Fetching GSM list...");
        const gsmRes = await session.get(gsmUrl, {
            headers: { ...headers, 'Cookie': cookies },
            responseType: 'text'
        });
        
        const records = csv.parse(gsmRes.data, { columns: true, skip_empty_lines: true });
        records.forEach(row => {
             const symbol = row['Symbol'] || row['SYMBOL'];
             if (symbol) {
                 affectedStocks.push({ symbol: symbol.trim(), measure: 'GSM' });
             }
        });
        console.log(`[Surveillance Scraper] Parsed ${records.length} GSM stocks.`);
    } catch(e) {
        console.error("[Surveillance Scraper] Failed to fetch GSM:", e.message);
    }

    if (affectedStocks.length === 0) {
        console.warn("[Surveillance Scraper] No stocks found. Both URLs may have failed or changed.");
        return;
    }

    console.log(`[Surveillance Scraper] Total surveillance stocks found: ${affectedStocks.length}. Upserting to Supabase...`);

    // We first clear the table to remove stocks that are no longer under surveillance
    // Be careful here in a production app with multiple concurrent readers, 
    // but for a weekly batch update this is the simplest way to clear old state.
    const { error: deleteErr } = await supabase.from('surveillance_stocks').delete().neq('symbol', 'DUMMY');
    if (deleteErr) throw new Error("Failed to clear old surveillance data: " + deleteErr.message);

    // Upsert new list
    const { error: insertErr } = await supabase
        .from('surveillance_stocks')
        .upsert(affectedStocks, { onConflict: 'symbol' });
        
    if (insertErr) throw new Error("Supabase Insert Error: " + insertErr.message);

    console.log("[Surveillance Scraper] Successfully synced surveillance data.");

  } catch (err) {
    console.error("[Surveillance Scraper] Fatal Error:", err);
    process.exit(1);
  }
}

syncSurveillance();
