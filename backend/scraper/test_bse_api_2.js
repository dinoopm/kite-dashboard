const axios = require('axios');

async function test() {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.bseindia.com',
        'Referer': 'https://www.bseindia.com/',
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty'
    };
    try {
        const asm = await axios.get('https://api.bseindia.com/BseIndiaAPI/api/Surveillance/w', { headers });
        console.log("BSE ASM Success. Keys:", Object.keys(asm.data || {}));
        if (asm.data && asm.data.Table) {
             console.log("Table length:", asm.data.Table.length);
             console.log("Sample:", asm.data.Table[0]);
        } else {
             console.log("Preview:", String(asm.data).substring(0, 200));
        }
    } catch(e) {
        console.log("BSE ASM Fail:", e.message);
    }
}
test();
