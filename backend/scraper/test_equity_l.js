const axios = require('axios');

async function test() {
    try {
        const res = await axios.get('https://archives.nseindia.com/content/equities/EQUITY_L.csv');
        console.log("EQUITY_L Preview:", res.data.substring(0, 500));
    } catch(e) {
        console.log("EQUITY_L Fail:", e.message);
    }
}
test();
