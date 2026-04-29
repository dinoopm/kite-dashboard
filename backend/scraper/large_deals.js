const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest'
};

// Helper to convert DD-MMM-YYYY to YYYY-MM-DD
function formatDateToISO(dateStr) {
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const [day, month, year] = parts;
    return `${year}-${months[month] || month}-${day.padStart(2, '0')}`;
}

// Format DD-MM-YYYY for NSE API URL query
function getTodayNSEFormat() {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

async function fetchDeals(session, url, cookies) {
    try {
        const response = await session.get(url, { headers: { ...headers, 'Cookie': cookies } });
        return response.data.data || [];
    } catch (err) {
        console.error(`Error fetching ${url}: ${err.message}`);
        return [];
    }
}

async function run() {
    try {
        const session = axios.create({ headers, withCredentials: true });

        console.log("Connecting to NSE...");
        const handshakeRes = await session.get('https://www.nseindia.com', {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate'
            }
        });
        const cookies = handshakeRes.headers['set-cookie'] ? handshakeRes.headers['set-cookie'].join('; ') : '';

        await new Promise(r => setTimeout(r, 1000));

        const today = getTodayNSEFormat();
        console.log(`Fetching Bulk and Block deals for ${today}...`);

        const [bulkDeals, blockDeals] = await Promise.all([
            fetchDeals(session, `https://www.nseindia.com/api/historical/bulk-deals?from=${today}&to=${today}`, cookies),
            fetchDeals(session, `https://www.nseindia.com/api/historical/block-deals?from=${today}&to=${today}`, cookies)
        ]);

        const cleanData = [];

        for (const deal of bulkDeals) {
            cleanData.push({
                trade_date: formatDateToISO(deal.date),
                symbol: deal.symbol,
                client_name: deal.clientName,
                deal_type: deal.buyOrSell ? deal.buyOrSell.trim() : 'UNKNOWN',
                quantity: parseInt(String(deal.quantity).replace(/,/g, ''), 10),
                price: parseFloat(String(deal.tradePrice).replace(/,/g, '')),
                deal_category: 'BULK',
                remarks: deal.remarks || null
            });
        }

        for (const deal of blockDeals) {
            cleanData.push({
                trade_date: formatDateToISO(deal.date),
                symbol: deal.symbol,
                client_name: deal.clientName,
                deal_type: deal.buyOrSell ? deal.buyOrSell.trim() : 'UNKNOWN',
                quantity: parseInt(String(deal.quantity).replace(/,/g, ''), 10),
                price: parseFloat(String(deal.tradePrice).replace(/,/g, '')),
                deal_category: 'BLOCK',
                remarks: deal.remarks || null
            });
        }

        if (cleanData.length === 0) {
            console.log("No bulk or block deals found for today.");
            return;
        }

        console.log(`Found ${cleanData.length} deals. Upserting to Supabase...`);

        const { error } = await supabase
            .from('large_deals')
            .upsert(cleanData, { onConflict: 'trade_date, symbol, client_name, deal_type, quantity' });

        if (error) throw error;
        console.log(`✅ Success: Synced ${cleanData.length} large deals.`);

    } catch (err) {
        console.error("❌ Sync Failed:", err.message);
        process.exit(1);
    }
}

run();
