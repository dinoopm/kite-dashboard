const axios = require('axios');

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive'
};

async function test() {
    const session = axios.create({ headers, withCredentials: true });
    const handshakeRes = await session.get('https://www.nseindia.com');
    const cookies = handshakeRes.headers['set-cookie'] ? handshakeRes.headers['set-cookie'].join('; ') : '';
    await new Promise(r => setTimeout(r, 1000));
    
    const urls = [
        'https://www.nseindia.com/api/report-asm',
        'https://www.nseindia.com/api/corporates-asm',
        'https://www.nseindia.com/api/surveillance/asm',
        'https://www.nseindia.com/api/market-data-asm',
        'https://www.nseindia.com/api/asm',
        'https://www.nseindia.com/api/gsm'
    ];
    
    for (const u of urls) {
        try {
            const res = await session.get(u, { headers: { ...headers, 'Cookie': cookies } });
            console.log(`[SUCCESS] ${u}`);
        } catch(e) {
            console.log(`[FAIL] ${u} - Status: ${e.response?.status}`);
        }
    }
}
test();
