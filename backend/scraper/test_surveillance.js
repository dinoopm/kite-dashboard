const axios = require('axios');

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
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
    
    console.log("Fetching ASM...");
    try {
        const asmRes = await session.get('https://www.nseindia.com/api/asm', {
            headers: { ...headers, 'Cookie': cookies }
        });
        console.log("ASM Data Keys:", Object.keys(asmRes.data || {}));
        if (asmRes.data.data) {
             console.log("ASM Sample:", asmRes.data.data.slice(0, 2));
        }
    } catch(e) {
        console.error("ASM Error:", e.message);
    }

    console.log("Fetching GSM...");
    try {
        const gsmRes = await session.get('https://www.nseindia.com/api/gsm', {
            headers: { ...headers, 'Cookie': cookies }
        });
        console.log("GSM Data Keys:", Object.keys(gsmRes.data || {}));
        if (gsmRes.data.data) {
             console.log("GSM Sample:", gsmRes.data.data.slice(0, 2));
        }
    } catch(e) {
        console.error("GSM Error:", e.message);
    }
}
test();
