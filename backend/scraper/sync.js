const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
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

// Helper to convert '22-Apr-2026' to '2026-04-22'
function formatDate(dateStr) {
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const [day, month, year] = dateStr.split('-');
    return `${year}-${months[month]}-${day.padStart(2, '0')}`;
}

async function run() {
    try {
        const session = axios.create({ headers, withCredentials: true });

        // 1. Handshake: Visit home page to get cookies
        console.log("Connecting to NSE...");
        const handshakeRes = await session.get('https://www.nseindia.com');
        const cookies = handshakeRes.headers['set-cookie'] ? handshakeRes.headers['set-cookie'].join('; ') : '';

        // Add a small delay
        await new Promise(r => setTimeout(r, 1000));

        // 2. Fetch Data
        const response = await session.get('https://www.nseindia.com/api/fiidiiTradeReact', {
            headers: {
                ...headers,
                'Cookie': cookies
            }
        });
        const rawData = response.data;

        // 3. Format Data
        if (!Array.isArray(rawData) || rawData.length === 0) {
            throw new Error("Invalid or empty data received from NSE");
        }

        const dateStr = rawData[0].date;
        const dii = rawData.find(d => d.category === 'DII');
        const fii = rawData.find(d => d.category === 'FII/FPI');

        const cleanData = [{
            trade_date: formatDate(dateStr),
            fii_buy: parseFloat((fii.buyValue || '0').replace(/,/g, '')),
            fii_sell: parseFloat((fii.sellValue || '0').replace(/,/g, '')),
            fii_net: parseFloat((fii.netValue || '0').replace(/,/g, '')),
            dii_buy: parseFloat((dii.buyValue || '0').replace(/,/g, '')),
            dii_sell: parseFloat((dii.sellValue || '0').replace(/,/g, '')),
            dii_net: parseFloat((dii.netValue || '0').replace(/,/g, ''))
        }];

        // 4. Upsert to Supabase
        const { error } = await supabase
            .from('fii_dii_activity')
            .upsert(cleanData, { onConflict: 'trade_date' });

        if (error) throw error;
        console.log(`✅ Success: Synced ${cleanData.length} days of institutional data.`);

    } catch (err) {
        console.error("❌ Sync Failed:", err.message);
        process.exit(1);
    }
}

run();