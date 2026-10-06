'use strict';
const axios = require('axios');
const { parse } = require('csv-parse/sync');
const CAP_GROUPS = [
  { id: 'large', label: 'Large cap · Nifty 50', file: 'ind_nifty50list.csv', minimum: 45 },
  { id: 'mid', label: 'Mid cap · Nifty Midcap 100', file: 'ind_niftymidcap100list.csv', minimum: 90 },
  { id: 'small', label: 'Small cap · Nifty Smallcap 250', file: 'ind_niftysmallcap250list.csv', minimum: 225 },
];
const urlFor = group => `https://www.niftyindices.com/IndexConstituent/${group.file}`;
function validateCaps(caps) {
  if (!Array.isArray(caps) || !caps.length || caps.length > 3 || caps.some(id => !CAP_GROUPS.some(group => group.id === id)) || new Set(caps).size !== caps.length) throw new Error('Choose at least one valid cap group (large, mid, small).');
}
function parseConstituents(csv, group) {
  const rows = parse(csv, { columns: true, bom: true, skip_empty_lines: true, trim: true });
  if (!rows.length || !('Symbol' in rows[0]) || !('Company Name' in rows[0]) || !('ISIN Code' in rows[0])) throw new Error(`${group.label}: constituent format changed`);
  const eligible = rows.filter(row => ['EQ', 'BE'].includes(row.Series) && !/^DUM/.test(row['ISIN Code']));
  const list = eligible.map(row => ({
    symbol: row.Series === 'BE' ? `${row.Symbol}-BE` : row.Symbol, name: row['Company Name'], isin: row['ISIN Code'], exchange: 'NSE', capGroup: group.id,
  }));
  if (list.length < group.minimum || list.length > 270 || list.some(row => !/^[A-Z0-9&.-]+$/.test(row.symbol) || !/^IN[A-Z0-9]{10}$/.test(row.isin)) || new Set(list.map(row => row.symbol)).size !== list.length) throw new Error(`${group.label}: constituent list is invalid or incomplete`);
  return { list, excluded: rows.filter(row => !eligible.includes(row)).map(row => ({ symbol: row.Symbol, series: row.Series, reason: /^DUM/.test(row['ISIN Code']) ? 'non-tradable index placeholder' : 'non-equity constituent' })) };
}
function createCapUniverse({ fetchCsv = async url => (await axios.get(url, {
  timeout: 15000, responseType: 'text', maxContentLength: 1000000,
  headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.niftyindices.com/' },
})).data, now = Date.now } = {}) {
  const cache = new Map(), inflight = new Map();
  const load = async group => {
    const hit = cache.get(group.id);
    if (hit && now() - hit.fetchedMs < 24 * 60 * 60 * 1000) return hit;
    if (inflight.has(group.id)) return inflight.get(group.id);
    const pending = (async () => {
      const { list, excluded } = parseConstituents(await fetchCsv(urlFor(group)), group);
      const result = { list, excluded, fetchedMs: now(), source: urlFor(group) };
      cache.set(group.id, result);
      return result;
    })().finally(() => inflight.delete(group.id));
    inflight.set(group.id, pending);
    return pending;
  };
  return { async resolve(caps) {
    validateCaps(caps);
    const groups = CAP_GROUPS.filter(group => caps.includes(group.id));
    const results = await Promise.all(groups.map(load));
    const unique = new Map();
    for (const result of results) for (const row of result.list) {
      const key = row.isin || row.symbol;
      if (!unique.has(key)) unique.set(key, { ...row, capGroups: [] });
      unique.get(key).capGroups.push(row.capGroup);
    }
    return { label: groups.map(group => group.label).join(' + '), list: [...unique.values()],
      sources: results.map((result, i) => ({ label: groups[i].label, url: result.source, fetchedAt: new Date(result.fetchedMs).toISOString(), count: result.list.length, excluded: result.excluded })),
    };
  } };
}
module.exports = { CAP_GROUPS, validateCaps, parseConstituents, createCapUniverse };
