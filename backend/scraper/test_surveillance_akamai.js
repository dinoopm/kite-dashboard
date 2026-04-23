const axios = require('axios');

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

async function test() {
    const session = axios.create({ headers, withCredentials: true });
    console.log("Handshake...");
    const handshakeRes = await session.get('https://www.nseindia.com');
    const cookies = handshakeRes.headers['set-cookie'] ? handshakeRes.headers['set-cookie'].join('; ') : '';
    
    await new Promise(r => setTimeout(r, 1000));
    
    const urls = [
        'https://archives.nseindia.com/content/equities/asm_latest.csv',
        'https://archives.nseindia.com/content/equities/gsm_latest.csv',
        'https://archives.nseindia.com/content/equities/ASM.csv',
        'https://archives.nseindia.com/content/equities/GSM.csv',
    ];
    
    for (const u of urls) {
        try {
            const res = await session.get(u, {
                headers: { ...headers, 'Cookie': cookies },
                responseType: 'text'
            });
            console.log(`[SUCCESS] ${u} - Preview: ${res.data.substring(0, 100).replace(/\n/g, '\\n')}`);
        } catch(e) {
            console.log(`[FAIL] ${u} - Status: ${e.response?.status}`);
        }
    }
}
test();
