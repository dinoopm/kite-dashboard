const fetch = require('node-fetch'); // we can use native fetch or https

async function check() {
  // get token for NIFTY REALTY first
  const qRes = await fetch('http://localhost:3001/api/quotes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: ["NSE:NIFTY REALTY"] })
  });
  const qData = await qRes.json();
  const qJSON = JSON.parse(qData.content[0].text);
  const token = qJSON["NSE:NIFTY REALTY"].instrument_token;
  const currentPrice = qJSON["NSE:NIFTY REALTY"].last_price;
  console.log("Current Price:", currentPrice, "Token:", token);

  const hRes = await fetch(`http://localhost:3001/api/historical/${token}?tf=5Y`);
  const hData = await hRes.json();
  const series = JSON.parse(hData.content[0].text).sort((a,b) => new Date(a.date) - new Date(b.date));

  const now = new Date();
  now.setHours(0,0,0,0);

  const getPriceAtDate = (targetDate) => {
    let closestClose = series[0].close;
    for (let i = series.length - 1; i >= 0; i--) {
      const cDate = new Date(series[i].date);
      if (cDate <= targetDate) {
        closestClose = series[i].close;
        break;
      }
    }
    return closestClose;
  };

  const calcPct = (oldPrice) => ((currentPrice - oldPrice) / oldPrice) * 100;

  const d1M = new Date(now); d1M.setMonth(now.getMonth() - 1);
  const d1Y = new Date(now); d1Y.setFullYear(now.getFullYear() - 1);
  const d3Y = new Date(now); d3Y.setFullYear(now.getFullYear() - 3);
  const d5Y = new Date(now); d5Y.setFullYear(now.getFullYear() - 5);

  console.log({
    '1M': calcPct(getPriceAtDate(d1M)).toFixed(2) + '%',
    '1Y': calcPct(getPriceAtDate(d1Y)).toFixed(2) + '%',
    '3Y': calcPct(getPriceAtDate(d3Y)).toFixed(2) + '%',
    '5Y': calcPct(getPriceAtDate(d5Y)).toFixed(2) + '%',
  });
}
check();
