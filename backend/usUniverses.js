// US index universes (S&P 500 with GICS sectors, Nasdaq 100) scraped from
// Wikipedia with a 24h in-memory cache and a hardcoded mega-cap fallback so the
// screener still works if the scrape fails. Symbols use Alpaca's dotted form
// (e.g. BRK.B), which is what the bars API expects.
const cheerio = require('cheerio');

const cache = {}; // key -> { data, ts }
const TTL = 24 * 60 * 60 * 1000;

// Compact fallbacks (used only if the Wikipedia scrape fails). Not exhaustive.
const NASDAQ100_FALLBACK = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'AVGO', 'META', 'GOOGL', 'GOOG', 'TSLA', 'COST',
  'NFLX', 'AMD', 'PEP', 'ADBE', 'LIN', 'CSCO', 'TMUS', 'QCOM', 'INTU', 'AMAT',
  'TXN', 'AMGN', 'ISRG', 'BKNG', 'HON', 'CMCSA', 'ADP', 'VRTX', 'MU', 'LRCX',
  'PANW', 'ADI', 'GILD', 'KLAC', 'REGN', 'SBUX', 'MELI', 'CDNS', 'SNPS', 'CRWD',
  'MAR', 'PYPL', 'ORLY', 'CSX', 'ASML', 'ABNB', 'FTNT', 'CTAS', 'MRVL', 'PCAR',
  'WDAY', 'MNST', 'NXP', 'ROP', 'AEP', 'CPRT', 'ADSK', 'PAYX', 'CHTR', 'DASH',
  'KDP', 'ROST', 'TTD', 'FANG', 'ODFL', 'EA', 'VRSK', 'KHC', 'EXC', 'GEHC',
  'CCEP', 'LULU', 'XEL', 'IDXX', 'CTSH', 'DXCM', 'BKR', 'ON', 'TEAM', 'CSGP',
  'ANSS', 'ZS', 'BIIB', 'MDB',
].map(symbol => ({ symbol, sector: null, name: symbol }));

const SP500_FALLBACK = [
  ['AAPL', 'Information Technology'], ['MSFT', 'Information Technology'], ['NVDA', 'Information Technology'],
  ['AVGO', 'Information Technology'], ['ORCL', 'Information Technology'], ['CRM', 'Information Technology'],
  ['AMD', 'Information Technology'], ['CSCO', 'Information Technology'], ['ACN', 'Information Technology'],
  ['ADBE', 'Information Technology'], ['AMZN', 'Consumer Discretionary'], ['TSLA', 'Consumer Discretionary'],
  ['HD', 'Consumer Discretionary'], ['MCD', 'Consumer Discretionary'], ['NKE', 'Consumer Discretionary'],
  ['LOW', 'Consumer Discretionary'], ['BKNG', 'Consumer Discretionary'], ['META', 'Communication Services'],
  ['GOOGL', 'Communication Services'], ['GOOG', 'Communication Services'], ['NFLX', 'Communication Services'],
  ['DIS', 'Communication Services'], ['TMUS', 'Communication Services'], ['T', 'Communication Services'],
  ['VZ', 'Communication Services'], ['BRK.B', 'Financials'], ['JPM', 'Financials'], ['V', 'Financials'],
  ['MA', 'Financials'], ['BAC', 'Financials'], ['WFC', 'Financials'], ['GS', 'Financials'], ['MS', 'Financials'],
  ['AXP', 'Financials'], ['SPGI', 'Financials'], ['BLK', 'Financials'], ['LLY', 'Health Care'],
  ['UNH', 'Health Care'], ['JNJ', 'Health Care'], ['ABBV', 'Health Care'], ['MRK', 'Health Care'],
  ['TMO', 'Health Care'], ['ABT', 'Health Care'], ['ISRG', 'Health Care'], ['AMGN', 'Health Care'],
  ['PFE', 'Health Care'], ['XOM', 'Energy'], ['CVX', 'Energy'], ['COP', 'Energy'], ['WMB', 'Energy'],
  ['EOG', 'Energy'], ['GE', 'Industrials'], ['CAT', 'Industrials'], ['RTX', 'Industrials'],
  ['HON', 'Industrials'], ['UNP', 'Industrials'], ['BA', 'Industrials'], ['DE', 'Industrials'],
  ['LIN', 'Materials'], ['SHW', 'Materials'], ['FCX', 'Materials'], ['COST', 'Consumer Staples'],
  ['WMT', 'Consumer Staples'], ['PG', 'Consumer Staples'], ['KO', 'Consumer Staples'], ['PEP', 'Consumer Staples'],
  ['PM', 'Consumer Staples'], ['NEE', 'Utilities'], ['SO', 'Utilities'], ['DUK', 'Utilities'],
  ['PLD', 'Real Estate'], ['AMT', 'Real Estate'], ['EQIX', 'Real Estate'],
].map(([symbol, sector]) => ({ symbol, sector, name: symbol }));

async function fetchWikiConstituents(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (kite-dashboard screener)' } });
  if (!resp.ok) throw new Error(`Wikipedia ${resp.status}`);
  const html = await resp.text();
  const $ = cheerio.load(html);

  // Prefer the table with id="constituents"; else the first wikitable whose
  // header row has a Ticker/Symbol column.
  let table = $('#constituents');
  if (!table.length) {
    $('table.wikitable').each((_, el) => {
      if (table.length) return;
      const hs = $(el).find('tr').first().find('th').map((__, h) => $(h).text().trim().toLowerCase()).get();
      if (hs.some(h => h.includes('ticker') || h.includes('symbol'))) table = $(el);
    });
  }
  if (!table.length) throw new Error('constituents table not found');

  const headers = table.find('tr').first().find('th').map((_, el) => $(el).text().trim().toLowerCase()).get();
  const symIdx = headers.findIndex(h => h.includes('symbol') || h.includes('ticker'));
  const secIdx = headers.findIndex(h => h.includes('gics sector'));
  const nameIdx = headers.findIndex(h => h.includes('security') || h.includes('company'));

  const rows = [];
  table.find('tr').slice(1).each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;
    const symbol = $(tds[symIdx >= 0 ? symIdx : 0]).text().trim().replace(/​/g, '').toUpperCase();
    if (!symbol || /\s/.test(symbol)) return;
    rows.push({
      symbol,
      sector: secIdx >= 0 ? ($(tds[secIdx]).text().trim() || null) : null,
      name: nameIdx >= 0 ? ($(tds[nameIdx]).text().trim() || symbol) : symbol,
    });
  });
  return rows;
}

async function getCached(key, url, fallback) {
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  try {
    const rows = await fetchWikiConstituents(url);
    if (rows.length > 50) { cache[key] = { data: rows, ts: Date.now() }; return rows; }
    throw new Error(`only ${rows.length} rows`);
  } catch (e) {
    console.warn(`[usUniverses] ${key} scrape failed (${e.message}); using fallback`);
    if (hit) return hit.data; // stale beats fallback
    return fallback;
  }
}

const getSP500 = () => getCached('sp500', 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies', SP500_FALLBACK);
const getNasdaq100 = () => getCached('nasdaq100', 'https://en.wikipedia.org/wiki/Nasdaq-100', NASDAQ100_FALLBACK);

module.exports = { getSP500, getNasdaq100 };
