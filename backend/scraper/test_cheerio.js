const axios = require('axios');

async function test() {
    const headers = {
        'User-Agent': 'Mozilla/5.0'
    };
    try {
        const asm = await axios.get('https://api.bseindia.com/BseIndiaAPI/api/Surveillance/w', { headers });
        console.log("HTML length:", asm.data.length);
        console.log("Contains table?", asm.data.includes('<table'));
        console.log("Contains tr?", asm.data.includes('<tr'));
        console.log("Contains td?", asm.data.includes('<td'));
        console.log(asm.data.substring(0, 500));
    } catch(e) {
        console.log("BSE ASM Fail:", e.message);
    }
}
test();
