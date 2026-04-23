const axios = require('axios');

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
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
    
    try {
        const res = await session.get('https://www.nseindia.com/market-data/additional-surveillance-measure', {
            headers: { ...headers, 'Cookie': cookies }
        });
        const matches = res.data.match(/[^"']+\.csv/g);
        console.log("Found CSV links in HTML:", [...new Set(matches)]);
    } catch(e) {
        console.error(e.message);
    }
}
test();
