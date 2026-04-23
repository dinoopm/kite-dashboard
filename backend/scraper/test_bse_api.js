const axios = require('axios');

async function test() {
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    try {
        const asm = await axios.get('https://api.bseindia.com/BseIndiaAPI/api/Surveillance/w', { headers });
        console.log("BSE ASM Success. First 200 chars:", JSON.stringify(asm.data).substring(0, 200));
    } catch(e) {
        console.log("BSE ASM Fail:", e.message);
    }
    
    try {
        const gsm = await axios.get('https://api.bseindia.com/BseIndiaAPI/api/GSM_list/w', { headers });
        console.log("BSE GSM Success. First 200 chars:", JSON.stringify(gsm.data).substring(0, 200));
    } catch(e) {
        console.log("BSE GSM Fail:", e.message);
    }
}
test();
