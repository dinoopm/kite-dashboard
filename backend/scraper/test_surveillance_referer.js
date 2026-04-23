const axios = require('axios');

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive'
};

async function test() {
    const session = axios.create({ headers, withCredentials: true });
    const handshakeRes = await session.get('https://www.nseindia.com');
    const cookies = handshakeRes.headers['set-cookie'] ? handshakeRes.headers['set-cookie'].join('; ') : '';
    await new Promise(r => setTimeout(r, 1000));
    
    try {
        const res = await session.get('https://www.nseindia.com/api/report-asm', {
            headers: { ...headers, 'Cookie': cookies, 'Referer': 'https://www.nseindia.com/reports/asm' }
        });
        console.log(`[SUCCESS] ASM -> `, Object.keys(res.data));
    } catch(e) {
        console.log(`[FAIL] ASM - Status: ${e.response?.status}`);
    }

    try {
        const res = await session.get('https://www.nseindia.com/api/report-gsm', {
            headers: { ...headers, 'Cookie': cookies, 'Referer': 'https://www.nseindia.com/regulations/graded-surveillance-measure' }
        });
        console.log(`[SUCCESS] GSM -> `, Object.keys(res.data));
    } catch(e) {
        console.log(`[FAIL] GSM - Status: ${e.response?.status}`);
    }
}
test();
