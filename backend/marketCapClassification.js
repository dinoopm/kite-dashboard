'use strict';

const cheerio = require('cheerio');
const { unzipSync, strFromU8 } = require('fflate');
const PAGE_URL = 'https://www.amfiindia.com/otherdata/categorisation-of-stocks';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CATEGORIES = ['Large Cap', 'Mid Cap', 'Small Cap', 'Unknown'];
const categoryForRank = rank => Number.isInteger(rank) && rank > 0 ? rank <= 100 ? 'Large Cap' : rank <= 250 ? 'Mid Cap' : 'Small Cap' : 'Unknown';
const cleanSymbol = value => String(value || '').trim().toUpperCase().replace(/-(BE|SM|EQ)$/, '');

function latestWorkbook(html, now = new Date()) {
  const $ = cheerio.load(html);
  const candidates = $('a[href]').toArray().flatMap(anchor => {
    let url;
    try { url = new URL($(anchor).attr('href'), PAGE_URL); } catch { return []; }
    if (!['www.amfiindia.com', 'portal.amfiindia.com'].includes(url.hostname) || url.protocol !== 'https:') return [];
    const match = decodeURIComponent(url.pathname).match(/AverageMarketCapitalization(\d{1,2})([A-Za-z]+)(\d{4})\.xlsx$/i);
    if (!match) return [];
    const month = MONTHS.findIndex(name => name.toLowerCase() === match[2].slice(0, 3).toLowerCase());
    if (month < 0) return [];
    const periodEnd = new Date(Date.UTC(+match[3], month, +match[1]));
    if (periodEnd.getUTCMonth() !== month || periodEnd > now) return [];
    return [{ sourceUrl: url.href, periodEnd: periodEnd.toISOString().slice(0, 10) }];
  });
  candidates.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  if (!candidates.length) throw new Error('AMFI classification workbook is unavailable');
  return candidates[0];
}

function workbookRows(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const shared = files['xl/sharedStrings.xml'] ? cheerio.load(strFromU8(files['xl/sharedStrings.xml']), { xmlMode: true }) : null;
  const strings = shared ? shared('si').toArray().map(item => shared(item).find('t').toArray().map(t => shared(t).text()).join('')) : [];
  const sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('AMFI workbook has no classification sheet');
  const $ = cheerio.load(strFromU8(sheet), { xmlMode: true });
  return $('row').toArray().map(row => {
    const values = {};
    $(row).find('c').each((_, cell) => {
      const c = $(cell), column = (c.attr('r') || '').replace(/\d/g, '');
      const raw = c.find('v').first().text();
      values[column] = c.attr('t') === 's' ? strings[Number(raw)] || '' : c.attr('t') === 'inlineStr' ? c.find('t').text() : raw;
    });
    return values;
  });
}

function parseWorkbook(buffer, metadata = {}) {
  const rows = workbookRows(buffer);
  const headerIndex = rows.findIndex(row => Object.values(row).some(value => value.trim().toUpperCase() === 'ISIN'));
  if (headerIndex < 0) throw new Error('AMFI classification headers are missing');
  const header = rows[headerIndex];
  const col = pattern => Object.keys(header).find(key => pattern.test(header[key].trim()));
  const columns = { rank: col(/^Sr\.?\s*No\.?$/i), isin: col(/^ISIN$/i), nse: col(/^NSE Symbol$/i), bse: col(/^BSE Symbol$/i), average: col(/^Average of All Exchanges/i), category: col(/^Categorization|^Categorisation/i) };
  if (Object.values(columns).some(value => !value)) throw new Error('AMFI classification columns have changed');
  const records = [], seen = new Set();
  for (const row of rows.slice(headerIndex + 1)) {
    const isin = String(row[columns.isin] || '').trim().toUpperCase();
    const rank = Number(row[columns.rank]);
    if (!/^IN[A-Z0-9]{10}$/.test(isin) || !Number.isInteger(rank) || rank < 1 || seen.has(isin)) continue;
    const category = categoryForRank(rank);
    if (String(row[columns.category] || '').trim().toLowerCase() !== category.toLowerCase()) throw new Error('AMFI rank and category do not agree');
    const average = Number(String(row[columns.average] || '').replace(/,/g, ''));
    const nse = cleanSymbol(row[columns.nse]), bse = cleanSymbol(row[columns.bse]);
    records.push({ isin, rank, category, nse: nse === '-' ? '' : nse, bse: bse === '-' ? '' : bse, averageMarketCapCr: Number.isFinite(average) && average > 0 ? average : null });
    seen.add(isin);
  }
  if (records.length < 251 || !records.some(item => item.rank === 100) || !records.some(item => item.rank === 250) || !records.some(item => item.rank === 251)) throw new Error('AMFI classification coverage is incomplete');
  return { ...metadata, records, source: 'AMFI', pageUrl: PAGE_URL };
}

