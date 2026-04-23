const axios = require('axios');

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive'
};

async function checkURL(url) {
    try {
        const res = await axios.head(url, { headers });
        console.log(`[SUCCESS] ${url} -> Status: ${res.status}`);
    } catch(e) {
        console.log(`[FAIL] ${url} -> Status: ${e.response?.status || e.message}`);
    }
}

async function run() {
    const urls = [
        'https://archives.nseindia.com/content/equities/asm_latest.csv',
        'https://archives.nseindia.com/content/equities/gsm_latest.csv',
        'https://archives.nseindia.com/content/equities/ASM.csv',
        'https://archives.nseindia.com/content/equities/GSM.csv',
        'https://www.nseindia.com/api/report-asm',
        'https://www.nseindia.com/api/report-gsm'
    ];
    for (const u of urls) {
        await checkURL(u);
    }
}
run();
