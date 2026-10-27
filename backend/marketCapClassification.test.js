'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const { categoryForRank, latestWorkbook, parseWorkbook, enrichMarketCaps, marketCapExposure, createMarketCapLoader } = require('./marketCapClassification');
const { createPortfolioRiskService } = require('./portfolioRisk');

const headers = { A: 'Sr. No.', B: 'Company name', C: 'ISIN', D: 'BSE Symbol', E: 'BSE cap', F: 'NSE Symbol', G: 'NSE cap', H: 'MSEI Symbol', I: 'MSEI cap', J: 'Average of All Exchanges (Rs. Cr.)', K: 'Categorization as per SEBI Circular' };
function fixture({ broken = false } = {}) {
  const escape = value => String(value).replace(/&/g, '&amp;');
  const row = (index, values) => `<row r="${index}">${Object.entries(values).map(([column, value]) => `<c r="${column}${index}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`;
  const data = [row(1, { A: 'AMFI six months ended 30 June 2026' }), row(2, headers)];
  for (let rank = 1; rank <= 251; rank++) data.push(row(rank + 2, { A: rank, B: `Company ${rank}`, C: `INE${String(rank).padStart(9, '0')}`, D: `BSE${rank}`, F: `NSE${rank}`, J: rank === 1 ? '1,23,456.78' : '10000', K: broken && rank === 100 ? 'Small Cap' : categoryForRank(rank) }));
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${data.join('')}</sheetData></worksheet>`) });
}
const metadata = { periodEnd: '2026-06-30', sourceUrl: 'https://portal.amfiindia.com/spages/AverageMarketCapitalization30Jun2026.xlsx' };
test('rank boundaries follow AMFI categories without rupee cutoffs', () => {
  for (const rank of [1, 100]) assert.equal(categoryForRank(rank), 'Large Cap');
  for (const rank of [101, 250]) assert.equal(categoryForRank(rank), 'Mid Cap');
  for (const rank of [251, 9999]) assert.equal(categoryForRank(rank), 'Small Cap');
  for (const rank of [0, -1, null, 1.5]) assert.equal(categoryForRank(rank), 'Unknown');
});
test('discovers the latest published workbook regardless of link order, rejecting untrusted and future links', () => {
  const html = `<a href="https://portal.amfiindia.com/spages/AverageMarketCapitalization31Dec2025.xlsx">old</a><a href="https://example.com/AverageMarketCapitalization31Dec2026.xlsx">bad</a><a href="https://portal.amfiindia.com/spages/AverageMarketCapitalization31Dec2026.xlsx">future</a><a href="${metadata.sourceUrl}">new</a>`;
  assert.deepEqual(latestWorkbook(html, new Date('2026-10-17')), metadata);
  assert.throws(() => latestWorkbook('<a href="https://example.com/list.xlsx">bad</a>'), /unavailable/);
});
test('workbook parsing preserves sparse columns, inline strings and crore values', () => {
  const data = parseWorkbook(fixture(), metadata);
  assert.equal(data.records.length, 251);
  assert.equal(data.records[0].averageMarketCapCr, 123456.78);
  assert.equal(data.records[0].nse, 'NSE1');
  assert.equal(data.records[0].bse, 'BSE1');
  assert.equal(data.records[100].category, 'Mid Cap');
  assert.equal(data.records[250].category, 'Small Cap');
  assert.throws(() => parseWorkbook(fixture({ broken: true })), /do not agree/);
});
test('ISIN takes precedence, and unmatched ETFs or mismatched ISINs remain unknown', () => {
  const catalog = parseWorkbook(fixture(), metadata);
  const out = enrichMarketCaps([
    { symbol: 'RENAMED', exchange: 'NSE', isin: catalog.records[0].isin },
    { symbol: 'NSE101-BE', exchange: 'NSE' },
    { symbol: 'NSE1', exchange: 'NSE', isin: 'INE999999999' },
    { symbol: 'ETF', exchange: 'NSE', isin: 'INF999999999' },
  ], catalog);
  assert.equal(out[0].marketCapCategory, 'Large Cap');
  assert.equal(out[1].marketCapCategory, 'Mid Cap');
  assert.equal(out[2].marketCapCategory, 'Unknown');
  assert.equal(out[3].marketCapCategory, 'Unknown');
});
test('ambiguous exchange tickers do not classify a security without ISIN', () => {
  const records = [{ isin: 'A', nse: 'DUP', category: 'Large Cap' }, { isin: 'B', nse: 'DUP', category: 'Small Cap' }];
  assert.equal(enrichMarketCaps([{ symbol: 'DUP', exchange: 'NSE' }], { records })[0].marketCapCategory, 'Unknown');
});
test('allocation is value weighted and includes unknown holdings in the denominator', () => {
  const result = marketCapExposure([{ marketCapCategory: 'Large Cap', currentValue: 60, symbol: 'L' }, { marketCapCategory: 'Small Cap', currentValue: 30, symbol: 'S' }, { currentValue: 10, symbol: 'U' }], 100);
  assert.equal(result.groups.reduce((sum, item) => sum + item.weightPct, 0), 100);
  assert.equal(result.classificationCoveragePct, 90);
  assert.equal(result.midSmallWeightPct, 30);
  assert.equal(result.groups[3].weightPct, 10);
});
test('service combines T1/duplicate holdings and excludes unpriced securities from market-cap exposure', async () => {
  const catalog = parseWorkbook(fixture(), metadata);
  const service = createPortfolioRiskService({
    fetchHoldings: async () => [{ symbol: 'NSE1', quantity: 1, t1_quantity: 1, last_price: 30, isin: catalog.records[0].isin }, { symbol: 'NSE1', quantity: 1, last_price: 30, isin: catalog.records[0].isin }, { symbol: 'NSE251', quantity: 1, last_price: 10 }, { symbol: 'NSE101', quantity: 1, last_price: null }],
    resolveSector: async () => 'Energy', resolveMarketCaps: async () => catalog,
  });
  const result = await service();
  assert.equal(result.summary.coveredValue, 100);
  assert.equal(result.marketCapitalization.groups[0].weightPct, 90);
  assert.equal(result.marketCapitalization.groups[0].holdingCount, 1);
  assert.equal(result.marketCapitalization.groups[2].weightPct, 10);
  assert.equal(result.coverage.unpricedHoldingCount, 1);
  assert.equal(result.marketCapitalization.periodEnd, '2026-06-30');
});
test('classification failure or timeout preserves the portfolio, with zero classified coverage', async () => {
  for (const resolver of [async () => { throw new Error('outage'); }, () => new Promise(() => {})]) {
    const result = await createPortfolioRiskService({ fetchHoldings: async () => [{ symbol: 'A', quantity: 1, last_price: 100 }], resolveSector: async () => 'Energy', resolveMarketCaps: resolver, marketCapTimeoutMs: 5 })();
    assert.equal(result.summary.coveredValue, 100);
    assert.equal(result.marketCapitalization.classificationCoveragePct, 0);
    assert.equal(result.marketCapitalization.groups[3].weightPct, 100);
    assert.equal(result.positions[0].sector, 'Energy');
  }
});
test('seeded public classification is immediately usable during a website outage', async () => {
  const seed = parseWorkbook(fixture(), metadata);
  let calls = 0;
  const load = createMarketCapLoader({ seed, fetcher: async () => { calls++; throw new Error('site unavailable'); } });
  assert.equal(await load(), seed);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await load(), seed);
  assert.equal(calls, 1);
});
test('bundled official reference has 100 large, 150 mid and only explicit small-cap classifications', () => {
  const catalog = require('./data/amfiMarketCaps.json');
  assert.equal(catalog.records.filter(item => item.category === 'Large Cap').length, 100);
  assert.equal(catalog.records.filter(item => item.category === 'Mid Cap').length, 150);
  assert.ok(catalog.records.length > 250);
  assert.ok(catalog.records.every(item => item.category === categoryForRank(item.rank)));
});