function enrichMarketCaps(holdings, catalog) {
  const byIsin = new Map(), bySymbol = new Map();
  for (const record of catalog?.records || []) {
    byIsin.set(record.isin, record);
    for (const [exchange, symbol] of [['NSE', record.nse], ['BSE', record.bse]]) {
      if (!symbol) continue;
      const key = `${exchange}:${symbol}`;
      bySymbol.set(key, bySymbol.has(key) ? null : record);
    }
  }
  return holdings.map(position => {
    // An ISIN mismatch must not classify a different security with a similar ticker.
    const match = position.isin ? byIsin.get(position.isin) : bySymbol.get(`${position.exchange}:${cleanSymbol(position.symbol)}`);
    return { ...position, marketCapCategory: match?.category || 'Unknown', marketCapRank: match?.rank ?? null, averageMarketCapCr: match?.averageMarketCapCr ?? null };
  });
}

function marketCapExposure(positions, coveredValue) {
  const groups = CATEGORIES.map(category => ({ category, currentValue: 0, holdingCount: 0, symbols: [], weightPct: 0 }));
  for (const position of positions) {
    const group = groups.find(item => item.category === position.marketCapCategory) || groups.at(-1);
    group.currentValue += position.currentValue;
    group.holdingCount += 1;
    group.symbols.push(position.symbol);
  }
  for (const group of groups) group.weightPct = coveredValue > 0 ? group.currentValue / coveredValue * 100 : 0;
  const unknown = groups.at(-1);
  return { groups, classifiedValue: coveredValue - unknown.currentValue, classificationCoveragePct: coveredValue > 0 ? (coveredValue - unknown.currentValue) / coveredValue * 100 : 0, midSmallWeightPct: groups[1].weightPct + groups[2].weightPct };
}

function createMarketCapLoader({ fetcher = fetch, now = () => new Date(), seed = null } = {}) {
  let cache = seed, inFlight, failedAt = 0, checkedAt = 0;
  async function request(url, binary = false) {
    const response = await fetcher(url, { headers: { 'User-Agent': 'Kite-Analytics market-cap classification' }, signal: AbortSignal.timeout(6500) });
    if (!response.ok) throw new Error(`AMFI returned HTTP ${response.status}`);
    return binary ? response.arrayBuffer() : response.text();
  }
  return async function loadMarketCaps() {
    if (cache && checkedAt && now().getTime() - checkedAt < 24 * 60 * 60 * 1000) return cache;
    if (!inFlight) {
      if (failedAt && now().getTime() - failedAt < 60000) return cache;
      inFlight = (async () => {
        const metadata = latestWorkbook(await request(PAGE_URL), now());
        const next = parseWorkbook(await request(metadata.sourceUrl, true), { ...metadata, fetchedAt: now().toISOString() });
        cache = next;
        checkedAt = now().getTime();
        failedAt = 0;
        return next;
      })().catch(() => { failedAt = now().getTime(); return cache; }).finally(() => { inFlight = null; });
    }
    return cache || inFlight;
  };
}

const loadMarketCapClassifications = createMarketCapLoader({ seed: require('./data/amfiMarketCaps.json') });
module.exports = { PAGE_URL, CATEGORIES, categoryForRank, latestWorkbook, parseWorkbook, enrichMarketCaps, marketCapExposure, createMarketCapLoader, loadMarketCapClassifications };
