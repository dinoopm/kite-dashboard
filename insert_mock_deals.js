const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
    const today = new Date().toISOString().slice(0, 10);
    const mockDeals = [
        {
            trade_date: today,
            symbol: 'TATAPOWER',
            client_name: 'VANGUARD EMERGING MARKETS STOCK INDEX FUND',
            deal_type: 'BUY',
            quantity: 2500000,
            price: 435.50,
            deal_category: 'BULK',
            remarks: 'Mock Deal'
        },
        {
            trade_date: today,
            symbol: 'TATAPOWER',
            client_name: 'BLACKROCK GLOBAL FUNDS',
            deal_type: 'SELL',
            quantity: 2500000,
            price: 435.50,
            deal_category: 'BULK',
            remarks: 'Mock Deal'
        },
        {
            trade_date: today,
            symbol: 'RELIANCE',
            client_name: 'NORGES BANK ON ACCOUNT OF THE GOVERNMENT PENSION FUND GLOBAL',
            deal_type: 'BUY',
            quantity: 1200000,
            price: 2950.00,
            deal_category: 'BLOCK',
            remarks: 'Mock Deal'
        }
    ];

    console.log("Inserting mock data into Supabase...");
    const { error } = await supabase
        .from('large_deals')
        .upsert(mockDeals, { onConflict: 'trade_date, symbol, client_name, deal_type, quantity' });

    if (error) {
        console.error("Error inserting mock data:", error);
    } else {
        console.log("Successfully inserted mock deals into Supabase!");
    }
}

run();
