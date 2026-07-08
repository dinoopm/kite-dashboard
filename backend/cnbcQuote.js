// ─── CNBC live quote (US 10Y Treasury) ───────────────────────────────────────
// Yahoo's ^TNX index lags a full session, so the LIVE 10Y yield comes from
// CNBC's real-time US10Y quote (matches cnbc.com/Google). Shared by the
// Treasury chart route (alpaca.js) and the risk-regime panel (riskRegime.js)
// so both show the same number.
const axios = require('axios');

const num = (s) => { const n = parseFloat(String(s).replace(/[%+,]/g, '')); return isFinite(n) ? n : null; };

// { last, change, prev, time } — yields in percent. Throws on failure so
// callers can fall back to Yahoo.
async function cnbcUs10y() {
  const r = await axios.get(
    'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US10Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json',
    { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }, timeout: 12000 }
  );
  const d = r.data?.FormattedQuoteResult?.FormattedQuote?.[0];
  if (!d) throw new Error('CNBC quote empty');
  return { last: num(d.last), change: num(d.change), prev: num(d.previous_day_closing), time: d.last_time || null };
}

module.exports = { cnbcUs10y };
